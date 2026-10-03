#!/usr/bin/env node
/**
 * Does the deployed database hold the schema and content this repository
 * declares?
 *
 * `check-deploy-freshness` answers "is production running this code?" and the
 * answer was yes — correctly, at the current commit, with 22/22 smoke checks —
 * while production was missing ten seeded entries and the `disputes`,
 * `exclusions` and `audit_events` collections. The takedown workflow (#54) was
 * deployed and could not run, because it writes to tables that were not there.
 *
 * Code ships with `wrangler deploy`. Schema and rows do not: they are written by
 * a seed applied once, to a database, by a command nobody has run since. This
 * script asks the question nothing asked.
 *
 * The verdict is `assessDeployParity` in `src/lib/deploy-parity.ts`, which is a
 * pure function and is tested as one. This file does only I/O.
 *
 * Two probes, because the two axes are only visible two ways:
 * - entries, from `/api/catalogue.json` — what the site serves;
 * - collections, from `SELECT slug FROM _emdash_collections` — what the database
 *   can actually write to. There is no public route for this, and that absence
 *   is the bug: a reader cannot see it either.
 *
 * If the wrangler probe cannot run — no auth, no wrangler, offline — the verdict
 * is `unknown`, and `unknown` exits non-zero. An absence of evidence is not a
 * claim, and a gate that reports "cannot tell" as green is the mistake one level
 * up from the one it exists to catch.
 *
 * `--content-only` skips the schema axis for a fast check, and is honest about
 * what it gave up: it exits non-zero with a notice, because a partial green is
 * how this defect survived in the first place.
 *
 * Usage:
 *   node scripts/check-deploy-parity.mjs [--url https://assets.loftwah.com]
 *   node scripts/check-deploy-parity.mjs --seed seed/seed.json
 *   node scripts/check-deploy-parity.mjs --content-only
 */
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assessDeployParity, isParityFailure } from "../src/lib/deploy-parity.ts";

const run = promisify(execFile);

const argv = process.argv.slice(2);
const flag = (name) => {
	const at = argv.indexOf(name);
	return at === -1 ? null : (argv[at + 1] ?? null);
};
const has = (name) => argv.includes(name);

const url = (flag("--url") ?? process.env.AH_URL ?? "https://assets.loftwah.com").replace(
	/\/$/,
	"",
);
const seedPath = flag("--seed") ?? "seed/seed.json";
const d1Name = flag("--d1") ?? "asset-hunter";
const contentOnly = has("--content-only");

/**
 * The collections whose entries are compared, and why this list is explicit.
 *
 * `/api/catalogue.json` publishes `possibilities` and `collections` at the top
 * level; examples arrive *nested* inside each possibility. The first draft of this
 * script unioned *every* seeded collection against the top-level arrays and
 * cheerfully reported "47 seeded entries missing" when ten were. A gate that cries
 * wolf about rows it was never able to look at trains people to ignore it, and this
 * one exists because nobody was looking.
 *
 * So both sides come from one list, which makes them incapable of drifting apart,
 * and the live side is read from where each collection actually appears.
 *
 * `examples` is deliberately **not** in this list, and that is a different decision
 * from the one that caused the defect. It was first excluded for the wrong reason —
 * "a missing possibility already accounts for them" — which is true of the count
 * and useless for detection, and it shipped ten possibilities with no examples while
 * `deliver:seed` shared the same blind spot and the gate reported `aligned`.
 *
 * It is now excluded for the right one: the ids are **not comparable**.
 * `/api/catalogue.json` publishes one example per possibility — the representative —
 * and gives it the *possibility's* slug as its `id`, while `seed.json` stores
 * examples as their own rows keyed `ex-<slug>`. Comparing `ex-crowd-fluid` against a
 * response that can only ever say `crowd-fluid` reports 34 false failures, and a
 * gate that does that is ignored.
 *
 * So examples are compared as a **pairing** instead — see
 * `seedPossessionsWithExamples` below. That is precise, it is what actually broke,
 * and it cannot produce a phantom. A defect is worth a special case; it is not worth
 * a comparison that cannot succeed.
 *
 * `pages` stays out for the original reason: the endpoint does not publish it, so
 * its parity belongs to the admin rather than to a public gate.
 */
const PUBLISHED = ["possibilities", "collections"];

/** Entry ids and collection slugs, as the seed declares them. */
function readSeed() {
	const seed = JSON.parse(readFileSync(seedPath, "utf8"));
	const entries = seed?.content;
	if (typeof entries !== "object" || entries === null) {
		throw new Error(`${seedPath} has no content object`);
	}
	const seedEntries = new Set();
	for (const collection of PUBLISHED) {
		const rows = entries[collection];
		if (!Array.isArray(rows)) throw new Error(`${seedPath}: content.${collection} is not an array`);
		for (const row of rows) {
			if (typeof row?.id === "string") seedEntries.add(row.id);
			else throw new Error(`${seedPath}: a ${collection} row has no string id`);
		}
	}
	// The pairing the seed promises: an example row names its possibility with
	// `$ref:<slug>`, which is how a possibility is known to be given a specimen.
	const seedPossessionsWithExamples = new Set();
	for (const row of entries.examples ?? []) {
		const ref = row?.data?.possibility;
		if (typeof ref === "string" && ref.startsWith("$ref:")) {
			seedPossessionsWithExamples.add(ref.slice("$ref:".length));
		}
	}

	const seedCollections = new Set();
	for (const collection of seed?.collections ?? []) {
		if (typeof collection?.slug === "string") seedCollections.add(collection.slug);
		else throw new Error(`${seedPath}: a collection has no string slug`);
	}
	return { seedEntries, seedCollections, seedPossessionsWithExamples };
}

/**
 * The entry ids production serves, over exactly {@link PUBLISHED}.
 *
 * Anything unreachable reports `reachable: false` rather than an empty set — the
 * difference between "nothing arrived" and "I could not look", which are not the
 * same claim, and conflating them is how a gate ends up reporting 38 missing
 * entries because a DNS lookup failed.
 */
async function readLiveEntries() {
	try {
		const res = await fetch(`${url}/api/catalogue.json?fresh=1`);
		if (!res.ok) return { liveEntries: new Set(), possessionsWithExamples: new Set(), entriesReachable: false };
		const body = await res.json();
		const rows = PUBLISHED.flatMap((collection) =>
			Array.isArray(body?.[collection]) ? body[collection] : [],
		);
		// `/api/catalogue.json` publishes one example per possibility — the
		// representative — and gives it the *possibility's* slug as its `id`, so
		// example ids cannot be compared with the seed's `ex-<slug>` rows. What is
		// comparable is the pairing, so that is what is collected.
		const withExamples = new Set();
		for (const possibility of Array.isArray(body?.possibilities) ? body.possibilities : []) {
			const nested = Array.isArray(possibility?.examples) ? possibility.examples : [];
			if (nested.length > 0 && typeof possibility?.id === "string") {
				withExamples.add(possibility.id);
			}
		}
		return {
			liveEntries: new Set(rows.map((r) => r?.id).filter((id) => typeof id === "string")),
			possessionsWithExamples: withExamples,
			entriesReachable: true,
		};
	} catch {
		return { liveEntries: new Set(), possessionsWithExamples: new Set(), entriesReachable: false };
	}
}

/**
 * The collection slugs the database has.
 *
 * The only honest way to ask. A missing table cannot be inferred from a working
 * page, which is the entire reason #54 looked healthy.
 */
async function readLiveCollections(seedCollections) {
	try {
		const { stdout } = await run(
			"npx",
			[
				"wrangler",
				"d1",
				"execute",
				d1Name,
				"--remote",
				"--command",
				"SELECT slug FROM _emdash_collections",
				"--json",
			],
			{ maxBuffer: 8 * 1024 * 1024 },
		);
		const parsed = JSON.parse(stdout);
		const rows = parsed?.[0]?.results;
		if (!Array.isArray(rows)) throw new Error("no results array");
		return {
			liveCollections: new Set(rows.map((r) => r?.slug).filter((s) => typeof s === "string")),
			collectionsReachable: true,
		};
	} catch {
		return { liveCollections: new Set(), collectionsReachable: false };
	}
}

const { seedEntries, seedCollections, seedPossessionsWithExamples } = readSeed();
const { liveEntries, possessionsWithExamples, entriesReachable } = await readLiveEntries();

let liveCollections = new Set();
let collectionsReachable = false;
let schemaNote = null;

if (contentOnly) {
	schemaNote = "skipped (--content-only): a missing collection is a feature that cannot run, and this run did not look";
} else {
	const probe = await readLiveCollections(seedCollections);
	liveCollections = probe.liveCollections;
	collectionsReachable = probe.collectionsReachable;
	if (!collectionsReachable) {
		schemaNote =
			"could not be read — wrangler is unauthenticated or the D1 database is unreachable, so a missing collection would be invisible to this run";
	}
}

const verdict = assessDeployParity({
	reachable: entriesReachable && (contentOnly || collectionsReachable),
	seedEntries,
	liveEntries,
	seedCollections,
	liveCollections,
	seedPossessionsWithExamples,
	livePossessionsWithExamples: possessionsWithExamples,
});

console.log(`Deploy parity — ${url}`);
console.log(
	`  entries      seeded ${seedEntries.size}   served ${liveEntries.size}` +
		(contentOnly ? "   (collections not checked)" : `   collections seeded ${seedCollections.size}   held ${liveCollections.size}`),
);
console.log("");
console.log(`${verdict.kind === "aligned" ? "✔" : "✖"} ${verdict.summary}`);

const extras = [
	...verdict.extraCollections.map((slug) => `collection ${slug}`),
	...verdict.extraEntries.map((id) => `entry ${id}`),
];
if (extras.length) {
	console.log("");
	console.log(`  held here, not in the seed (${extras.length}) — not a failure; expected from a promoted draft or a plugin:`);
	for (const line of extras.slice(0, 12)) console.log(`    · ${line}`);
	if (extras.length > 12) console.log(`    …and ${extras.length - 12} more`);
}

if (schemaNote) {
	console.log("");
	console.log(`  ⚠ schema axis ${schemaNote}`);
}
if (verdict.remedy) {
	console.log("");
	console.log(`  → ${verdict.remedy}`);
}

process.exit(isParityFailure(verdict.kind) ? 1 : 0);
