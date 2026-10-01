/**
 * Catalogue logic that is easy to get subtly wrong.
 *
 * These cover the mapping from EmDash's field shapes to the catalogue view
 * model, the media resolution fallback, and the honest-count rules. The bugs
 * they guard against are all silent — a wrong value renders as a plausible page
 * rather than an error.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mediaSrc, tallyVerticals, type Possibility } from "../src/lib/catalogue.ts";
import {
	ORIGIN_MEANING,
	RIGHTS_LABEL,
	RIGHTS_MEANING,
	mediaLabelGuard,
} from "./helpers.ts";

const possibility = (over: Partial<Possibility> = {}): Possibility => ({
	slug: "test",
	title: "Test",
	...over,
});

describe("mediaSrc", () => {
	test("prefers a CMS-managed image over the repo specimen", () => {
		// The image field is an object, not a string. If this ever returns
		// "[object Object]" the Image field is being read incorrectly.
		const src = mediaSrc({
			specimen: "/specimens/a.svg",
			image: { id: "m1", src: "https://media.example/a.png" },
		});
		assert.equal(src, "https://media.example/a.png");
	});

	test("falls back to the specimen when no CMS image is set", () => {
		assert.equal(mediaSrc({ specimen: "/specimens/a.svg" }), "/specimens/a.svg");
	});

	test("falls back to the placeholder when neither is set", () => {
		assert.equal(mediaSrc({}), "/specimens/placeholder.svg");
	});

	test("an empty image object does not produce an object URL", () => {
		const src = mediaSrc({ image: { id: "m1" }, specimen: "/specimens/b.svg" });
		assert.equal(src, "/specimens/b.svg");
	});
});

describe("tallyVerticals", () => {
	test("counts per vertical and orders by count then slug", () => {
		const rows = tallyVerticals([
			possibility({ slug: "a", vertical: "games" }),
			possibility({ slug: "b", vertical: "games" }),
			possibility({ slug: "c", vertical: "logos" }),
			possibility({ slug: "d", vertical: "icons" }),
			possibility({ slug: "e", vertical: "icons" }),
		]);
		assert.deepEqual(rows, [
			{ slug: "games", count: 2 },
			{ slug: "icons", count: 2 },
			{ slug: "logos", count: 1 },
		]);
	});

	test("entries with no vertical are excluded rather than bucketed as empty", () => {
		const rows = tallyVerticals([
			possibility({ slug: "a", vertical: "games" }),
			possibility({ slug: "b", vertical: null }),
			possibility({ slug: "c", vertical: undefined }),
		]);
		assert.deepEqual(rows, [{ slug: "games", count: 1 }]);
	});

	test("an empty catalogue produces no rows rather than throwing", () => {
		assert.deepEqual(tallyVerticals([]), []);
	});
});

describe("rights vocabulary", () => {
	test("every status has a human label", () => {
		for (const status of ["cleared", "attribution", "review", "reference"]) {
			assert.ok(RIGHTS_LABEL[status as keyof typeof RIGHTS_LABEL], `no label for ${status}`);
		}
	});

	test("every status has a sentence, not just a word", () => {
		for (const status of ["cleared", "attribution", "review", "reference"]) {
			const meaning = RIGHTS_MEANING[status as keyof typeof RIGHTS_MEANING];
			assert.ok(meaning && meaning.length > 40, `meaning for ${status} is too thin`);
		}
	});

	test("reference-only never reads as a softer cleared", () => {
		// The single most damaging possible failure of this vocabulary.
		const reference = RIGHTS_MEANING.reference.toLowerCase();
		assert.ok(!reference.includes("permitted for use"));
		assert.ok(reference.includes("no licence") || reference.includes("not licensed"));
	});

	test("every origin is defined", () => {
		for (const origin of ["upstream", "derived", "generated"]) {
			assert.ok(
				ORIGIN_MEANING[origin as keyof typeof ORIGIN_MEANING],
				`no meaning for ${origin}`,
			);
		}
	});

	test("generated explicitly disclaims being a reproduction", () => {
		assert.match(ORIGIN_MEANING.generated.toLowerCase(), /not a reproduction/);
	});
});

describe("media labels", () => {
	test("no media kind renders as an empty label", () => {
		assert.equal(mediaLabelGuard(""), null);
		assert.equal(mediaLabelGuard("unknown-kind"), "unknown-kind");
	});
});
