/**
 * The synthetic scale wall (#49).
 *
 * #49 asks for a wall of "hundreds to thousands of catalogue entries" measured
 * without hundreds of network downloads, and `docs/PERFORMANCE.md` had been
 * honest that it had never been built. This is it.
 *
 * ## Why the fixture is a query parameter rather than a route
 *
 * The measurement that matters is "does a 500-entry wall stay responsive", and
 * the only honest answer comes from measuring *the wall*: same component, same
 * grid, same filter script, same lazy-loading strategy. A separate page with its
 * own markup would be a wall that has never been true of the product, and a
 * number measured against it would be decoration. So the wall accepts
 * `?scale=N` and swaps the catalogue underneath itself — and only under
 * `astro dev`, because the synthetic entries are lies about what exists.
 *
 * ## Why the base catalogue is the CMS and not the seed file
 *
 * The expansion needs 24 real plates and real copy, and the wall already has
 * them: `loadPossibilities()` ran before this point. Importing `seed/atlas.json`
 * instead would have put 42kB of fixture data into the production Worker bundle
 * to reproduce data the page was already holding. The seed is also *content*,
 * and content that drifts out of step with the CMS is how a fixture stops
 * measuring the thing it claims to measure.
 *
 * The consequence is stated rather than hidden: the base set is whatever the
 * catalogue currently holds, so a wall measured on an unseeded database has
 * nothing to expand. `scripts/measure-perf.mjs` asserts the tile count for that
 * reason — a scale measurement against an empty wall would pass every budget
 * and mean nothing.
 *
 * ## Why it is deterministic
 *
 * `scaleWall` is a pure function of `(base, count)`. No clock, no randomness, no
 * `Math.random()` without a seed, no iteration over a `Set` whose order is not
 * defined. Two runs a day apart over the same catalogue produce the same five
 * hundred entries in the same order, which is what makes a screenshot diff and
 * a regression budget mean anything. `tests/scale.test.ts` asserts it.
 */
import type { Possibility } from "./catalogue.ts";

/**
 * How many entries `?scale=` asks for when it does not say.
 *
 * Five hundred is the number #49 names, and it is also the number that broke
 * things when it was guessed at: it is ~21× the catalogue and ~17,000 DOM nodes
 * at the measured 34 nodes per tile.
 */
export const DEFAULT_SCALE = 500;

/**
 * The ceiling, and it exists because the parameter is user-controlled.
 *
 * `?scale=10000000` on a dev server is a denial of service against your own
 * laptop. Twenty thousand entries is ~10,000× the real catalogue and still a
 * wall worth measuring; past that the answer is a different product.
 */
export const MAX_SCALE = 20_000;

/**
 * Whether a number is a usable scale request.
 *
 * NaN, Infinity, `0`, `-1`, `"abc"` and `""` are all "no", because `Number("")`
 * is `0` and `Number(" ")` is `0` — the same trap `toMeasure` exists to avoid.
 * A request for a wall *smaller* than the catalogue is clamped to it rather
 * than honoured, so `?scale=3` never renders a truncated catalogue.
 */
function usableCount(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}

/**
 * The scale a request asked for, or `null` for "the real catalogue".
 *
 * `dev` is passed rather than read from `import.meta.env` so the rule is
 * testable and so the production refusal is visible at the call site: this
 * function is the only thing standing between `?scale=5000` and a production
 * route that renders five thousand lies.
 */
export function requestedScale(url: URL, dev: boolean): number | null {
	if (!dev) return null;
	const raw = url.searchParams.get("scale");
	if (raw === null) return null;
	const asked = Number(raw);
	if (!usableCount(asked)) return null;
	return Math.min(asked, MAX_SCALE);
}

/**
 * How a variant is named, and why it says so out loud.
 *
 * A wall of five hundred tiles where twenty-one titles are identical and three
 * hundred say "density gradient" with no marker is a fixture pretending to be
 * content. Every duplicated entry carries its pass in the title, so a
 * screenshot of the fixture is self-describing and a reader who lands on one
 * knows it is not a catalogue claim.
 */
const variantTitle = (title: string, pass: number) =>
	pass === 0 ? title : `${title} (pass ${pass + 1})`;

const variantSlug = (slug: string, pass: number) => (pass === 0 ? slug : `${slug}-p${pass + 1}`);

/**
 * Nudges a variant's editorial rank below its original.
 *
 * The wall orders by editorial rank, and a pass-3 copy of the highest-ranked
 * entry must not outrank the entry a curator actually put first. The decrement
 * is a thousandth of a rank, far below the spacing between real ranks, so it
 * separates a variant from its original without disturbing anything else.
 */
const variantRank = (rank: number | null | undefined, pass: number) =>
	pass === 0 ? (rank ?? null) : Math.max(0, (rank ?? 0) - pass / 1000);

/**
 * The synthetic catalogue: the real one, cycled to `count` entries.
 *
 * Round-robin rather than "all of pass 1, then all of pass 2" on purpose. It
 * puts the highest-ranked real entries in the first viewport, exactly as the
 * real wall does, which is the case that matters: an eager-loading regression
 * shows up as images fetched above the fold, and only a fixture with a
 * realistic opening is going to show one.
 *
 * Everything else is copied from the base entry — plate, vertical, media kind,
 * rights, origin, evidence. A variant that invented a rights status or claimed
 * a verified source would be a licence lie on a page, and the tiles carry both
 * marks, so the copy is exactly the copy.
 */
export function scaleWall(base: Possibility[], count: number): Possibility[] {
	if (!usableCount(count) || base.length === 0) return [];
	const wanted = Math.min(count, MAX_SCALE);
	const out: Possibility[] = new Array(wanted);
	for (let i = 0; i < wanted; i++) {
		const source = base[i % base.length];
		const pass = Math.floor(i / base.length);
		if (pass === 0) {
			out[i] = source;
			continue;
		}
		out[i] = {
			...source,
			slug: variantSlug(source.slug, pass),
			title: variantTitle(source.title, pass),
			editorialRank: variantRank(source.editorialRank, pass),
			// A variant is not a new claim about the world, so it stays published
			// and it does not become featured. `loadPossibilities` has already
			// filtered by visibility, so re-asserting it here keeps the synthetic
			// set inside the same rule the real one obeyed.
			visibility: source.visibility ?? "published",
			featured: false,
		};
	}
	return out;
}

/** What the wall needs to describe itself honestly in the fixture's own chrome. */
export interface ScaleSummary {
	entries: number;
	base: number;
	passes: number;
	/** True when the request was clamped, so the page can say so rather than lie. */
	clamped: number | null;
}

/** Describes a scale wall for the note the page prints above it. Pure. */
export function describeScale(base: number, entries: number, asked: number): ScaleSummary {
	return {
		entries,
		base,
		passes: base === 0 ? 0 : Math.ceil(entries / base),
		clamped: asked > MAX_SCALE ? MAX_SCALE : null,
	};
}