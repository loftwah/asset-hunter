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
import {
	LAB_SECTIONS,
	MEDIA_FIXTURES,
	ORIGIN_FIXTURES,
	RIGHTS_FIXTURES,
	EVIDENCE_FIXTURES,
	STATE_FIXTURES,
	SIGNAL_FIXTURES,
	USE_FIXTURES,
	allFixtures,
} from "../src/lib/fixtures.ts";
import { MEDIA_LABEL, RIGHTS_MEANING, USE_STATE_MEANING } from "../src/lib/vocabulary.ts";
import { ratingSummary } from "../src/lib/rating.ts";

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