/**
 * `buildCatalogue` must not rebuild the example graph once per possibility.
 *
 * ## What was wrong, and why it survived so long
 *
 * `loadExamplesFor(slug)` is `loadExampleGraph()` indexed by slug, and
 * `loadExampleGraph` reads the whole `examples` collection and then issues **one
 * single-entry read per example** to resolve its `possibility` reference — that
 * reference has no column, and the list route returns it absent rather than
 * resolved, so the fan-out is forced.
 *
 * `buildCatalogue` called it from inside its per-possibility loop. Thirty-four
 * possibilities therefore rebuilt the entire graph thirty-four times: about
 * **1,190 subrequests** where about 35 were needed, quadratic in the catalogue.
 *
 * It survived because nothing failed loudly. `/api/catalogue.json` took 99-117
 * seconds to rebuild and answered every *other* request instantly from its cache,
 * so the symptom was "slow sometimes". It dropped three or four examples on some
 * builds and served them as a 200 with a plausible body, so the symptom was also
 * "occasionally wrong". And the handler had a comment — "a render is expensive
 * (the N+1 in `buildCatalogue`" — which read as a *description* of a known cost
 * rather than as the location of an unfixed bug. The mitigation was a cache TTL.
 *
 * **There was no test for `buildCatalogue` at all.** It builds the public machine
 * interface — the thing `docs/AGENT_API.md` tells an agent to read — and nothing
 * exercised it. This file is that test.
 *
 * ## What this asserts, and what it deliberately does not
 *
 * That the number of CMS reads does not grow with the number of possibilities. The
 * bound is expressed as reads-per-possibility rather than a magic number, because
 * "35" would rot the moment a collection is added and the *shape* is the thing that
 * regressed.
 *
 * It does not assert a total read count, because the honest total depends on
 * catalogue size and on how many of those reads fan out for references — a real
 * number here would be a number to maintain. A ratio catches the quadratic; a
 * constant would only catch yesterday.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { EmDashContent } from "../src/lib/effect/emdash.ts";
import { buildCatalogue } from "../src/lib/catalogue-json.ts";

interface Counts {
	collections: number;
	entries: number;
}

/**
 * A CMS that counts what it was asked for.
 *
 * Rows are deliberately minimal: `buildCatalogue` projects defensively, so a row
 * with only a title is a real possibility with nothing claimed about it. The test is
 * about how *often* the CMS is asked, not about what comes back.
 */
function countingEmDash(counts: Counts, possibilities: number, examples: number) {
	const possibilityRows = Array.from({ length: possibilities }, (_, i) => ({
		id: `p${i}`,
		data: { title: `Possibility ${i}`, example_count: "1" },
	}));
	const exampleRows = Array.from({ length: examples }, (_, i) => ({
		id: `e${i}`,
		data: { title: `Example ${i}`, origin: "generated", media_kind: "image", rights_status: "reference" },
	}));

	const page = (rows: ReadonlyArray<{ id: string; data: unknown }>) => {
		counts.collections++;
		return Effect.succeed({ entries: rows, nextCursor: null, cacheHint: undefined });
	};

	return {
		counts,
		layer: Layer.succeed(
			EmDashContent,
			EmDashContent.of({
				collection: (name: string) =>
					name === "possibilities"
						? page(possibilityRows)
						: name === "examples"
							? page(exampleRows)
							: page([]),
				entry: (name: string, id: string) => {
					counts.entries++;
					const row = name === "examples" ? exampleRows.find((r) => r.id === id) : undefined;
					return Effect.succeed({
						entry: row ? { id: row.id, data: row.data, references: null } : null,
						cacheHint: undefined,
					});
				},
				menu: () => Effect.succeed({ menu: null, cacheHint: undefined }),
				section: () => Effect.succeed(null),
			}),
		) as Layer.Layer<EmDashContent>,
	};
}

async function measure(possibilities: number, examples: number) {
	const counts: Counts = { collections: 0, entries: 0 };
	const { layer } = countingEmDash(counts, possibilities, examples);
	const catalogue = await Effect.runPromise(Effect.provide(buildCatalogue(), layer));
	return { counts, catalogue };
}

describe("the catalogue build's cost", () => {
	test("does not grow with the number of possibilities", async () => {
		/*
		 * The regression, as a ratio.
		 *
		 * Ten possibilities and one hundred must cost roughly the same *per
		 * possibility*. Before the fix, one hundred cost ten times one ten's, because
		 * each possibility rebuilt the whole example graph.
		 */
		const small = await measure(10, 10);
		const large = await measure(100, 10);

		const perPossibility = (m: { counts: Counts; catalogue: { possibilities: unknown[] } }) =>
			(m.counts.collections + m.counts.entries) / m.catalogue.possibilities.length;

		assert.equal(small.catalogue.possibilities.length, 10);
		assert.equal(large.catalogue.possibilities.length, 100);
		assert.ok(
			perPossibility(large) <= perPossibility(small) * 1.5,
			`reads per possibility grew from ${perPossibility(small).toFixed(2)} to ${perPossibility(large).toFixed(2)} — the graph is being rebuilt per possibility`,
		);
	});

	test("reads the examples collection once, whatever the catalogue holds", async () => {
		// The specific shape: before, this was `possibilities.length` reads.
		for (const n of [1, 10, 50]) {
			const { counts } = await measure(n, 5);
			assert.equal(
				counts.collections,
				5,
				`with ${n} possibilities the build asked for ${counts.collections} collections; the example graph is being rebuilt`,
			);
		}
	});

	test("does not fan out a reference read per possibility", async () => {
		// Ten possibilities with ten examples: the graph costs ten reference reads, so
		// the entry count must track the *examples*, not the possibilities.
		const { counts } = await measure(10, 10);
		assert.ok(
			counts.entries <= 10,
			`asked for ${counts.entries} single-entry reads for 10 examples; something is re-reading per possibility`,
		);
	});

	test("still produces every possibility, so the hoist cost nothing", async () => {
		// A fix that made the build cheap by dropping rows would pass the three tests
		// above. This is the one that notices.
		const { catalogue } = await measure(7, 3);
		assert.equal(catalogue.possibilities.length, 7);
		assert.deepEqual(
			catalogue.possibilities.map((p: { id: string }) => p.id),
			["p0", "p1", "p2", "p3", "p4", "p5", "p6"],
		);
	});
});
