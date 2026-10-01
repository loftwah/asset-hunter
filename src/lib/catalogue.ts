/**
 * Catalogue access layer.
 *
 * Every public read goes through EmDash (`getEmDashCollection` /
 * `getEmDashEntry`). There is deliberately no static JSON fallback and no local
 * mirror of the catalogue: if EmDash is not serving the data, the page should
 * show its empty state rather than quietly rendering something else.
 */
import { getEmDashCollection, getEmDashEntry } from "emdash";

export interface Possibility {
	slug: string;
	title: string;
	tagline?: string | null;
	summary?: string | null;
	technique?: string | null;
	vertical?: string | null;
	mediaKind?: string | null;
	specimen?: string | null;
	image?: { id: string; src?: string; alt?: string } | null;
	representativeOrigin?: string | null;
	rightsStatus?: string | null;
	rightsNote?: string | null;
	buildNotes?: string | null;
	promptScaffold?: string | null;
	exampleCount?: number | null;
	distinctSources?: number | null;
	novelty?: number | null;
	coverage?: number | null;
	editorialRank?: number | null;
	featured?: boolean | null;
}

export interface Example {
	slug: string;
	title: string;
	origin?: string | null;
	mediaKind?: string | null;
	specimen?: string | null;
	image?: { id: string; src?: string; alt?: string } | null;
	rightsStatus?: string | null;
	rightsNote?: string | null;
	note?: string | null;
	sourceUrl?: string | null;
	sourceRepo?: string | null;
	sourceRef?: string | null;
	sourcePath?: string | null;
	licenceSpdx?: string | null;
	licenceEvidence?: string | null;
	attribution?: string | null;
	contentHash?: string | null;
	downloadable?: boolean | null;
}

export interface CuratedCollection {
	slug: string;
	title: string;
	tagline?: string | null;
	summary?: string | null;
	members: Possibility[];
}

interface RawEntry {
	id: string;
	data: Record<string, unknown>;
	references?: Record<string, { entries?: unknown[] } | null>;
}

function mapPossibility(entry: RawEntry): Possibility {
	const d = entry.data as Record<string, never>;
	return {
		slug: entry.id,
		title: (d.title as string) ?? entry.id,
		tagline: (d.tagline as string) ?? null,
		summary: (d.summary as string) ?? null,
		technique: (d.technique as string) ?? null,
		vertical: (d.vertical as string) ?? null,
		mediaKind: (d.media_kind as string) ?? null,
		specimen: (d.specimen as string) ?? null,
		image: (d.image as Possibility["image"]) ?? null,
		representativeOrigin: (d.representative_origin as string) ?? null,
		rightsStatus: (d.rights_status as string) ?? null,
		rightsNote: (d.rights_note as string) ?? null,
		buildNotes: (d.build_notes as string) ?? null,
		promptScaffold: (d.prompt_scaffold as string) ?? null,
		exampleCount: (d.example_count as number) ?? null,
		distinctSources: (d.distinct_sources as number) ?? null,
		novelty: (d.novelty as number) ?? null,
		coverage: (d.coverage as number) ?? null,
		editorialRank: (d.editorial_rank as number) ?? null,
		featured: (d.featured as boolean) ?? null,
	};
}

function mapExample(entry: RawEntry): Example {
	const d = entry.data as Record<string, never>;
	return {
		slug: entry.id,
		title: (d.title as string) ?? entry.id,
		origin: (d.origin as string) ?? null,
		mediaKind: (d.media_kind as string) ?? null,
		specimen: (d.specimen as string) ?? null,
		image: (d.image as Example["image"]) ?? null,
		rightsStatus: (d.rights_status as string) ?? null,
		rightsNote: (d.rights_note as string) ?? null,
		note: (d.note as string) ?? null,
		sourceUrl: (d.source_url as string) ?? null,
		sourceRepo: (d.source_repo as string) ?? null,
		sourceRef: (d.source_ref as string) ?? null,
		sourcePath: (d.source_path as string) ?? null,
		licenceSpdx: (d.licence_spdx as string) ?? null,
		licenceEvidence: (d.licence_evidence as string) ?? null,
		attribution: (d.attribution as string) ?? null,
		contentHash: (d.content_hash as string) ?? null,
		downloadable: (d.downloadable as boolean) ?? null,
	};
}

/**
 * The media URL for an entry. Prefers a CMS-managed image (R2) and falls back
 * to the repo-shipped specimen plate. The `image` field is an object, not a
 * string — this is the most common EmDash integration mistake, so it is
 * resolved in exactly one place.
 */
/**
 * The narrow shape `mediaSrc` needs. Accepting a structural type rather than
 * `Possibility | Example` keeps the helper usable for any entry carrying media.
 * The `id` field is part of EmDash's real image shape and is listed so fixtures
 * reflect what the runtime actually returns.
 */
export interface MediaBearing {
	specimen?: string | null;
	image?: { id?: string; src?: string } | null;
}

export function mediaSrc(
	entry: MediaBearing,
	fallback = "/specimens/placeholder.svg",
): string {
	return entry.image?.src || entry.specimen || fallback;
}

/**
 * Loads the catalogue wall. Ordering is editorial rank first, then the machine
 * observation, so a human decision leads and popularity never silently erases a
 * novel possibility.
 */
export async function loadPossibilities(options: { limit?: number; cursor?: string } = {}) {
	const { entries, nextCursor, cacheHint } = await getEmDashCollection("possibilities", {
		status: "published",
		limit: options.limit ?? 100,
		cursor: options.cursor,
		orderBy: { editorial_rank: "desc" },
	});
	const possibilities = (entries as unknown as RawEntry[]).map(mapPossibility);
	// Editorial rank may be null on entries that predate the field; fall back to
	// title so ordering stays deterministic rather than database-dependent.
	possibilities.sort((a, b) => (b.editorialRank ?? 0) - (a.editorialRank ?? 0) || a.title.localeCompare(b.title));
	return { possibilities, nextCursor, cacheHint };
}

export async function loadPossibility(slug: string) {
	const { entry, cacheHint } = await getEmDashEntry("possibilities", slug);
	return { possibility: entry ? mapPossibility(entry as unknown as RawEntry) : null, cacheHint };
}

/**
 * Examples for one possibility. The parent link is a `reference` field, which
 * has no filterable column, so the join is made on the resolved references
 * that only `getEmDashEntry`'s `references` option provides.
 */
export async function loadExamplesFor(possibilitySlug: string) {
	const { entries } = await getEmDashCollection("examples", {
		status: "published",
		limit: 100,
	});
	const list = entries as unknown as RawEntry[];

	const matching: Example[] = [];
	for (const entry of list) {
		const { entry: full } = await getEmDashEntry("examples", entry.id, {
			references: { possibility: true },
		});
		const source = (full ?? entry) as RawEntry;
		const refs = source.references?.possibility?.entries ?? [];
		if (refs.some((r) => (r as RawEntry).id === possibilitySlug)) {
			matching.push(mapExample(source));
		}
	}
	return { examples: matching };
}

/**
 * Collections carry their members in a `reference` field, and EmDash only
 * resolves reference fields through `getEmDashEntry`'s `references` option —
 * the collection query has no equivalent. So members are fetched per entry.
 *
 * Members are fetched per collection, which is acceptable at catalogue scale;
 * the alternative — a second bespoke query against the link table — would
 * bypass EmDash's own resolution and is exactly what the project policy
 * forbids.
 */
export async function loadCollections() {
	const { entries, nextCursor, cacheHint } = await getEmDashCollection("collections", {
		status: "published",
		limit: 50,
	});

	const list = entries as unknown as RawEntry[];
	const collections: CuratedCollection[] = [];

	for (const entry of list) {
		const d = entry.data as Record<string, never>;
		const { entry: full } = await getEmDashEntry("collections", entry.id, {
			references: { members: { limit: 50 } },
		});
		const source = (full ?? entry) as RawEntry;
		const memberEntries = (source.references?.members?.entries ?? []) as RawEntry[];
		collections.push({
			slug: entry.id,
			title: (d.title as string) ?? entry.id,
			tagline: (d.tagline as string) ?? null,
			summary: (d.summary as string) ?? null,
			members: memberEntries.map(mapPossibility),
		});
	}
	return { collections, nextCursor, cacheHint };
}

export async function loadCollection(slug: string) {
	const { collections } = await loadCollections();
	return collections.find((c) => c.slug === slug) ?? null;
}

/** Vertical tallies derived from the loaded catalogue, ordered by count. */
export function tallyVerticals(possibilities: Possibility[]) {
	const counts = new Map<string, number>();
	for (const p of possibilities) {
		if (!p.vertical) continue;
		counts.set(p.vertical, (counts.get(p.vertical) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([slug, count]) => ({ slug, count }))
		.sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}
