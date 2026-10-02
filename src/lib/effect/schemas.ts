/**
 * The catalogue's read contract, as Schema (#62).
 *
 * Everything in this file describes data this application did **not** produce.
 * EmDash's collection rows come out of a database that a person edits in an
 * admin; the ratings collection is written over HTTP; the publish payload is read
 * off disk from a previous run. All of it is untrusted input, and the old code
 * said so with casts:
 *
 * ```ts
 * const d = entry.data as Record<string, never>
 * exampleCount: (d.example_count as number) ?? null
 * ```
 *
 * A cast is a claim that the data is already the right shape, made without
 * checking. Where it was wrong the result was silent: `example_count: "12"`
 * became the string `"12"`, `"cleared "` with a trailing space indexed a rights
 * table and came back `undefined`, and `featured: 0` from D1 became falsy in
 * some paths and truthy in others. The machine observations on the wall are read
 * by strangers, so a wrong one is a wrong claim rather than a bug.
 *
 * The rules these schemas encode:
 *
 * 1. **Absent is `null`, not `0`.** Every nullable field is
 *    `Schema.optional(Schema.NullOr(...))` and the projection decides what a
 *    missing measurement means. A number that was never measured must not
 *    become a zero, which is an assertion the product makes out loud.
 * 2. **D1's shapes are accepted explicitly.** EmDash stores some numbers as
 *    strings and booleans as `0`/`1`, so the numeric and boolean fields are
 *    unions of the forms the runtime actually produces rather than one guess.
 * 3. **A field with the wrong type is a failure, not a coercion.** Decoding is
 *    the boundary; past it the types are real.
 *
 * ## Two v4 notes worth knowing before editing
 *
 * - `Schema.withDecodingDefault*` (all four variants) and `Schema.Defect` are
 *   broken in `effect@4.0.0`: they produce a schema whose AST is `undefined`,
 *   and the compiler registry throws `Invalid value used as weak map key` on
 *   first use. So "absent means null" is expressed with
 *   `Schema.optional(Schema.NullOr(X))` plus a projection, never with a decoding
 *   default. Do not "simplify" these into `withDecodingDefaultKey`.
 * - `Schema.Union` takes an **array** of members in v4, not varargs.
 */
import { Schema } from "effect";

/**
 * A number as D1 hands it over — *shaped*, not yet converted.
 *
 * The schema accepts a number or numeric text and the projection decides what the
 * text means. That split is deliberate and it is a response to a real limitation:
 *
 * - `Schema.NumberFromString` decodes `"nope"` to `NaN` and `""` to `0`, both of
 *   which are success. Turning a blank or mistyped column into `0` is precisely
 *   the failure this catalogue must never have — `0` is a claim that something was
 *   measured.
 * - `Schema.withDecodingDefault*` and `Schema.decodeTo(..., { decode })` are both
 *   broken in `effect@4.0.0`: the first builds a schema whose AST is `undefined`
 *   (`Invalid value used as weak map key`), the second is called as a function it
 *   is not. So there is no clean way to say "a string that is a number" in-schema
 *   at this version.
 *
 * Keeping the raw text until `toMeasure` in `src/lib/catalogue.ts` loses nothing,
 * and puts the rule — blank is not zero, unparseable is not zero — in one named
 * function with its own tests.
 */
export const LooseNumber = Schema.Union([Schema.Number, Schema.String]);

/**
 * A flag as D1 hands it over: `true`, `1`, `0` or `"1"`.
 *
 * `BooleanFromBit` covers the integer forms. `"1"` stays a string rather than
 * becoming `true` here, because a `Union` matches its first member that fits and
 * converting here would hide which form D1 actually used. `flagValue` in
 * `src/lib/catalogue.ts` is the one reader, and it is the only reader.
 */
export const LooseBoolean = Schema.Union([
	Schema.Boolean,
	Schema.BooleanFromBit,
	Schema.Literal("1"),
]);

/** Text that may be absent, explicitly null, or a string. */
export const Text = Schema.optional(Schema.NullOr(Schema.String));

/** A measurement that may be absent, explicitly null, or a number. */
export const Measure = Schema.optional(Schema.NullOr(LooseNumber));

/** A flag that may be absent, explicitly null, or a boolean. */
export const Flag = Schema.optional(Schema.NullOr(LooseBoolean));

/**
 * A CMS-managed image.
 *
 * An object, never a string. This is the most common EmDash integration mistake
 * in the repo's history — passing it straight through produced
 * `/specimens/[object Object]` — so the schema says `id: string` and the
 * projection is the single place that decides what to render.
 */
export const MediaImage = Schema.optional(
	Schema.NullOr(
		Schema.Struct({
			id: Schema.String,
			src: Schema.optional(Schema.String),
			alt: Schema.optional(Schema.String),
		}),
	),
);

/** A CMS reference field, as `getEmDashEntry`'s `references` option returns it. */
export const ReferenceEntries = Schema.optional(
	Schema.NullOr(
		Schema.Struct({
			entries: Schema.optional(Schema.Array(Schema.Unknown)),
			nextCursor: Schema.optional(Schema.String),
		}),
	),
);

/**
 * One row of an EmDash collection, before any field is interpreted.
 *
 * `data` is left as `unknown` on purpose. The per-collection field sets are
 * declared where they are known, and a collection whose fields this application
 * has no contract for still decodes.
 */
export const RawEntry = Schema.Struct({
	id: Schema.String,
	data: Schema.Unknown,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
	references: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, ReferenceEntries))),
});

/** A decoded collection row. `data` is still untrusted until a projection runs. */
export type RawEntryValue = typeof RawEntry.Type;

/** The fields a possibility row is contractually allowed to carry. */
export const PossibilityData = Schema.Struct({
	title: Schema.optional(Schema.String),
	tagline: Text,
	summary: Text,
	technique: Text,
	vertical: Text,
	media_kind: Text,
	specimen: Text,
	image: MediaImage,
	representative_origin: Text,
	rights_status: Text,
	rights_note: Text,
	build_notes: Text,
	prompt_scaffold: Text,
	example_count: Measure,
	distinct_sources: Measure,
	novelty: Measure,
	coverage: Measure,
	editorial_rank: Measure,
	featured: Flag,
	visibility: Text,
});

/** The fields an example row is contractually allowed to carry. */
export const ExampleData = Schema.Struct({
	title: Schema.optional(Schema.String),
	origin: Text,
	media_kind: Text,
	specimen: Text,
	image: MediaImage,
	rights_status: Text,
	rights_note: Text,
	note: Text,
	source_url: Text,
	source_repo: Text,
	source_ref: Text,
	source_path: Text,
	licence_spdx: Text,
	licence_evidence: Text,
	attribution: Text,
	content_hash: Text,
	downloadable: Flag,
});

/**
 * The fields a curated collection carries.
 *
 * A collection is three text fields and a reference; the reference is resolved
 * by EmDash and comes back on `references`, not in `data`.
 */
export const CollectionData = Schema.Struct({
	title: Schema.optional(Schema.String),
	tagline: Text,
	summary: Text,
});

/** The fields a rating row carries. Closed sets, because a bad one is a lie. */
export const RatingData = Schema.Struct({
	title: Schema.optional(Schema.String),
	subject_type: Schema.optional(Schema.NullOr(Schema.String)),
	subject_slug: Text,
	stars: Schema.optional(Schema.NullOr(LooseNumber)),
	user_id: Schema.optional(Schema.NullOr(Schema.String)),
	user_email: Text,
	signal: Text,
});

/** The fields a report row carries. */
export const ReportData = Schema.Struct({
	title: Schema.optional(Schema.String),
	subject_type: Schema.optional(Schema.NullOr(Schema.String)),
	subject_slug: Text,
	reason: Schema.optional(Schema.NullOr(Schema.String)),
	detail: Text,
	user_id: Text,
	user_email: Text,
	resolution: Text,
});

/** The body EmDash returns from a successful create. */
export const CreatedEntry = Schema.Struct({
	data: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				item: Schema.optional(
					Schema.NullOr(Schema.Struct({ slug: Schema.optional(Schema.String) })),
				),
			}),
		),
	),
});

/**
 * The body EmDash returns when an entry is read back for its revision token.
 *
 * The record is nested at `data.item.data` and the token sits *beside* the item
 * at `data._rev`. Reading `item._rev` yields `undefined`, which made the engine's
 * sync fall through to the create path and fail with SLUG_CONFLICT on an entry
 * that plainly existed — so the shape is stated here rather than re-guessed.
 */
export const EntryResponse = Schema.Struct({
	success: Schema.optional(Schema.Boolean),
	data: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				item: Schema.optional(
					Schema.NullOr(
						Schema.Struct({
							data: Schema.optional(Schema.NullOr(Schema.Unknown)),
							_rev: Schema.optional(Schema.String),
						}),
					),
				),
				_rev: Schema.optional(Schema.String),
			}),
		),
	),
});
