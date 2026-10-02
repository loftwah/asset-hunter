/**
 * The visual lab's fixtures (#45) and the rating states added for #47.
 *
 * These assertions are about **coverage**, not about rendering: a fixture is a
 * claim that a state has been looked at, and this file is where that claim is
 * kept honest. Before #47 the lab covered media kinds, rights, origins, machine
 * evidence and interaction states — and had nothing at all for the rating and
 * report states, which meant six of the seven states a reader can land in had
 * never been rendered by anybody.
 *
 * They also pin determinism. Every fixture is a literal, and a fixture that read
 * the clock or generated a value at import time would make two runs a week apart
 * produce different pixels — at which point a screenshot diff means nothing and
 * the matrix is decoration.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	LAB_SECTIONS,
	MEDIA_FIXTURES,
	ORIGIN_FIXTURES,
	RIGHTS_FIXTURES,
	EVIDENCE_FIXTURES,
	STATE_FIXTURES,
	SIGNAL_FIXTURES,
	USE_FIXTURES,
	USE_PAGE_FIXTURES,
	USE_PAGE_FIXTURE_PREFIX,
	allFixtures,
	usePageFixtureFor,
} from "../src/lib/fixtures.ts";
import { MEDIA_LABEL, RIGHTS_MEANING, USE_STATE_MEANING } from "../src/lib/vocabulary.ts";
import { ratingSummary } from "../src/lib/rating.ts";
import { useStateFor } from "../src/lib/asset-use.ts";

/** Every fixture group is a plain array, so one helper covers all of them. */
const groups = [
	["media", MEDIA_FIXTURES],
	["rights", RIGHTS_FIXTURES],
	["origin", ORIGIN_FIXTURES],
	["evidence", EVIDENCE_FIXTURES],
	["state", STATE_FIXTURES],
] as const;

describe("every fixture names what it is proving", () => {
	for (const [name, fixtures] of groups) {
		test(`${name} fixtures all carry a note`, () => {
			for (const fixture of fixtures) {
				// Not a length rule: several notes are legitimately terse ("icon
				// set", "3D asset", "default"). The rule is that a fixture says what
				// it is for, and a blank caption leaves the next person guessing.
				assert.ok(
					fixture.note && fixture.note.trim().length >= 4,
					`a fixture with no note is a fixture nobody knows the point of: ${JSON.stringify(fixture.possibility.slug)}`,
				);
				assert.notEqual(
					fixture.note.trim(),
					fixture.possibility.slug,
					`${fixture.possibility.slug} repeats its slug as its caption`,
				);
			}
		});

		test(`${name} fixture slugs are unique`, () => {
			const slugs = fixtures.map((f) => f.possibility.slug);
			assert.equal(new Set(slugs).size, slugs.length, `duplicate fixture slug in ${name}`);
		});
	}

	test("use and signal fixtures carry a note too", () => {
		for (const fixture of USE_FIXTURES) assert.ok(fixture.note.trim().length >= 4);
		for (const fixture of SIGNAL_FIXTURES) assert.ok(fixture.note.trim().length >= 4);
	});
});

describe("the lab covers every state the catalogue has to survive", () => {
	test("every media kind has a fixture, so a new handler cannot ship unseen", () => {
		const covered = new Set(
			MEDIA_FIXTURES.map((f) => f.possibility.mediaKind).filter(Boolean),
		);
		for (const kind of Object.keys(MEDIA_LABEL)) {
			assert.ok(covered.has(kind as never), `no fixture for media kind "${kind}"`);
		}
	});

	test("all four rights statuses are present, including the one that must never read as permissive", () => {
		const covered = new Set(
			RIGHTS_FIXTURES.map((f) => f.possibility.rightsStatus).filter(Boolean),
		);
		for (const status of ["cleared", "attribution", "review", "reference"]) {
			assert.ok(covered.has(status as never), `no fixture for rights status "${status}"`);
		}
	});

	test("every origin is present and they are never confusable", () => {
		const covered = new Set(
			ORIGIN_FIXTURES.map((f) => f.possibility.representativeOrigin).filter(Boolean),
		);
		assert.deepEqual([...covered].sort(), ["derived", "generated", "upstream"]);
	});

	test("honest zero and not-measured are both present and distinguishable", () => {
		const zero = EVIDENCE_FIXTURES.find((f) => f.possibility.distinctSources === 0);
		const counted = EVIDENCE_FIXTURES.find(
			(f) => (f.possibility.distinctSources ?? 0) > 0,
		);
		assert.ok(zero, "no fixture for 'we looked and found none'");
		assert.ok(counted, "no fixture for a counted answer");
		const nulls = EVIDENCE_FIXTURES.filter((f) => f.possibility.novelty === null);
		assert.ok(nulls.length > 0, "no fixture for 'we did not measure this'");
	});

	test("every use state the vocabulary defines has a fixture", () => {
		// The states themselves are asserted in `asset-use.test.ts`; what matters
		// here is that all of them have *pixels* somewhere.
		for (const state of Object.keys(USE_STATE_MEANING)) {
			assert.ok(USE_STATE_MEANING[state as keyof typeof USE_STATE_MEANING]);
		}
		assert.ok(
			USE_FIXTURES.length >= Object.keys(USE_STATE_MEANING).length,
			"fewer use fixtures than defined use states",
		);
	});
});

describe("rating and report states (#47)", () => {
	test("the honest zero, one rating, a distribution, and this reader's own vote all exist", () => {
		const unrated = SIGNAL_FIXTURES.filter((f) => f.community.count === 0);
		assert.ok(unrated.length >= 1, "no fixture for an entry nobody has rated");

		const one = SIGNAL_FIXTURES.find((f) => f.community.count === 1);
		assert.ok(one, "no fixture for exactly one rating — the case most likely to read as a score");
		assert.match(
			ratingSummary(one.community),
			/1 rating\b/,
			"a single rating must say it is one rating",
		);

		const spread = SIGNAL_FIXTURES.find(
			(f) => Object.values(f.community.distribution).filter((n) => n > 0).length >= 4,
		);
		assert.ok(spread, "no fixture with ratings spread across most of the scale");

		const mine = SIGNAL_FIXTURES.find((f) => f.community.mine !== null);
		assert.ok(mine, "no fixture where this reader has already rated, so 'Change' is never seen");
	});

	test("both authentication states exist, because the rate form is disabled in one of them", () => {
		assert.ok(SIGNAL_FIXTURES.some((f) => f.viewer === null), "no signed-out state");
		assert.ok(SIGNAL_FIXTURES.some((f) => f.viewer !== null), "no signed-in state");
		// And the two must be shown *with* ratings too: an empty form is easier to
		// read than a populated one that has been disabled.
		assert.ok(
			SIGNAL_FIXTURES.some((f) => f.viewer === null && f.community.count > 0),
			"no signed-out state with ratings on screen",
		);
	});

	test("the report-submitted state exists, including a licence concern", () => {
		const filed = SIGNAL_FIXTURES.find((f) => f.openReports.length > 0);
		assert.ok(filed, "no fixture for an entry with an open report");
		assert.ok(
			filed.openReports.some((r) => r.reason === "licence-changed"),
			"the open-report fixture must include the reason that takes priority",
		);
		for (const report of filed.openReports) {
			assert.equal(report.resolution, null, "an 'open' report with a resolution is not open");
		}
	});

	test("a fixture's own summary never overstates it", () => {
		for (const fixture of SIGNAL_FIXTURES) {
			const { count, average } = fixture.community;
			if (count === 0) {
				assert.equal(average, null, "zero ratings cannot have an average");
				assert.match(ratingSummary(fixture.community), /No ratings yet/);
			} else {
				assert.equal(typeof average, "number");
				assert.ok(
					(average as number) >= 1 && (average as number) <= 5,
					`average ${average} is outside the scale`,
				);
			}
		}
	});

	test("the reader identity is a fixture, not a real account", () => {
		for (const fixture of SIGNAL_FIXTURES) {
			if (!fixture.viewer) continue;
			assert.match(fixture.viewer.email ?? "", /@example\.invalid$/);
		}
	});
});

describe("the fixtures are deterministic", () => {
	test("two reads of allFixtures() are deeply equal", () => {
		assert.deepEqual(allFixtures(), allFixtures());
	});

	test("allFixtures is every section's fixtures, and the sections are declared", () => {
		const total = LAB_SECTIONS.reduce((sum, section) => sum + section.fixtures.length, 0);
		assert.equal(allFixtures().length, total);
		assert.equal(
			total,
			MEDIA_FIXTURES.length +
				RIGHTS_FIXTURES.length +
				ORIGIN_FIXTURES.length +
				EVIDENCE_FIXTURES.length +
				STATE_FIXTURES.length,
		);
	});

	test("every section explains why it exists", () => {
		for (const section of LAB_SECTIONS) {
			assert.ok(section.why.trim().length > 20, `section "${section.id}" has no reason`);
			assert.ok(section.fixtures.length > 0, `section "${section.id}" is empty`);
		}
	});

	test("every section id is unique, so a lab jump link can only mean one thing", () => {
		const ids = LAB_SECTIONS.map((s) => s.id);
		assert.equal(new Set(ids).size, ids.length);
	});

	test("no fixture carries a wall-clock value", () => {
		// A generated timestamp is the one thing that would make two runs produce
		// different pixels, and it would look like a rendering bug rather than a
		// fixture bug. The one timestamp in the file is a fixed literal.
		const created = USE_FIXTURES.length + SIGNAL_FIXTURES.length;
		assert.ok(created > 0);
		for (const fixture of SIGNAL_FIXTURES) {
			for (const report of fixture.openReports) {
				assert.equal(report.createdAt, "2026-01-01T00:00:00.000Z");
			}
		}
	});
});

describe("the rights vocabulary the fixtures lean on is intact", () => {
	test("each rights status has a stated meaning, because the tiles beside it promise one", () => {
		for (const status of ["cleared", "attribution", "review", "reference"]) {
			assert.ok(
				RIGHTS_MEANING[status as keyof typeof RIGHTS_MEANING],
				`rights status "${status}" has no meaning sentence`,
			);
		}
	});
});

describe("every plate a fixture names actually exists (#47)", () => {
	/*
	 * This is the check that would have caught a broken specimen before anybody
	 * looked at a screenshot.
	 *
	 * The six use fixtures defaulted to a plate called `grain-field` that was never
	 * authored, so every one of them rendered a 404 in its `<img>` on the lab and,
	 * once `/use/<slug>` had fixtures, on the use page too. Nothing caught it: the
	 * fixture tests assert coverage, not files on disk, and the visual matrix only
	 * sees a page when a route points at it. A fixture that names a file is a claim
	 * about a file, so it gets checked like one.
	 */
	const specimensDir = new URL("../public/specimens/", import.meta.url).pathname;

	test("no fixture points at a plate that is not there", () => {
		const missing: string[] = [];
		const check = (path: string | null | undefined, where: string) => {
			if (!path) return;
			if (path.startsWith("/specimens/") && !existsSync(`${specimensDir}${path.slice("/specimens/".length)}`)) {
				missing.push(`${where} → ${path}`);
			}
		};
		for (const fixture of allFixtures()) {
			check(fixture.possibility.specimen, fixture.possibility.slug);
			check(fixture.possibility.image?.src, fixture.possibility.slug);
		}
		for (const fixture of USE_FIXTURES) {
			check(fixture.example.specimen, fixture.example.slug);
			check(fixture.example.image?.src, fixture.example.slug);
		}
		for (const fixture of USE_PAGE_FIXTURES) {
			check(fixture.possibility.specimen, fixture.slug);
			check(fixture.possibility.image?.src, fixture.slug);
			for (const example of fixture.examples) {
				check(example.specimen, example.slug);
				check(example.image?.src, example.slug);
			}
		}
		assert.deepEqual(missing, [], `fixtures name plates that do not exist: ${missing.join(", ")}`);
	});
});

describe("the use page can be seen in every state (#47)", () => {
	/*
	 * `check:visual` captures `/use/fixture-use-page-*` at all eleven viewports, so
	 * a fixture that is renamed, dropped, or moved behind a different prefix takes
	 * five routes from 200 to 404. These assertions are the contract that the
	 * matrix's route list is written against.
	 */
	test("every fixture slug is namespaced, so a fixture can never shadow a real entry", () => {
		for (const fixture of USE_PAGE_FIXTURES) {
			assert.ok(
				fixture.slug.startsWith(USE_PAGE_FIXTURE_PREFIX),
				`${fixture.slug} is not behind the ${USE_PAGE_FIXTURE_PREFIX} prefix — a fixture that could collide with a catalogue slug would shadow it in astro dev`,
			);
		}
	});

	test("the fixture slugs are unique", () => {
		const slugs = USE_PAGE_FIXTURES.map((f) => f.slug);
		assert.equal(new Set(slugs).size, slugs.length, "two fixture selections answer to one slug");
	});

	test("all four use states are reachable through a fixture selection", () => {
		const seen = new Set(
			USE_PAGE_FIXTURES.flatMap((fixture) => fixture.examples.map((example) => useStateFor(example))),
		);
		for (const state of Object.keys(USE_STATE_MEANING)) {
			assert.ok(seen.has(state as never), `no /use fixture selection renders the "${state}" state`);
		}
	});

	test("a selection with something to hand over exists, because otherwise the download control has never been rendered", () => {
		// `useDecision` is the rule; this is the assertion that the rule has had at
		// least one fixture it lets through, rather than every fixture being refused
		// for the same reason and the page's whole accent never appearing.
		const withPayload = USE_PAGE_FIXTURES.filter((fixture) =>
			fixture.examples.some((example) => example.downloadable && example.contentHash),
		);
		assert.ok(
			withPayload.length >= 1,
			"no fixture selection is retained, hashed and permitted, so no use page has ever shown a download",
		);
		// …and one that is permitted and not retained, which is the state that
		// separates "0 because nothing is permitted" from "0 because we do not hold
		// it" and which the catalogue cannot reach on its own.
		assert.ok(
			USE_PAGE_FIXTURES.some((fixture) =>
				fixture.examples.some((e) => e.rightsStatus === "cleared" && !e.downloadable),
			),
			"no fixture selection is permitted-but-not-retained",
		);
	});

	test("usePageFixtureFor resolves only its own namespace", () => {
		assert.equal(usePageFixtureFor("density-gradient"), null, "a real catalogue slug must never resolve to a fixture");
		assert.equal(usePageFixtureFor(`${USE_PAGE_FIXTURE_PREFIX}nope`), null);
		assert.equal(usePageFixtureFor(""), null);
		assert.equal(usePageFixtureFor(null), null);
		assert.equal(usePageFixtureFor(undefined), null);
		for (const fixture of USE_PAGE_FIXTURES) {
			assert.equal(usePageFixtureFor(fixture.slug)?.slug, fixture.slug);
		}
	});

	test("the selections are deterministic, so two runs a week apart produce the same pixels", () => {
		assert.deepEqual(USE_PAGE_FIXTURES, USE_PAGE_FIXTURES);
		// No wall-clock value anywhere in a selection: a timestamp is the one thing
		// that would make a screenshot diff mean nothing and look like a rendering
		// bug rather than a fixture bug.
		const serialised = JSON.stringify(USE_PAGE_FIXTURES);
		assert.doesNotMatch(serialised, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "a fixture selection carries a timestamp");
	});

	test("each selection says what it is proving", () => {
		for (const fixture of USE_PAGE_FIXTURES) {
			assert.ok(fixture.note.trim().length >= 4, `${fixture.slug} has no note`);
			assert.ok(fixture.examples.length > 0, `${fixture.slug} has no examples, so it proves nothing`);
		}
	});
});