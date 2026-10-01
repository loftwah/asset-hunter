/**
 * Ratings and reports (#37).
 *
 * The rules here are about not overstating things. A rating is one reader's
 * opinion; an average with one rating in it must say so; a machine observation
 * that was never made is not a zero; and a report is a correction rather than a
 * bad review, so it can never be expressed as a star.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	REPORT_REASONS,
	REPORTS,
	SIGNAL_MEANING,
	aggregateRatings,
	emptyAggregate,
	parseReason,
	parseStars,
	parseSubjectType,
	ratingSummary,
	reportsForSubject,
	starLabel,
	type Rating,
} from "../src/lib/rating.ts";
import { actorFrom } from "../src/lib/signals.ts";

const rating = (stars: number, userId = "u1"): Pick<Rating, "stars" | "userId"> => ({
	stars,
	userId,
});

describe("signals stay separate", () => {
	test("the three signals each say what they are", () => {
		for (const signal of ["community", "editorial", "machine"] as const) {
			const meaning = SIGNAL_MEANING[signal];
			assert.ok(meaning && meaning.length > 20, `${signal} needs a stated meaning`);
		}
		// The one that matters: a star is explicitly not a measurement.
		assert.match(SIGNAL_MEANING.community, /not a quality score/i);
		assert.match(SIGNAL_MEANING.machine, /Null when nothing was measured/i);
	});
});

describe("parsing what a form sent", () => {
	test("only whole stars in range are accepted", () => {
		assert.equal(parseStars(3), 3);
		assert.equal(parseStars("5"), 5);
		for (const bad of [0, 6, -1, "five", "", null, undefined, NaN, {}]) {
			assert.equal(parseStars(bad), null, `should refuse ${String(bad)}`);
		}
	});

	test("an empty stars field is refused rather than stored as zero", () => {
		// `stars=` in a form arrives as an empty string, which parses to 0.
		// Storing that would drag every average towards zero invisibly.
		assert.equal(parseStars(""), null);
	});

	test("subject types and reasons are closed sets", () => {
		assert.equal(parseSubjectType("possibility"), "possibility");
		assert.equal(parseSubjectType("example"), "example");
		assert.equal(parseSubjectType("user"), null);
		assert.equal(parseReason("licence-changed"), "licence-changed");
		assert.equal(parseReason("because-i-said-so"), null);
	});
});

describe("aggregating ratings", () => {
	test("no ratings is null, not zero", () => {
		const aggregate = aggregateRatings([]);
		assert.equal(aggregate.average, null);
		assert.equal(aggregate.count, 0);
		// The shape is stable even when empty, so a consumer never has to guard.
		assert.deepEqual(Object.keys(aggregate.distribution), ["1", "2", "3", "4", "5"]);
	});

	test("an average always reports its count", () => {
		assert.match(ratingSummary(aggregateRatings([rating(4)])), /1 rating\b/);
		assert.match(ratingSummary(aggregateRatings([rating(4), rating(5)])), /2 ratings\b/);
	});

	test("one rating is reported with its count rather than as consensus", () => {
		const aggregate = aggregateRatings([rating(5)]);
		assert.equal(aggregate.average, 5);
		assert.match(ratingSummary(aggregate), /1 rating/);
		assert.match(ratingSummary(aggregate), /not a quality score/);
	});

	test("an invalid rating is skipped without poisoning the average", () => {
		const aggregate = aggregateRatings([
			rating(4),
			{ stars: NaN, userId: "u2" },
			rating(2),
		]);
		assert.equal(aggregate.count, 2);
		assert.equal(aggregate.average, 3);
	});

	test("a reader sees their own rating, not just the average", () => {
		const aggregate = aggregateRatings([rating(4, "u1"), rating(2, "u2")], "u2");
		assert.equal(aggregate.mine, 2);
		assert.equal(aggregate.average, 3);
		assert.equal(aggregateRatings([rating(4, "u1")], "u9").mine, null);
	});

	test("the distribution always has five buckets", () => {
		const aggregate = aggregateRatings([rating(5), rating(5), rating(1)]);
		assert.equal(aggregate.distribution[5], 2);
		assert.equal(aggregate.distribution[1], 1);
		assert.equal(aggregate.distribution[3], 0);
	});

	test("an empty aggregate is a usable object, not undefined", () => {
		assert.deepEqual(emptyAggregate().count, 0);
	});
});

describe("reports are corrections, not ratings", () => {
	test("every reason states what it means and what happens next", () => {
		for (const reason of REPORT_REASONS) {
			const entry = REPORTS[reason];
			assert.ok(entry, `missing copy for ${reason}`);
			assert.ok(entry.label.length > 0);
			assert.ok(entry.means.length > 10, `${reason} must say what it means`);
			assert.ok(entry.action.length > 10, `${reason} must say what happens next`);
		}
	});

	test("a licence concern is explicitly prioritised", () => {
		// This is the report that matters most: somebody noticed the catalogue
		// may be claiming more permission than the source supports.
		assert.match(REPORTS["licence-changed"].means, /no longer be justified/i);
		assert.match(REPORTS["licence-changed"].action, /re-reads the licence/i);
	});

	test("reports are filtered by subject, not by anything else", () => {
		const reports = [
			{ subjectType: "possibility" as const, subjectSlug: "a" },
			{ subjectType: "possibility" as const, subjectSlug: "b" },
			{ subjectType: "example" as const, subjectSlug: "a" },
		];
		assert.equal(reportsForSubject(reports, "possibility", "a").length, 1);
		assert.equal(reportsForSubject(reports, "example", "a").length, 1);
		assert.equal(reportsForSubject(reports, "possibility", "z").length, 0);
	});
});

describe("identity", () => {
	test("EmDash's session user becomes an actor", () => {
		const actor = actorFrom({ id: "u1", email: "a@example.com", name: "A" });
		assert.deepEqual(actor, { id: "u1", email: "a@example.com", name: "A" });
	});

	test("no user, or a disabled one, is no actor", () => {
		for (const user of [null, undefined, {}, { id: "" }, "u1", { id: "u1", disabled: true }]) {
			assert.equal(actorFrom(user), null, `should refuse ${JSON.stringify(user)}`);
		}
	});

	test("an actor without an email is still an actor", () => {
		// Some providers give a display name and no address. Refusing to accept a
		// rating because of that would be a worse failure than a null email.
		assert.deepEqual(actorFrom({ id: "u1" }), { id: "u1", email: null, name: null });
	});
});

describe("rendering a rating without a glyph font", () => {
	test("stars are labelled in words for assistive technology", () => {
		assert.equal(starLabel(4), "4 of 5");
		assert.equal(starLabel(null), "unrated");
	});
});