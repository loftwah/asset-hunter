#!/usr/bin/env node
/**
 * Syncs the vendored EmDash agent skills from upstream.
 *
 * The guidance is committed to the repository so a fresh agent session always
 * has it available offline, and pinned to a revision so behaviour is
 * reproducible. Provenance matters more than convenience here: a skill copied
 * once and never refreshed is worse than no skill, because it looks current.
 *
 * Each vendored skill carries an UPSTREAM_REVISION file. This script rewrites
 * them and reports what moved.
 *
 * Usage:
 *   node scripts/sync-emdash-skills.mjs           # sync
 *   node scripts/sync-emdash-skills.mjs --check   # fail if stale
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const UPSTREAM = "emdash-cms/emdash";
const SKILLS = ["building-emdash-site", "emdash-cli", "creating-plugins"];
const destRoot = new URL("../.agents/skills/", import.meta.url).pathname;
const checkOnly = process.argv.includes("--check");

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Fetches repo contents as structured JSON.
 *
 * Deliberately not using `--jq` with interpolation: a shell-style `\(` in a jq
 * filter is eaten by the JS string layer before gh ever sees it, which yields
 * a plausible-looking but useless result rather than an error.
 */
function ghContents(repoPath) {
	return JSON.parse(gh(["api", `repos/${UPSTREAM}/contents/${repoPath}`]));
}

/**
 * Recursively lists every file under a repo path. The GitHub contents API is
 * one level at a time, so directories are walked explicitly — a flat listing
 * would silently miss `references/` and report every reference doc as a local
 * orphan.
 */
function listFiles(repoPath, seen = []) {
	let entries;
	try {
		entries = ghContents(repoPath);
	} catch {
		return seen;
	}
	if (!Array.isArray(entries)) return seen;
	for (const entry of entries) {
		if (entry.type === "file") seen.push(entry.path);
		else if (entry.type === "dir") listFiles(entry.path, seen);
	}
	return seen;
}

/** Decodes a base64 content blob from the contents API. */
function ghFile(repoPath) {
	const data = JSON.parse(gh(["api", `repos/${UPSTREAM}/contents/${repoPath}`]));
	return Buffer.from(data.content, "base64").toString("utf8");
}

let revision;
try {
	revision = JSON.parse(gh(["api", `repos/${UPSTREAM}/commits/main`])).sha.trim();
} catch (err) {
	console.error("✖ could not reach GitHub to resolve the upstream revision.");
	console.error(`  ${err.message.split("\n")[0]}`);
	console.error("  The vendored skills are unchanged and remain usable offline.");
	process.exit(2);
}

const written = [];
const unchanged = [];
const stale = [];

for (const skill of SKILLS) {
	const dir = `${destRoot}${skill}`;
	const files = listFiles(`skills/${skill}`);

	for (const upstreamPath of files) {
		const relative = upstreamPath.replace(`skills/${skill}/`, "");
		const dest = `${dir}/${relative}`;
		const decoded = ghFile(upstreamPath);

		const exists = existsSync(dest);
		if (exists && readFileSync(dest, "utf8") === decoded) {
			unchanged.push(`${skill}/${relative}`);
			continue;
		}
		if (exists) stale.push(`${skill}/${relative}`);
		if (!checkOnly) {
			mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
			writeFileSync(dest, decoded);
		}
		written.push(`${skill}/${relative}`);
	}

	const revFile = `${dir}/UPSTREAM_REVISION`;
	const current = existsSync(revFile) ? readFileSync(revFile, "utf8").trim() : null;
	if (current !== revision && !checkOnly) writeFileSync(revFile, `${revision}\n`);
}

// Report files present locally but no longer upstream, so deletions are visible
// rather than silently inherited.
const orphans = [];
for (const skill of SKILLS) {
	const dir = `${destRoot}${skill}`;
	if (!existsSync(dir)) continue;
	const upstream = new Set(listFiles(`skills/${skill}`));
	const walk = (path, prefix = "") => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const rel = `${prefix}${entry.name}`;
			if (entry.isDirectory()) walk(`${path}/${entry.name}`, `${rel}/`);
			else if (!upstream.has(`skills/${skill}/${rel}`)) orphans.push(`${skill}/${rel}`);
		}
	};
	walk(dir);
}

console.log(`EmDash skills — upstream ${revision.slice(0, 10)}`);
console.log(`  ${unchanged.length} unchanged`);
console.log(`  ${stale.length} updated`);
console.log(`  ${written.length} ${checkOnly ? "would be added" : "added"}`);
if (orphans.length) {
	console.log(`  ${orphans.length} local-only file(s) not in upstream: ${orphans.join(", ")}`);
	console.log("    (UPSTREAM_REVISION is expected to appear here)");
}

if (checkOnly && (stale.length > 0 || written.length > 0)) {
	console.error("\n✖ vendored skills are stale — run: npm run skills:sync");
	process.exit(1);
}
console.log(checkOnly ? "\n✔ vendored skills are current" : "\n✔ vendored skills synced");
