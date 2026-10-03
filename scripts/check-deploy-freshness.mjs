#!/usr/bin/env node
/**
 * Is the deployed site the code this branch claims? (#81)
 *
 * Issue #81 found `assets.loftwah.com` serving code from three commits behind
 * `main`, with nine accessibility defects live in production and every one of
 * them already fixed on `main`. Nothing said the deploy was stale; discovering it
 * took an audit of the live site, which is the most expensive possible way to
 * find out. So the question is now asked by the product — every page carries
 * `<meta name="asset-hunter:commit">` and a footer line, and `GET /api/version.json`
 * answers it in ~200 bytes.
 *
 * This script does only the I/O. The verdict is `assessFreshness` in
 * `src/lib/deploy-freshness.ts`, which is a pure function and is tested as one —
 * including the verdicts that are awkward to produce on purpose.
 *
 * Exits non-zero for anything other than `current`, **including `unknown`**. An
 * unverifiable deploy is the situation #81 is about, and reporting it as green
 * would be the same mistake one level up. `--allow-unknown` exists for the case
 * where that is genuinely the right answer; nothing passes by accident.
 *
 * Usage:
 *   node scripts/check-deploy-freshness.mjs [--url https://assets.loftwah.com]
 *   node scripts/check-deploy-freshness.mjs --url … --expect <sha>   # deploy gate
 *   node scripts/check-deploy-freshness.mjs --url … --allow-unknown
 */
import { execFileSync } from "node:child_process";
import { assessFreshness, isFailure, provenanceWarnings } from "../src/lib/deploy-freshness.ts";

const argv = process.argv.slice(2);
const flag = (name) => {
	const at = argv.indexOf(name);
	return at === -1 ? null : (argv[at + 1] ?? null);
};
const has = (name) => argv.includes(name);

const url = (flag("--url") ?? process.env.AH_URL ?? "https://assets.loftwah.com").replace(/\/$/, "");
const allowUnknown = has("--allow-unknown");

/** Fails loudly rather than guessing: a wrong `HEAD` produces a wrong verdict. */
function localHead() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		process.stderr.write("✖ cannot read HEAD — run this from inside the repository\n");
		process.exit(2);
	}
}

const expected = flag("--expect") ?? localHead();

/** Git as the oracle the pure verdict asks questions of. */
const history = {
	isAncestor(older, newer) {
		try {
			execFileSync("git", ["merge-base", "--is-ancestor", older, newer], { stdio: "ignore" });
			return true;
		} catch (error) {
			// Exit 1 is "not an ancestor". Anything else — a shallow clone missing
			// the commit — is *not* evidence either way, and guessing here would
			// attach a scary remedy to a guess.
			return error?.status === 1 ? false : null;
		}
	},
	has(commit) {
		try {
			execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	},
};

/** Read what the deployed build says about itself. Never throws. */
async function readDeployed() {
	try {
		const res = await fetch(`${url}/api/version.json`, {
			headers: { accept: "application/json" },
			// Never accept a cached body. A stale answer from a CDN is
			// indistinguishable from a stale deploy, and telling them apart is the
			// entire purpose of this tool.
			cache: "no-store",
		});
		if (!res.ok) return { reachable: false, commit: null, dirty: null, builtAt: null };
		const body = await res.json();
		return {
			reachable: true,
			commit: typeof body?.commit === "string" ? body.commit : null,
			dirty: typeof body?.dirty === "boolean" ? body.dirty : null,
			builtAt: typeof body?.builtAt === "string" ? body.builtAt : null,
		};
	} catch {
		return { reachable: false, commit: null, dirty: null, builtAt: null };
	}
}

const deployed = await readDeployed();
const verdict = assessFreshness(deployed, expected, history);

console.log(`Deploy freshness — ${url}`);
console.log(`  local HEAD   ${expected}`);
console.log(
	`  deployed     ${deployed.commit ?? "unknown"}  ${deployed.builtAt ? `built ${deployed.builtAt}` : ""}`,
);
for (const warning of provenanceWarnings(deployed)) console.log(`  ⚠ ${warning}`);

if (verdict.kind === "current") {
	console.log(`\n✔ ${verdict.summary}`);
	process.exit(0);
}

console.error(`\n✖ ${verdict.summary}`);
if (verdict.remedy) console.error(`  ${verdict.remedy}`);

// A count and a file count turn "behind" into something actionable: two merges
// behind is one commit behind by count and twenty files behind by content, and
// it is the content that readers get.
if (verdict.kind === "behind" && history.has(deployed.commit ?? "")) {
	const commits = execFileSync("git", ["rev-list", "--count", `${deployed.commit}..${expected}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	const files = execFileSync("git", ["diff", "--name-only", `${deployed.commit}..${expected}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	const count = files ? files.split("\n").length : 0;
	console.error(`  ${commits} commit${commits === "1" ? "" : "s"}, ${count} file${count === "1" ? "" : "s"} differ.`);
}

process.exit(allowUnknown && verdict.kind === "unknown" ? 0 : isFailure(verdict) ? 1 : 0);
