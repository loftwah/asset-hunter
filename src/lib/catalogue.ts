/**
 * Catalogue access layer.
 *
 * Every public read goes through EmDash. There is deliberately no static JSON
 * fallback and no local mirror of the catalogue: if EmDash is not serving the
 * data, the page should show its empty state rather than quietly rendering
 * something else.
 *
 * ## What changed in #62, and what did not
 *
 * **The reads are Effects now.** Each loader names {@link EmDashContent} in its
 * `R` channel instead of importing `emdash` and awaiting it, which means:
 *
 * - a failed query is a typed failure rather than an empty array. EmDash
 *   reports a database error as a *resolved* value with `error` set, so the old
 *   `const { entries } = await getEmDashCollection(...)` rendered a confident,
 *   empty catalogue when D1 was down. See `./effect/emdash.ts`;
 * - a read has a timeout, and the caller decides what a timeout means;
 * - a reader who hangs up cancels the reads rather than orphaning them;
 * - a test can supply a layer and exercise the projection without a database.
 *
 * **The model is still plain TypeScript.** `Possibility`, `Example`,
 * `CuratedCollection`, `mediaSrc` and `tallyVerticals` are synchronous,
 * deterministic and have no business being Effects. The projections below are
 * pure functions from a *validated* row to the view model; the validation is the
 * Effect part and it lives in `./effect/schemas.ts`.
 *
 * **The row→view cast is gone.** It used to be twenty `as string` / `as number`
 * assertions over an untrusted `data` bag, which is a claim about the data made
 * without checking it. The schemas accept the forms D1 actually produces (see
 * `LooseNumber` / `LooseBoolean`) and a field of the wrong shape is now a
 * failure rather than a value that looks plausible on a public page.
 */
import { Effect } from "effect";
import type { CacheHint } from "emdash";
import { EmDashContent } from "./effect/emdash.ts";
import { CatalogueDecodeError, EmDashTransportError } from "./effect/errors.ts";
import { decodeOr } from "./effect/decode.ts";
import {
	CollectionData,
	ExampleData,
	PossibilityData,
	type RawEntryValue,
} from "./effect/schemas.ts";

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
	/**
	 * Whether this example retains a payload Asset Hunter may hand over.
	 *
	 * Always a real boolean, because the field is a CMS boolean that round-trips
	 * as `0`/`1` on some paths and a `downloadable: 1` that reads as truthy is
	 * how an example ends up offering a download nobody authorised. The coercion
	 * happens here, once, so every reader of the model gets the same answer.
	 */
	downloadable: boolean;
}

export interface CuratedCollection {
	slug: string;
	title: string;
	tagline?: string | null;
	summary?: string | null;
	members: Possibility[];
}

/**
 * Reads a CMS boolean field as a boolean.
 *
 * Applied once, here, at the boundary, so every reader of the model gets the
 * same answer: a boolean column round-trips as `0`/`1` on some paths, and one
 * reader treating `1` as false while another treats it as true is how a
 * "downloadable" example ends up being served when a person switched it off.
 * `true`, `1` and `"1"` are the only affirmative values; a missing field is
 * `false`, because absence is not permission.
 */
export function flagValue(value: unknown): boolean {
	return value === true || value === 1 || value === "1";
}

/**
 * Every read in this module needs the CMS reader and nothing else, and fails
 * with one of exactly two things: the CMS could not be reached, or it returned a
 * row this application cannot honestly interpret.
 */
type CatalogueRead<A> = Effect.Effect<
	A,
	EmDashTransportError | CatalogueDecodeError,
	EmDashContent
>;

/**
 * How many reference lookups run at once.
 *
 * EmDash resolves `reference` fields only through `getEmDashEntry`, so listing a
 * possibility's examples costs one query per example. That is the N+1 this
 * project pays on purpose — the alternative is a bespoke query against EmDash's
 * own link table, which bypasses the CMS's resolution and is what
 * `docs/ARCHITECTURE.md` forbids. Doing the N+1 *sequentially* is a separate
 * choice and a bad one: at catalogue scale a wall rebuild spends most of its
 * time waiting rather than working.
 *
 * Eight is a deliberate number, not `unbounded`. These are D1 reads on the same
 * binding as the rest of the request, inside a Worker with a subrequest budget,
 * so the bound keeps the fan-out inside it. Raise it with the budget, not with
 * taste.
 */
export const REFERENCE_CONCURRENCY = 8;

/** `undefined` and `null` are the same absence here, and null is the answer. */
const text = (value: string | null | undefined): string | null => value ?? null;

/** A number D1 may have stored as text. See `LooseNumber` for why it is not parsed here. */
type LooseMeasure = number | string | null | undefined;

/**
 * What a machine observation is allowed to be.
 *
 * Three rules, in order, and each one has a reason that is about honesty rather
 * than tidiness:
 *
 * 1. **Absent is `null`.** Not `0`. A `0` here is a claim that something was
 *    measured and came to nothing; the wall says "not measured" instead, and the
 *    JSON contract's `null` is how a consumer tells the difference.
 * 2. **Blank is `null`.** `Number("")` is `0`, so a cleared CMS field would
 *    otherwise be published as a measurement of exactly zero.
 * 3. **Unparseable is `null`, not `NaN`.** `NaN` renders as an empty string on the
 *    page and poisons any average it reaches.
 *
 * Exported because the rule is worth stating in a test rather than only in a
 * comment, and because the engine's payload builder makes the same promise.
 */
export function toMeasure(value: LooseMeasure): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

/** `measure` reads better at the call site than the shape it accepts. */
const measure = toMeasure;

const decodePossibilityRow = decodeOr(PossibilityData, "possibility row");
const decodeExampleRow = decodeOr(ExampleData, "example row");
const decodeCollectionRow = decodeOr(CollectionData, "collection row");

/** Projects a validated possibility row onto the view model. Pure. */
function toPossibility(entry: RawEntryValue): Effect.Effect<
	Possibility,
	CatalogueDecodeError
> {
	return decodePossibilityRow(recordOf(entry)).pipe(
		Effect.map((d) => ({
			slug: entry.id,
			title: d.title ?? entry.id,
			tagline: text(d.tagline),
			summary: text(d.summary),
			technique: text(d.technique),
			vertical: text(d.vertical),
			mediaKind: text(d.media_kind),
			specimen: text(d.specimen),
			image: d.image ?? null,
			representativeOrigin: text(d.representative_origin),
			rightsStatus: text(d.rights_status),
			rightsNote: text(d.rights_note),
			buildNotes: text(d.build_notes),
			promptScaffold: text(d.prompt_scaffold),
			exampleCount: measure(d.example_count),
			distinctSources: measure(d.distinct_sources),
			novelty: measure(d.novelty),
			coverage: measure(d.coverage),
			editorialRank: measure(d.editorial_rank),
			featured: d.featured === undefined || d.featured === null ? null : flagValue(d.featured),
		})),
		// Name the record that failed. A `SchemaError` says which field; this says
		// which entry, which is the part a log line needs and the part a decoder
		// cannot know.
		Effect.mapError((error) => new CatalogueDecodeError({ subject: entry.id, detail: error.detail })),
	);
}

/** Projects a validated example row onto the view model. Pure. */
function toExample(entry: RawEntryValue): Effect.Effect<Example, CatalogueDecodeError> {
	return decodeExampleRow(recordOf(entry)).pipe(
		Effect.map((d) => ({
			slug: entry.id,
			title: d.title ?? entry.id,
			origin: text(d.origin),
			mediaKind: text(d.media_kind),
			specimen: text(d.specimen),
			image: d.image ?? null,
			rightsStatus: text(d.rights_status),
			rightsNote: text(d.rights_note),
			note: text(d.note),
			sourceUrl: text(d.source_url),
			sourceRepo: text(d.source_repo),
			sourceRef: text(d.source_ref),
			sourcePath: text(d.source_path),
			licenceSpdx: text(d.licence_spdx),
			licenceEvidence: text(d.licence_evidence),
			attribution: text(d.attribution),
			contentHash: text(d.content_hash),
			downloadable: flagValue(d.downloadable),
		})),
		Effect.mapError((error) => new CatalogueDecodeError({ subject: entry.id, detail: error.detail })),
	);
}

/** EmDash's `data` is untrusted; a row whose data is not an object has no fields. */
const recordOf = (entry: RawEntryValue): unknown => entry.data;

/** Reference entries as ids, for the parent/member joins. */
const referenceIds = (entry: RawEntryValue, field: string): ReadonlyArray<string> => {
	const page = entry.references?.[field];
	if (!page || !Array.isArray(page.entries)) return [];
	return page.entries
		.map((row) => (typeof row === "object" && row !== null ? (row as { id?: unknown }).id : null))
		.filter((id): id is string => typeof id === "string");
};

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
export function loadPossibilities(
	options: { limit?: number; cursor?: string } = {},
): CatalogueRead<{
	possibilities: Possibility[];
	nextCursor: string | null;
	cacheHint: CacheHint | undefined;
}> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const page = yield* emdash.collection("possibilities", {
			limit: options.limit ?? 100,
			cursor: options.cursor,
			orderBy: { editorial_rank: "desc" },
		});
		const possibilities = yield* Effect.forEach(page.entries, toPossibility);
		// Editorial rank may be null on entries that predate the field; fall back to
		// title so ordering stays deterministic rather than database-dependent.
		possibilities.sort(
			(a, b) =>
				(b.editorialRank ?? 0) - (a.editorialRank ?? 0) || a.title.localeCompare(b.title),
		);
		return {
			possibilities,
			nextCursor: page.nextCursor,
			cacheHint: page.cacheHint,
		};
	});
}

export function loadPossibility(slug: string): CatalogueRead<{
	possibility: Possibility | null;
	cacheHint: CacheHint | undefined;
}> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const found = yield* emdash.entry("possibilities", slug);
		return {
			possibility: found.entry ? yield* toPossibility(found.entry) : null,
			cacheHint: found.cacheHint,
		};
	});
}

/**
 * One example, by its own id.
 *
 * The asset-use flow needs a single example rather than a possibility's worth of
 * them — a payload request names one asset. It reads through the same
 * `EmDashContent.entry` the drill-in uses for a possibility, so the use page, the
 * drill-in and the payload route are all looking at one canonical record rather
 * than three views of it.
 */
export function loadExample(id: string): CatalogueRead<Example | null> {
	if (!id) return Effect.succeed(null);
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const found = yield* emdash.entry("examples", id);
		return found.entry ? yield* toExample(found.entry) : null;
	});
}

/**
 * Examples for one possibility. The parent link is a `reference` field, which
 * has no filterable column, so the join is made on the resolved references
 * that only `getEmDashEntry`'s `references` option provides.
 */
export function loadExamplesFor(possibilitySlug: string): CatalogueRead<{ examples: Example[] }> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const page = yield* emdash.collection("examples", { limit: 100 });
		// Bounded fan-out; see `REFERENCE_CONCURRENCY`. `Effect.forEach` preserves
		// input order in the result, so the example list is still ordered by the
		// collection's own order rather than by which query returned first.
		const resolved = yield* Effect.forEach(
			page.entries,
			(entry) =>
				Effect.gen(function* () {
					const found = yield* emdash.entry("examples", entry.id, {
						references: { possibility: true },
					});
					// A reference that failed to resolve is not a reason to drop the
					// example: the collection row is still the canonical record, and a
					// missing parent link is a CMS gap rather than a wrong answer.
					const source = found.entry ?? entry;
					return referenceIds(source, "possibility").includes(possibilitySlug)
						? yield* toExample(source)
						: null;
				}),
			{ concurrency: REFERENCE_CONCURRENCY },
		);
		return { examples: resolved.filter((example): example is Example => example !== null) };
	});
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
export function loadCollections(): CatalogueRead<{
	collections: CuratedCollection[];
	nextCursor: string | null;
	cacheHint: CacheHint | undefined;
}> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const page = yield* emdash.collection("collections", { limit: 50 });
		const collections = yield* Effect.forEach(
			page.entries,
			(entry) =>
				Effect.gen(function* () {
					const found = yield* emdash.entry("collections", entry.id, {
						references: { members: { limit: 50 } },
					});
					const source = found.entry ?? entry;
					const fields = yield* decodeCollectionRow(recordOf(source)).pipe(
						Effect.mapError((error) =>
							new CatalogueDecodeError({ subject: entry.id, detail: error.detail }),
						),
					);
					const members = yield* Effect.forEach(
						(source.references?.members?.entries ?? []).filter(
							(row): row is RawEntryValue => typeof row === "object" && row !== null,
						),
						toPossibility,
						{ concurrency: REFERENCE_CONCURRENCY },
					);
					return {
						slug: entry.id,
						title: fields.title ?? entry.id,
						tagline: text(fields.tagline),
						summary: text(fields.summary),
						members: [...members],
					} satisfies CuratedCollection;
				}),
			{ concurrency: REFERENCE_CONCURRENCY },
		);
		return {
			collections: [...collections],
			nextCursor: page.nextCursor,
			cacheHint: page.cacheHint,
		};
	});
}

export function loadCollection(slug: string): CatalogueRead<CuratedCollection | null> {
	return loadCollections().pipe(
		Effect.map(({ collections }) => collections.find((c) => c.slug === slug) ?? null),
	);
}

/** Vertical tallies derived from the loaded catalogue, ordered by count. Pure. */
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
