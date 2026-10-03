/**
 * Schemas for what the engine reads from outside itself (#62).
 *
 * Two sources, both untrusted:
 *
 * 1. **The GitHub API.** A third party that changes its response shape between
 *    releases, paginates differently, and returns `null` for fields a repository
 *    simply has not set. The old client cast every response:
 *    `const body = await this.get<{ default_branch?: string }>(...)` and then
 *    read `body.default_branch`. A cast on a third-party response is a promise
 *    that the third party agreed, made without asking.
 * 2. **The publish payload.** `engine/state/payload.json` is written by one run
 *    and read by the next, possibly by a different version of the engine, and
 *    possibly truncated by a full disk. It is decoded before it is trusted —
 *    `decodePayload` in `./publish.ts`.
 *
 * The rule throughout: a field that arrives with the wrong shape is a typed
 * failure naming the response, never a value that happens to be `undefined` and
 * then gets written to the public catalogue.
 *
 * ## v4 note
 *
 * `Schema.withDecodingDefault*` is broken in `effect@4.0.0` (it produces a schema
 * whose AST is `undefined` and the compiler throws `Invalid value used as weak
 * map key`). Absent-means-null is expressed with
 * `Schema.optional(Schema.NullOr(X))` plus a projection. `Schema.Union` takes an
 * array of members, not varargs.
 */
import { Schema } from "effect";

/** Text that may be absent, explicitly null, or a string. GitHub returns both. */
export const Text = Schema.optional(Schema.NullOr(Schema.String));

/** A number GitHub may send as a number or as a string. */
const Count = Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.NumberFromString])));

/** The `license` object on a repository. `null` means "GitHub found no licence". */
const RepoLicense = Schema.optional(
	Schema.NullOr(
		Schema.Struct({
			spdx_id: Text,
			name: Text,
		}),
	),
);

/** One row of `/search/repositories`. */
export const SearchItem = Schema.Struct({
	full_name: Schema.String,
	description: Text,
	stargazers_count: Count,
	license: RepoLicense,
	topics: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
	default_branch: Text,
	html_url: Schema.String,
	updated_at: Text,
	pushed_at: Text,
	archived: Schema.optional(Schema.NullOr(Schema.Boolean)),
	fork: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

export const SearchResponse = Schema.Struct({
	items: Schema.optional(Schema.NullOr(Schema.Array(SearchItem))),
});

/** `GET /repos/{owner}/{repo}`. */
export const RepoResponse = Schema.Struct({
	default_branch: Text,
	pushed_at: Text,
});

/**
 * The repository document a cheap pre-check reads (#41).
 *
 * Six fields, and each one is a signal `planRefresh` acts on. Declared
 * separately from `RepoResponse` rather than widened into it because the two are
 * read for different jobs: `RepoResponse` answers "which commit do I pin the
 * evidence to", and this one answers "is there any reason to spend a download".
 * A schema that grew both would make a pre-check look like a full inspection.
 *
 * `full_name` is in the list for a reason that is not cosmetic: GitHub follows a
 * renamed repository's old path with a redirect, so this is the only place the
 * canonical name is visible. Reading it is what lets a refresh notice that
 * `owner/old-name` is now `owner/new-name` instead of recording a 404 for a
 * repository that plainly exists.
 */
export const ObservationResponse = Schema.Struct({
	full_name: Schema.String,
	pushed_at: Text,
	archived: Schema.optional(Schema.NullOr(Schema.Boolean)),
	fork: Schema.optional(Schema.NullOr(Schema.Boolean)),
	default_branch: Text,
	stargazers_count: Count,
});

/**
 * `GET /repos/{owner}/{repo}/commits/{ref}`.
 *
 * `/commits/{ref}` returns `sha` at the top level; `/git/ref/{ref}` returns it
 * under `object`. Reading the wrong one made every candidate record a branch
 * name as its "commit", which is provenance that proves nothing — so both shapes
 * are declared and the projection picks.
 */
export const CommitResponse = Schema.Struct({
	sha: Text,
	object: Schema.optional(Schema.NullOr(Schema.Struct({ sha: Text }))),
});

/** One node of a recursive git tree. */
export const TreeNode = Schema.Struct({
	path: Text,
	size: Count,
	sha: Text,
	type: Text,
});

export const TreeResponse = Schema.Struct({
	tree: Schema.optional(Schema.NullOr(Schema.Array(TreeNode))),
});

/** `GET /repos/{owner}/{repo}/contents/{path}`. Content is base64, as served. */
export const ContentsResponse = Schema.Struct({
	content: Text,
	sha: Text,
	size: Count,
	url: Text,
});

/**
 * The body EmDash returns when an entry is read back for its revision token.
 *
 * Declared here rather than imported from `src/lib/effect/schemas.ts` because
 * `docs/ARCHITECTURE.md` requires the engine not to import app code: the boundary
 * between them is a documented HTTP contract, not a shared module. One shape, two
 * declarations, and the test that both agree is the reason it is written down.
 *
 * The record is nested at `data.item.data` and the token sits *beside* the item at
 * `data._rev`. Reading `item._rev` yields `undefined`, which made the sync fall
 * through to the create path and fail with SLUG_CONFLICT on an entry that plainly
 * existed.
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
							/**
							 * The two halves of the `_rev` token.
							 *
							 * The route does not return `_rev` in the body — it is a header — so
							 * `revFromToken` reconstructs it from exactly what the token is
							 * built from. See `EmDashApi.read` for what went wrong when this was
							 * read as `data._rev` and came back `undefined` on every entry.
							 */
							version: Schema.optional(Schema.Number),
							updatedAt: Schema.optional(Schema.String),
						}),
					),
				),
				_rev: Schema.optional(Schema.String),
			}),
		),
	),
});

/**
 * The `_rev` token EmDash's write path expects: `base64("<version>:<updatedAt>")`.
 *
 * Reconstructed here rather than read, because the GET route does not put it in
 * the body. This is the same construction `encodeRev` performs in
 * `emdash/src/api/rev.ts`, and it is deliberately duplicated rather than imported:
 * `docs/ARCHITECTURE.md` forbids the engine depending on CMS internals, and a
 * token format is exactly the kind of detail that should break loudly if it
 * changes rather than silently returning `null`.
 *
 * Returning `null` is the failure this replaced. With `rev` always null the engine
 * POSTed instead of PUTing, so every sync wrote a fresh revision of every entry
 * whether or not anything had changed — no version conflict could ever be
 * detected, and `sync` reported `updated` for a payload identical to the one
 * before it.
 */
export function revFromToken(version: unknown, updatedAt: unknown): string | null {
	if (typeof version !== "number" || typeof updatedAt !== "string" || !updatedAt) return null;
	return Buffer.from(`${version}:${updatedAt}`, "utf8").toString("base64");
}
