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
import { planDelivery, hasUnsafeVerb, DELIVERED } from "../src/lib/deliver-seed.ts";

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
	const parse = (raw) => {
		const at = raw.indexOf("[{");
		const rows = JSON.parse(raw.slice(at === -1 ? 0 : at)).at?.(0)?.results;
		return Array.isArray(rows) ? rows : null;
	};

	// Collections and their fields in one query, because "the collection exists" is
	// not "the collection is finished" — a run interrupted after `schema create` but
	// before its last `add-field` would otherwise be skipped forever.
	const raw = await capture("bash", [
		"-lc",
		'npx wrangler d1 execute asset-hunter --remote --command "SELECT c.slug AS collection, f.slug AS field FROM _emdash_collections c LEFT JOIN _emdash_fields f ON f.collection_id = c.id" --json',
	]);
	let collections = new Set();
	let fields = new Set();
	try {
		const rows = parse(raw);
		if (rows) {
			for (const row of rows) {
				if (typeof row?.collection !== "string") continue;
				collections.add(row.collection);
				if (typeof row?.field === "string") fields.add(`${row.collection}/${row.field}`);
			}
		}
	} catch {
		/* handled by the guard below */
	}

	/*
	 * Existing rows, read from the database rather than the public API.
	 *
	 * The API cannot answer this question. `/api/catalogue.json` publishes one
	 * example per possibility and gives it the *possibility's* slug as its `id`, so
	 * every example looks absent — which is how the first run tried to create 34
	 * examples that already existed, 24 of them under a slug nothing references.
	 * The database has the real slugs, and the database is what is being written to.
	 */
	const slugs = new Set();
	let entriesReachable = false;
	for (const [collection, table] of [
		["possibilities", "ec_possibilities"],
		["examples", "ec_examples"],
		["collections", "ec_collections"],
	]) {
		try {
			for (const row of parse(await capture("bash", [
				"-lc",
				`npx wrangler d1 execute asset-hunter --remote --command "SELECT slug FROM ${table}" --json`,
			])) ?? []) {
				if (typeof row?.slug === "string") slugs.add(`${collection}/${row.slug}`);
			}
			entriesReachable = true;
		} catch {
			/* handled by the guard below */
		}
	}

	return { collections, fields, entries: slugs, entriesReachable };
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
	if (step.kind === "schema") {
		console.log(`    npx emdash ${step.args.join(" ")}`);
	} else {
		const e = step.entry;
		const refs = Object.entries(e.references)
			.map(([k, v]) => `${k} → ${v.join(", ")}`)
			.join("; ");
		console.log(`    POST /_emdash/api/content/${e.collection}  slug=${e.slug}${refs ? `  ${refs}` : ""}`);
	}
}
for (const step of warnings) console.log(`\n  ⚠ ${step.warning}`);
console.log("");

if (!apply) {
	console.log("Dry run. Re-run with --apply (and EMDASH_TOKEN set) to execute.");
	rmSync(scratch, { recursive: true, force: true });
	process.exit(0);
}

/*
 * Paced, and retried once.
 *
 * The first run against production failed at command 39 of 53 with "Invalid or
 * expired token" — a message that is EmDash's *authentication* error, from
 * `handleBearerAuth`, returned whenever `resolveApiToken` yields nothing at all.
 * The token was valid: the same command succeeded immediately afterwards, by hand,
 * and `content list` kept working throughout.
 *
 * So the token was not the problem. Firing ~40 rapid `add-field` calls at D1 means
 * ~40 schema-altering writes plus a `last_used_at` update each, and D1 serialises
 * writes; a contended read resolving to nothing is indistinguishable, to the
 * caller, from a bad token. Every later run failed on its *first* command for the
 * same reason, which is what a rate limit looks like from the outside.
 *
 * Hence pacing, and six attempts at five-second intervals. Reading
 * `resolveApiToken`, the only ways it yields nothing are a missing row, an expired
 * token, or the query itself failing — and `handleBearerAuth` also returns
 * "invalid" when the follow-up `getUserById` yields nothing. So a transient D1 read
 * is reported to the client as an authentication failure, which is EmDash's
 * misleading, not ours, and it is indistinguishable from a revoked token by design:
 * anything else would confirm a token exists.
 *
 * That is why the retry count is generous rather than tidy. A delivery that takes
 * three minutes is a delivery that works, and the resumability above means a command
 * that genuinely fails costs one re-run rather than the whole list.
 */
// `flag` above takes one argument and returns null when absent, so these need their
// own accessor. Passing a fallback to it looked reasonable and silently produced
// `Number(null) === 0`: no delay, and an attempt loop that never ran, which failed
// on the first command with no output and no retry — the exact symptom that sent
// me looking for a rate limit that was not there.
const numericFlag = (name, fallback) => {
	const at = argv.indexOf(name);
	if (at === -1) return fallback;
	const value = Number(argv[at + 1]);
	if (!Number.isFinite(value) || value < 1) {
		console.error(`${name} must be a positive number`);
		process.exit(2);
	}
	return value;
};
const DELAY_MS = numericFlag("--delay", 1000);
const ATTEMPTS = numericFlag("--attempts", 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One command, with its output captured rather than inherited.
 *
 * Inheriting looked right and was actively harmful: a failing step produced a bare
 * "exit 1" with no output at all, because the failure was in `npx` itself and
 * nothing was reaching the log. Three runs failed on the same command and the log
 * could not say why, which sent the investigation after a rate limit that did not
 * exist. A delivery that cannot explain its own failure is not auditable.
 */
const runStep = (step) =>
	new Promise((resolve) => {
		const child = spawn("npx", ["emdash", ...step.args]);
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		child.on("close", (code) => resolve({ code: code ?? 1, out: out.trim() }));
		child.on("error", (e) => resolve({ code: 1, out: String(e) }));
	});

/**
 * A content row, over the API rather than the CLI.
 *
 * `emdash content create --file` takes the `data` bag and nothing else, so it
 * cannot express a relation: the API refuses a `data` payload that sets a field
 * bound to a relation, and the CLI has no way to pass a `references` bag because a
 * `references` key inside its file is rejected as an unknown field. Every example
 * has a `possibility` relation, so every example needs this path.
 *
 * `references` values are arrays — a scalar is rejected as "expected array" — and
 * the row lands as a draft, so publishing is a second request the seed's own
 * `status` decides.
 */
async function createEntry(entry, token) {
	const headers = {
		"content-type": "application/json",
		"X-EmDash-Request": "1",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
	const post = async (path, body) => {
		const res = await fetch(`${url}${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		const text = await res.text();
		return { ok: res.ok, status: res.status, text };
	};

	const created = await post(`/_emdash/api/content/${entry.collection}`, {
		slug: entry.slug,
		data: entry.data,
		references: entry.references,
	});
	if (!created.ok) return { code: 1, out: `POST ${created.status} ${created.text.slice(0, 400)}` };
	if (!entry.publish) return { code: 0, out: "created (draft)" };

	const path = `/_emdash/api/content/${entry.collection}/${entry.slug}/publish`;
	const res = await fetch(`${url}${path}`, { method: "POST", headers });
	if (!res.ok) return { code: 1, out: `publish ${res.status} ${(await res.text()).slice(0, 300)}` };
	return { code: 0, out: "created and published" };
}

let failed = 0;
for (const [index, step] of commands.entries()) {
	if (index > 0 && DELAY_MS > 0) await sleep(DELAY_MS);
	let result = { code: 1, out: "" };
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		result = step.kind === "content" ? await createEntry(step.entry, token) : await runStep(step);
		if (result.code === 0) break;
		if (attempt < ATTEMPTS) {
			console.error(
				`  … ${step.what} failed (exit ${result.code}), retry ${attempt}/${ATTEMPTS - 1}` +
					(result.out ? `\n      ${result.out.split("\n").slice(-3).join("\n      ")}` : " (no output)"),
			);
			await sleep(attempt * 5000);
		}
	}
	if (result.code === 0) {
		console.log(`  ✔ ${step.what}`);
		continue;
	}
	failed++;
	console.error(`\n✖ failed: ${step.what} (exit ${result.code}) — stopping. Nothing further was run.`);
	if (result.out) console.error(`\n  ${result.out}`);
	break;
}
rmSync(scratch, { recursive: true, force: true });
console.log("");
console.log(
	failed
		? "Stopped early. `npm run deploy:parity` shows what is still missing."
		: "Done. Verify with `npm run deploy:parity`.",
);
process.exit(failed ? 1 : 0);
