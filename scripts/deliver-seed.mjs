#!/usr/bin/env node
/**
 * Print — and with `--apply`, run — the creates that bring the deployed database
 * up to what this repository seeds.
 *
 * This exists because the gap it closes is invisible from inside the repository.
 * Ten entries and three collections were merged, gated, deployed and green in
 * production, and the only way anyone found out was reading the live database
 * against the seed by hand. Doing that by hand against production is how a list
 * gets one entry wrong, so the list is built in `src/lib/deliver-seed.ts` — a pure
 * function, tested as one — and this file only reads the world and prints or runs
 * the result.
 *
 * **Dry-run by default.** It prints every command and exits 0. `--apply` runs
 * them. That is not caution for its own sake: the point is that the write requires
 * a person to type `--apply` while looking at the list.
 *
 * Usage:
 *   node scripts/deliver-seed.mjs                                   # print
 *   node scripts/deliver-seed.mjs --apply                           # run them
 *   node scripts/deliver-seed.mjs --url https://assets.loftwah.com --apply
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planDelivery, hasUnsafeVerb, PUBLISHED, placeholderId } from "../src/lib/deliver-seed.ts";

const argv = process.argv.slice(2);
const flag = (name) => {
	const at = argv.indexOf(name);
	return at === -1 ? null : (argv[at + 1] ?? null);
};
const has = (name) => argv.includes(name);

const apply = has("--apply");
const url = (flag("--url") ?? process.env.AH_URL ?? "https://assets.loftwah.com").replace(/\/$/, "");
const seedPath = flag("--seed") ?? "seed/seed.json";

const token = process.env.EMDASH_TOKEN ?? null;
if (apply && !token) {
	console.error(
		"EMDASH_TOKEN is not set. Every command here writes to the live database.\n" +
			"Re-run without --apply to see the list.",
	);
	process.exit(2);
}

const seed = JSON.parse(readFileSync(seedPath, "utf8"));

function capture(cmd, args) {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", () => {});
		child.on("close", () => resolve(out));
		child.on("error", () => resolve(""));
	});
}

/** What the deployed database already has, so nothing is created twice. */
async function readLive() {
	const raw = await capture("bash", [
		"-lc",
		'npx wrangler d1 execute asset-hunter --remote --command "SELECT slug FROM _emdash_collections" --json',
	]);
	let collections = new Set();
	try {
		const at = raw.indexOf("[{");
		const rows = JSON.parse(raw.slice(at === -1 ? 0 : at)).at?.(0)?.results;
		if (Array.isArray(rows)) {
			collections = new Set(rows.map((r) => r?.slug).filter((s) => typeof s === "string"));
		}
	} catch {
		/* handled by the guard below */
	}

	const entries = new Set();
	let entriesReachable = false;
	try {
		const res = await fetch(`${url}/api/catalogue.json?fresh=1`);
		if (res.ok) {
			const body = await res.json();
			for (const c of PUBLISHED) {
				for (const row of Array.isArray(body?.[c]) ? body[c] : []) {
					if (typeof row?.id === "string") entries.add(row.id);
				}
			}
			entriesReachable = true;
		}
	} catch {
		/* handled by the guard below */
	}

	return { collections, entries, entriesReachable };
}

const live = await readLive();
if (live.collections.size === 0 || !live.entriesReachable) {
	console.error(
		"Could not read the deployed database, so this cannot tell what is already there.\n" +
			"Refusing to guess: a create for something that already exists errors, and\n" +
			"guessing wrong against production is worse than not running.",
	);
	process.exit(2);
}

const scratch = join(tmpdir(), `deliver-seed-${process.pid}`);
const auth = token ? ["-u", url, "-t", token] : ["-u", url];
let steps = planDelivery(seed, live);

// The pure plan names each row's data by placeholder; the real command needs a file.
mkdirSync(scratch, { recursive: true });
steps = steps.map((step) => {
	const id = placeholderId(step.args);
	if (id === null) return step;
	const collection = step.args[2];
	const row = (Array.isArray(seed.content?.[collection]) ? seed.content[collection] : []).find(
		(r) => r?.id === id,
	);
	const file = join(scratch, `${collection}-${id}.json`);
	writeFileSync(file, JSON.stringify(row?.data ?? {}, null, "\t"));
	return { ...step, args: [...step.args.slice(0, -1), file, ...auth] };
});

if (hasUnsafeVerb(steps)) {
	console.error("Refusing to run: the plan contains a verb that is not a create.");
	rmSync(scratch, { recursive: true, force: true });
	process.exit(2);
}

const warnings = steps.filter((s) => s.warning);
const commands = steps.filter((s) => !s.warning);

if (commands.length === 0) {
	console.log(`Nothing to deliver — ${url} already holds what ${seedPath} seeds.`);
	rmSync(scratch, { recursive: true, force: true });
	process.exit(0);
}

console.log(`Deliver seed — ${apply ? "APPLYING" : "dry run"} against ${url}`);
console.log(`  ${commands.length} create(s); nothing here updates, deletes or overwrites`);
console.log("");
for (const step of commands) {
	console.log(`  ${step.what}`);
	console.log(`    npx emdash ${step.args.join(" ")}`);
}
for (const step of warnings) console.log(`\n  ⚠ ${step.warning}`);
console.log("");

if (!apply) {
	console.log("Dry run. Re-run with --apply (and EMDASH_TOKEN set) to execute.");
	rmSync(scratch, { recursive: true, force: true });
	process.exit(0);
}

let failed = 0;
for (const step of commands) {
	const code = await new Promise((resolve) => {
		const child = spawn("npx", ["emdash", ...step.args], { stdio: "inherit" });
		child.on("close", resolve);
	});
	if (code !== 0) {
		failed++;
		console.error(`\n✖ failed: ${step.what} (exit ${code}) — stopping. Nothing further was run.`);
		break;
	}
}
rmSync(scratch, { recursive: true, force: true });
console.log("");
console.log(
	failed
		? "Stopped early. `npm run deploy:parity` shows what is still missing."
		: "Done. Verify with `npm run deploy:parity`.",
);
process.exit(failed ? 1 : 0);
