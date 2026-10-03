/**
 * The deployed database must hold the schema and content this repository declares.
 *
 * `assets.loftwah.com` was running the current commit and passing 22/22 smoke
 * checks while missing ten seeded entries **and** the `disputes`, `exclusions`
 * and `audit_events` collections. The rights-correction workflow (#54) was
 * deployed, gated, tested and green, and could not run, because every write in it
 * addresses a collection the live database does not have.
 *
 * Nothing caught it because nothing asked. Freshness proved the code shipped;
 * `seed:check` proved the seed was reproducible; `check:specimens` proved each
 * entry had a plate. Every one of those is about an artefact. None is about
 * whether the artefact arrived — schema and rows travel a different path from
 * code, written by a seed applied once by a command nobody has run since.
 *
 * `assessDeployParity` is pure and is tested as one. Three properties earn their
 * assertions here, and each exists because getting it wrong would have made this
 * gate worse than no gate:
 *
 * 1. A missing **collection** fails, and is named ahead of missing entries — it is
 *    a feature that cannot execute, and it is invisible to a reader.
 * 2. An **extra** never fails — it is usually a promoted draft or a plugin, and a
 *    gate that failed on it would push somebody towards the destructive re-seed.
 * 3. **Unknown fails**, and unknown must not be reported as "everything is
 *    missing". The first draft of the script unioned every seeded collection
 *    against a public endpoint that publishes two of them, and reported 47 missing
 *    entries when ten were. A gate that invents findings gets ignored.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assessDeployParity, isParityFailure } from "../src/lib/deploy-parity.ts";

const set = (...names: string[]) => new Set(names);

const parity = (over: Partial<Parameters<typeof assessDeployParity>[0]> = {}) => ({
	reachable: true,
	seedEntries: set("p1", "p2"),
	liveEntries: set("p1", "p2"),
	seedCollections: set("possibilities", "examples"),
	liveCollections: set("possibilities", "examples"),
	...over,
});

describe("a database that holds the schema and content it seeds", () => {
	test("is aligned and does not fail", () => {
		const verdict = assessDeployParity(parity());
		assert.equal(verdict.kind, "aligned");
		assert.equal(isParityFailure(verdict.kind), false);
		assert.equal(verdict.remedy, null);
		assert.match(verdict.summary, /all 2 seeded entries across all 2 collections/);
	});

	test("is aligned even when production holds extra things", () => {
		// A hunt published a draft, a curator promoted it, a plugin added a
		// collection. None of that is a fault, and the run must still pass.
		const verdict = assessDeployParity(
			parity({
				liveEntries: set("p1", "p2", "promoted-by-a-human"),
				liveCollections: set("possibilities", "examples", "plugin_widgets"),
			}),
		);
		assert.equal(verdict.kind, "aligned");
		assert.equal(isParityFailure(verdict.kind), false);
		assert.deepEqual(verdict.extraEntries, ["promoted-by-a-human"]);
		assert.deepEqual(verdict.extraCollections, ["plugin_widgets"]);
		assert.equal(verdict.remedy, null, "nothing to remedy, so nothing to suggest");
	});
});

describe("a collection the database does not have", () => {
	const drifted = () =>
		assessDeployParity(
			parity({
				seedCollections: set("possibilities", "examples", "disputes", "exclusions", "audit_events"),
				liveCollections: set("possibilities", "examples"),
			}),
		);

	test("is a failure, because a feature cannot execute without it", () => {
		/*
		 * This is the #54 case, and it is the whole reason the schema axis exists.
		 *
		 * The deployed code contained a complete rights-correction workflow whose
		 * writes addressed tables that were not there. Every page rendered, every
		 * smoke check passed, and the feature was inoperable. A gate that only
		 * counted entries would have reported this deployment as healthy.
		 */
		const verdict = drifted();
		assert.equal(verdict.kind, "drifted");
		assert.equal(isParityFailure(verdict.kind), true);
		assert.deepEqual(verdict.missingCollections, [
			"audit_events",
			"disputes",
			"exclusions",
		]);
	});

	test("is named ahead of missing entries in the summary", () => {
		// The summary is one line and somebody has to act on it. A missing entry is
		// invisible content; a missing collection is broken code. The worse finding
		// leads, or the reader stops at the one they already knew about.
		const verdict = assessDeployParity(
			parity({
				seedEntries: set("p1", "p2"),
				liveEntries: set("p1"),
				seedCollections: set("possibilities", "disputes"),
				liveCollections: set("possibilities"),
			}),
		);
		assert.equal(verdict.kind, "drifted");
		assert.match(verdict.summary, /^the deployed database is missing 1 collection/);
		assert.match(verdict.summary, /disputes/);
		assert.match(verdict.summary, /does not serve 1 seeded entry\b/);
		assert.match(verdict.summary, /cannot run/);
		assert.deepEqual(verdict.missingEntries, ["p2"]);
	});

	test("says a collection is missing on its own, with no entries missing", () => {
		// The real production state: schema behind, content complete. The message
		// must not imply entries are missing when they are not.
		const verdict = drifted();
		assert.deepEqual(verdict.missingEntries, []);
		assert.doesNotMatch(verdict.summary, /seeded entr/);
	});

	test("uses the singular for one collection and the plural for several", () => {
		const one = assessDeployParity(
			parity({ seedCollections: set("possibilities", "disputes"), liveCollections: set("possibilities") }),
		);
		assert.match(one.summary, /missing 1 collection \(disputes\), so the code paths that write to it cannot run/);
		const many = drifted();
		assert.match(many.summary, /missing 3 collections/);
		assert.match(many.summary, /write to them cannot run/);
	});
});

describe("a seeded entry that never arrived", () => {
	const drifted = () =>
		assessDeployParity(parity({ seedEntries: set("p1", "p2", "monoline-constant-weight"), liveEntries: set("p1") }));

	test("is a failure that names the entry, not merely that something is wrong", () => {
		const verdict = drifted();
		assert.equal(verdict.kind, "drifted");
		assert.equal(isParityFailure(verdict.kind), true);
		assert.deepEqual(verdict.missingEntries, ["monoline-constant-weight", "p2"]);
		assert.match(verdict.summary, /monoline-constant-weight/);
	});

	test("names delivery and never an update as the remedy", () => {
		/*
		 * The one sentence in this file that could destroy somebody's work, so it is
		 * asserted rather than trusted.
		 *
		 * `--on-conflict=update` would bring the missing rows in *and* overwrite every
		 * editorial change made since the last seed — the opposite of what somebody who
		 * ran a command described as "applying a seed" expects. Delivery is creates
		 * and POSTs, which cannot overwrite, so it is what gets named.
		 */
		const verdict = drifted();
		const remedy = verdict.remedy ?? "";
		assert.match(remedy, /deliver:seed --apply/);
		// The update flag may be *named*, but only to be forbidden — so the assertion
		// is order-aware. A plain `doesNotMatch` passes or fails on word order rather
		// than on meaning, which is how "never do X" gets rejected for containing X.
		const at = remedy.indexOf("--on-conflict=update");
		if (at >= 0) {
			assert.match(remedy.slice(0, at), /Never\b/, "an update may only be named to be forbidden");
		}
	});

	test("one missing entry is still a failure", () => {
		// It is a merged, gated entry nobody can see. There is no threshold at which
		// invisible content becomes acceptable.
		const verdict = assessDeployParity(parity({ seedEntries: set("p1", "p2"), liveEntries: set("p1") }));
		assert.equal(isParityFailure(verdict.kind), true);
		assert.deepEqual(verdict.missingEntries, ["p2"]);
	});

	test("a collection gap does not hide an entry gap, or the reverse", () => {
		const verdict = assessDeployParity(
			parity({
				seedEntries: set("p1", "p2"),
				liveEntries: set("p1"),
				seedCollections: set("possibilities", "disputes"),
				liveCollections: set("possibilities"),
			}),
		);
		assert.deepEqual(verdict.missingEntries, ["p2"]);
		assert.deepEqual(verdict.missingCollections, ["disputes"]);
	});
});

describe("a database that could not be read", () => {
	test("is unknown, and unknown is a failure", () => {
		// Same rule as `assessFreshness`: an absence of evidence is not a claim.
		// Reporting "cannot tell" as green is the mistake one level up.
		const verdict = assessDeployParity(parity({ reachable: false }));
		assert.equal(verdict.kind, "unknown");
		assert.equal(isParityFailure(verdict.kind), true);
		assert.match(verdict.summary, /unknown/i);
	});

	test("does not report everything as missing", () => {
		/*
		 * The trap this module's script actually fell into.
		 *
		 * An unreachable endpoint must not print "38 seeded entries are missing".
		 * It is wrong, and alarming enough to send somebody into a production
		 * database — which is how a check designed to prevent damage causes it.
		 */
		const verdict = assessDeployParity(
			parity({
				reachable: false,
				seedEntries: set("a", "b", "c"),
				seedCollections: set("possibilities", "disputes"),
			}),
		);
		assert.deepEqual(verdict.missingEntries, []);
		assert.deepEqual(verdict.missingCollections, []);
		assert.deepEqual(verdict.extraEntries, []);
		assert.deepEqual(verdict.extraCollections, []);
	});

	test("points at both probes, because either can be the one that failed", () => {
		// Entries come from HTTP and collections from wrangler. A reader who cannot
		// tell which probe failed cannot fix it.
		const verdict = assessDeployParity(parity({ reachable: false }));
		assert.match(verdict.remedy ?? "", /catalogue\.json/);
		assert.match(verdict.remedy ?? "", /wrangler/);
	});
});

describe("the lists a person reads", () => {
	test("are sorted, so two identical states print identically", () => {
		// The output is compared by eye between runs. Unordered lists make one state
		// look like two, and the person comparing them concludes something changed.
		const verdict = assessDeployParity(
			parity({
				seedEntries: set("z", "m", "a"),
				liveEntries: set("q"),
				seedCollections: set("zulu", "alpha"),
				liveCollections: set("mike"),
			}),
		);
		assert.deepEqual(verdict.missingEntries, ["a", "m", "z"]);
		assert.deepEqual(verdict.extraEntries, ["q"]);
		assert.deepEqual(verdict.missingCollections, ["alpha", "zulu"]);
		assert.deepEqual(verdict.extraCollections, ["mike"]);
	});

	test("are capped in the summary but complete in the lists", () => {
		// A one-line summary that grows to 400 characters stops being read. The
		// arrays stay whole so a script can consume them.
		const many = Array.from({ length: 40 }, (_, i) => `entry-${String(i).padStart(2, "0")}`);
		const verdict = assessDeployParity(
			parity({ seedEntries: set(...many), liveEntries: set() }),
		);
		assert.equal(verdict.missingEntries.length, 40);
		assert.ok(verdict.summary.length < 200, `summary grew to ${verdict.summary.length} chars`);
		assert.match(verdict.summary, /…and 34 more/);
	});

	test("count a single finding in the singular", () => {
		const verdict = assessDeployParity(parity({ seedEntries: set("p1", "p2"), liveEntries: set("p1") }));
		assert.match(verdict.summary, /does not serve 1 seeded entry:/);
	});
});
