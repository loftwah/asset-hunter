/**
 * The machine-facing catalogue contract (#58).
 *
 * An agent — this project's own build included — needs the catalogue without
 * scraping HTML and without an admin token. So the catalogue has a documented
 * JSON shape, served read-only, published-only, from the same EmDash reads the
 * site uses.
 *
 * Three rules, each of which has been got wrong before:
 *
 * 1. **Published only.** The collection queries filter on status, so a draft
 *    cannot leak through this path even if it exists. \`npm run doctor\` checks
 *    the public wall for machine drafts; this module is where that check would
 *    fail first.
 * 2. **Versioned shape.** \`schema\` is a version string, and a field that
 *    disappears is a breaking change. Consumers read what is here, not what a
 *    future version might do.
 * 3. **Nothing inferred.** \`null\` means not measured and is never replaced by a
 *    zero, and every example carries the rights status its evidence supports.
 *    A machine-readable catalogue that flattens those distinctions is worse than
 *    no catalogue, because it is trusted.
 */

import { DateTime, Effect } from "effect";
import {
	REFERENCE_CONCURRENCY,
	loadCollections,
	loadExampleGraph,
	loadPossibilities,
	type Example,
	type Possibility,
} from "./catalogue.ts";
import { EmDashContent, type EmDashReadError } from "./effect/emdash.ts";
import { MEDIA_LABEL, originLabelFor, rightsLabelFor, verticalLabel } from "./vocabulary.ts";
import { aggregateRatings, ratingSummary, type Aggregate } from "./rating.ts";
import { aggregateBySubject, loadRatings, loadReports } from "./signals.ts";

export const CATALOGUE_SCHEMA = "asset-hunter.catalogue/1";

export interface CatalogueExample {
	id: string;
	title: string;
	origin: string | null;
	originMeaning: string | null;
	mediaKind: string | null;
	media: string | null;
	rightsStatus: string | null;
	rightsLabel: string | null;
	rightsNote: string | null;
	sourceUrl: string | null;
	sourceRepo: string | null;
	sourceRef: string | null;
	sourcePath: string | null;
	licenceSpdx: string | null;
	licenceEvidence: string | null;
	attribution: string | null;
	contentHash: string | null;
	/** Only ever true when the evidence permits redistribution. */
	downloadable: boolean;
}

export interface CataloguePossibility {
	id: string;
	title: string;
	tagline: string | null;
	summary: string;
	technique: string | null;
	vertical: string | null;
	verticalLabel: string | null;
	mediaKind: string | null;
	media: string | null;
	representativeOrigin: string | null;
	representativeOriginLabel: string | null;
	rightsStatus: string | null;
	rightsLabel: string | null;
	rightsNote: string | null;
	/** Prompted by the machine, or null when it was never measured. */
	novelty: number | null;
	coverage: number | null;
	exampleCount: number;
	/** Sources whose licence was actually read. 0 is a real answer. */
	distinctSources: number;
	communityRating: { average: number | null; count: number };
	communityRatingSummary: string;
	featured: boolean;
	examples: CatalogueExample[];
}

export interface Catalogue {
	schema: string;
	site: string;
	generated: string;
	counts: {
		possibilities: number;
		examples: number;
		collections: number;
		verticals: number;
		rights: Record<string, number>;
	};
	/** A digest of the content, so two fetches can be compared cheaply. */
	fingerprint: string;
	possibilities: CataloguePossibility[];
	collections: { id: string; title: string; tagline: string | null; members: string[] }[];
}

/**
 * The example model already carries `downloadable` as a real boolean
 * (`mapExample` coerces the CMS 0/1 form once, in `src/lib/catalogue.ts`), so
 * this contract does not get to invent a second reading of the same field.
 */
export function serialiseExample(example: Example): CatalogueExample {
	return {
		id: example.slug,
		title: example.title,
		origin: example.origin ?? null,
		originMeaning: originLabelFor(example.origin),
		mediaKind: example.mediaKind ?? null,
		media: example.mediaKind ? (MEDIA_LABEL[example.mediaKind] ?? example.mediaKind) : null,
		rightsStatus: example.rightsStatus ?? null,
		rightsLabel: rightsLabelFor(example.rightsStatus),
		rightsNote: example.rightsNote ?? null,
		sourceUrl: example.sourceUrl ?? null,
		sourceRepo: example.sourceRepo ?? null,
		sourceRef: example.sourceRef ?? null,
		sourcePath: example.sourcePath ?? null,
		licenceSpdx: example.licenceSpdx ?? null,
		licenceEvidence: example.licenceEvidence ?? null,
		attribution: example.attribution ?? null,
		contentHash: example.contentHash ?? null,
		downloadable: example.downloadable,
	};
}

export function serialisePossibility(
	possibility: Possibility,
	examples: Example[],
	rating: Pick<Aggregate, "average" | "count">,
): CataloguePossibility {
	return {
		id: possibility.slug,
		title: possibility.title,
		tagline: possibility.tagline ?? null,
		summary: possibility.summary ?? "",
		technique: possibility.technique ?? null,
		vertical: possibility.vertical ?? null,
		verticalLabel: verticalLabel(possibility.vertical),
		mediaKind: possibility.mediaKind ?? null,
		media: possibility.mediaKind ? MEDIA_LABEL[possibility.mediaKind] ?? possibility.mediaKind : null,
		representativeOrigin: possibility.representativeOrigin ?? null,
		representativeOriginLabel: originLabelFor(possibility.representativeOrigin),
		rightsStatus: possibility.rightsStatus ?? null,
		rightsLabel: rightsLabelFor(possibility.rightsStatus),
		rightsNote: possibility.rightsNote ?? null,
		novelty: possibility.novelty ?? null,
		coverage: possibility.coverage ?? null,
		exampleCount: examples.length,
		distinctSources: possibility.distinctSources ?? 0,
		communityRating: { average: rating.average, count: rating.count },
		communityRatingSummary: ratingSummary(rating),
		featured: possibility.featured === true,
		examples: examples.map(serialiseExample),
	};
}

/** A cheap content digest: stable for the same content, different otherwise. */
export function fingerprint(value: unknown): string {
	const text = JSON.stringify(value);
	// FNV-1a, same as the engine's brief fingerprint. Not a security boundary.
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Builds the whole catalogue.
 *
 * Examples are fetched per possibility because EmDash resolves `reference`
 * fields only through `getEmDashEntry` — the same N+1 the site pays. At
 * catalogue scale that is the cost of using the CMS's own resolution rather than
 * a second query the CMS knows nothing about.
 *
 * Two things are Effect-native here and two are not, and the split is the point:
 *
 * - **Effect:** the reads, the bounded fan-out over possibilities, and the
 *   timestamp. `DateTime.nowAsDate` reads Effect's `Clock`, so a test can pin
 *   `generated` instead of asserting on "roughly now" — which is the only way to
 *   test a body that is *supposed* to be deterministic apart from its timestamp.
 * - **Plain:** `serialisePossibility`, `serialiseExample` and `fingerprint`. They
 *   are pure functions over already-decoded data, they are the part a consumer of
 *   the JSON contract depends on, and an Effect would only make them harder to
 *   read and to test.
 *
 * The three independent collections are read with `Effect.all` rather than
 * `Promise.all`, which is the same shape in a runtime that can also be
 * interrupted. The per-possibility loop keeps the same bound as the rest of the
 * app: see `REFERENCE_CONCURRENCY` in `./catalogue.ts` for why it is a number
 * and not `unbounded`.
 */
export function buildCatalogue(
	options: { site?: string; now?: Date } = {},
): Effect.Effect<Catalogue, EmDashReadError, EmDashContent> {
	return Effect.gen(function* () {
		const { possibilities } = yield* loadPossibilities();
		const [{ collections }, ratings, reports] = yield* Effect.all([
			loadCollections(),
			loadRatings(),
			loadReports(),
		]);
		const aggregates = aggregateBySubject(ratings);

		/*
		 * The example graph is read **once**, not once per possibility.
		 *
		 * `loadExamplesFor(slug)` is `loadExampleGraph()` indexed by slug — and
		 * `loadExampleGraph` reads the whole `examples` collection and then issues one
		 * single-entry read per example to resolve its `possibility` reference, because
		 * that reference has no column and the list route cannot resolve it. Calling it
		 * from inside the per-possibility loop therefore rebuilt the entire graph 34
		 * times: about **1,190 subrequests** for 34 possibilities, quadratic in the
		 * catalogue, which is why rebuilding `/api/catalogue.json` took 99-117 seconds
		 * and why bounding a single read barely dented it.
		 *
		 * The fix is not clever, it is just hoisting: one graph, read once, indexed by
		 * the slug the loop already has. Roughly 1,190 subrequests becomes about 35.
		 *
		 * The lesson is the shape, not the hoist. Every other loader in this function is
		 * called once — `loadCollections`, `loadRatings`, `loadReports` — and that is why
		 * they look obviously right. This one had a per-item signature, so per-item use
		 * looked equally obvious, and nobody costed it because nothing failed loudly:
		 * it was just slow, intermittently wrong, and cached often enough to hide both.
		 */
		const exampleGraph = yield* loadExampleGraph();

		const serialised = possibilities.map((possibility) => {
			const aggregate =
				aggregates.get(`possibility:${possibility.slug}`) ?? aggregateRatings([]);
			return serialisePossibility(possibility, exampleGraph[possibility.slug] ?? [], aggregate);
		});
		serialised.sort((a, b) => a.id.localeCompare(b.id));

		const rights: Record<string, number> = {};
		const verticals = new Set<string>();
		let exampleCount = 0;
		for (const p of serialised) {
			const status = p.rightsStatus ?? "unstated";
			rights[status] = (rights[status] ?? 0) + 1;
			if (p.vertical) verticals.add(p.vertical);
			exampleCount += p.examples.length;
		}

		// Clock-driven rather than `new Date()` buried in a formatter, so the value is
		// a dependency a test can control. An explicit `now` still wins, which is what
		// makes a build reproducible.
		const generated = options.now ?? (yield* DateTime.nowAsDate);

		return {
			schema: CATALOGUE_SCHEMA,
			site: options.site ?? "https://assets.loftwah.com",
			generated: generated.toISOString(),
			counts: {
				possibilities: serialised.length,
				examples: exampleCount,
				collections: collections.length,
				verticals: verticals.size,
				rights,
			},
			fingerprint: fingerprint(serialised),
			possibilities: serialised,
			collections: collections
				.map((c) => ({
					id: c.slug,
					title: c.title,
					tagline: c.tagline ?? null,
					members: c.members.map((m) => m.slug),
				}))
				.sort((a, b) => a.id.localeCompare(b.id)),
		} satisfies Catalogue;
	});
}

/** Open reports, for the agent to know what is already known to be wrong. */
export function openReportCount(): Effect.Effect<number, EmDashReadError, EmDashContent> {
	return loadReports().pipe(Effect.map((reports) => reports.filter((r) => !r.resolution).length));
}
