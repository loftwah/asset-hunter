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

import { loadCollections, loadExamplesFor, loadPossibilities, type Example, type Possibility } from "./catalogue.ts";
import { MEDIA_LABEL, RIGHTS_LABEL, ORIGIN_LABEL, verticalLabel } from "./vocabulary.ts";
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

const truthy = (value: unknown): boolean => value === true || value === 1 || value === "1";

export function serialiseExample(example: Example): CatalogueExample {
	return {
		id: example.slug,
		title: example.title,
		origin: example.origin ?? null,
		originMeaning: example.origin ? (ORIGIN_LABEL[example.origin] ?? null) : null,
		mediaKind: example.mediaKind ?? null,
		media: example.mediaKind ? (MEDIA_LABEL[example.mediaKind] ?? example.mediaKind) : null,
		rightsStatus: example.rightsStatus ?? null,
		rightsLabel: example.rightsStatus ? RIGHTS_LABEL[example.rightsStatus] ?? null : null,
		rightsNote: example.rightsNote ?? null,
		sourceUrl: example.sourceUrl ?? null,
		sourceRepo: example.sourceRepo ?? null,
		sourceRef: example.sourceRef ?? null,
		sourcePath: example.sourcePath ?? null,
		licenceSpdx: example.licenceSpdx ?? null,
		licenceEvidence: example.licenceEvidence ?? null,
		attribution: example.attribution ?? null,
		contentHash: example.contentHash ?? null,
		downloadable: truthy(example.downloadable),
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
		representativeOriginLabel: possibility.representativeOrigin
			? ORIGIN_LABEL[possibility.representativeOrigin] ?? null
			: null,
		rightsStatus: possibility.rightsStatus ?? null,
		rightsLabel: possibility.rightsStatus ? RIGHTS_LABEL[possibility.rightsStatus] ?? null : null,
		rightsNote: possibility.rightsNote ?? null,
		novelty: possibility.novelty ?? null,
		coverage: possibility.coverage ?? null,
		exampleCount: examples.length,
		distinctSources: possibility.distinctSources ?? 0,
		communityRating: { average: rating.average, count: rating.count },
		communityRatingSummary: ratingSummary(rating),
		featured: truthy(possibility.featured),
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
 */
export async function buildCatalogue(options: { site?: string; now?: Date } = {}): Promise<Catalogue> {
	const { possibilities } = await loadPossibilities();
	const [{ collections }, ratings, reports] = await Promise.all([
		loadCollections(),
		loadRatings(),
		loadReports(),
	]);
	const aggregates = aggregateBySubject(ratings);

	const serialised: CataloguePossibility[] = [];
	for (const possibility of possibilities) {
		const { examples } = await loadExamplesFor(possibility.slug);
		const aggregate =
			aggregates.get(`possibility:${possibility.slug}`) ?? aggregateRatings([]);
		serialised.push(serialisePossibility(possibility, examples, aggregate));
	}
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

	return {
		schema: CATALOGUE_SCHEMA,
		site: options.site ?? "https://assets.loftwah.com",
		generated: (options.now ?? new Date()).toISOString(),
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
	};
}

/** Open reports, for the agent to know what is already known to be wrong. */
export async function openReportCount(): Promise<number> {
	const reports = await loadReports();
	return reports.filter((r) => !r.resolution).length;
}