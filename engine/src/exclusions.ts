/**
 * Exclusions — the engine's half of a takedown (#54).
 *
 * A takedown recorded as a tick in an editor's head is worthless, because the next
 * crawl will hand the same repository back and nothing will look wrong: the engine
 * has no memory of the decision. So an exclusion is a *durable, machine-readable
 * row* in EmDash, written once by the rights workflow, and read by every run of
 * `hunt`, `sync` and `verify`. That is the acceptance criterion in #54 stated as
 * code — the exclusion is consulted, not remembered.
 *
 * ## Pure, and separately so
 *
 * Nothing here does I/O. The CMS read lives in `./cli.ts` through `EmDashApi`, and
 * this module only decides what an already-read row means and what it matches. That
 * split is what makes "an exclusion survives a refresh" a testable claim: the plan
 * can be handed a list of exclusions and asserted on without a network or a
 * database, which is the same property `refresh.ts` was built with.
 *
 * ## Matching, precisely
 *
 * Every scope matches a string, and every string is normalised before comparison:
 * lower-cased, whitespace trimmed. Case because GitHub repository names are
 * case-insensitive and `Owner/Repo` and `owner/repo` are the same repository — an
 * exclusion that missed on case would exclude nothing, which is the worst possible
 * outcome for a takedown. Whitespace because a match typed into a form with a
 * trailing space should still mean the repository it names.
 *
 * `path` matches the path **and anything beneath it**, at a `/` boundary. A creator
 * asking for a directory to go should not have to know every file in it, and a
 * boundary match cannot over-reach into a sibling directory whose name merely
 * starts with the same characters.
 */

import type { Candidate } from "./candidates.ts";

/**
 * The scopes, mirroring `EXCLUSION_SCOPES` in `src/lib/disputes.ts`.
 *
 * Declared here rather than imported because `docs/ARCHITECTURE.md` requires the
 * engine not to import app code: the boundary between the two systems is an HTTP
 * contract, not a shared module. One vocabulary, two declarations, and a test that
 * they agree — which is why the strings are written out rather than derived.
 */
export type ExclusionScope = "repository" | "path" | "content-hash" | "example";

export const EXCLUSION_SCOPES: readonly ExclusionScope[] = [
	"repository",
	"path",
	"content-hash",
	"example",
];

/** One exclusion, as the engine reads it. */
export interface Exclusion {
	/** The EmDash slug of the row, for reporting and for lifting one. */
	id: string;
	scope: ExclusionScope;
	/** The exact string this exclusion matches, already normalised. */
	match: string;
	/** The report reason it came from, when one was recorded. */
	reason: string | null;
	/** In force, or lifted and kept for the record. */
	active: boolean;
	recordedAt: string | null;
}

/** One thing the engine is deciding whether to ingest. */
export interface IngestTarget {
	/** `owner/repo`, as GitHub reports it. */
	fullName?: string | null;
	/** `owner/repo/path/to/file`, when the engine knows it. */
	path?: string | null;
	/** The sha256 of the bytes read. */
	contentHash?: string | null;
	/** The catalogue entry this would become or update. */
	exampleSlug?: string | null;
}

const normalise = (value: string | null | undefined): string => String(value ?? "").trim().toLowerCase();

const isScope = (value: unknown): value is ExclusionScope =>
	EXCLUSION_SCOPES.includes(value as ExclusionScope);

/**
 * Projects one EmDash row onto an exclusion, or null when it excludes nothing.
 *
 * Refusing a row with no scope or no match is the important part. Such a row is
 * visible in the admin and would look like protection; matching nothing, it protects
 * nothing while making the catalogue look handled. Same reasoning as `toExclusion`
 * on the app side, and the two are asserted to agree in `tests/takedown.test.ts`.
 */
export function parseExclusion(row: Record<string, unknown>): Exclusion | null {
	const scope = row.scope;
	const match = normalise(row.match as string | null);
	if (!isScope(scope) || !match) return null;
	// A state this build cannot read is treated as active. An exclusion that stops
	// being an exclusion because a column came back blank is the one failure that
	// would undo a takedown silently.
	const active = String(row.state ?? "active") !== "lifted";
	return {
		id: String(row.id ?? ""),
		scope,
		match,
		reason: typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : null,
		active,
		recordedAt: typeof row.recorded_at === "string" ? row.recorded_at : null,
	};
}

/** Every row that can be read, active first. A malformed row is dropped, not fatal. */
export function parseExclusions(rows: readonly Record<string, unknown>[]): Exclusion[] {
	return rows
		.map((row) => parseExclusion({ id: String(row.id ?? ""), ...row }))
		.filter((exclusion): exclusion is Exclusion => exclusion !== null)
		.sort((a, b) => Number(b.active) - Number(a.active) || a.match.localeCompare(b.match));
}

/**
 * Whether an exclusion covers a target.
 *
 * The rules, in order:
 *
 * - `repository` — the target's repository, exactly. Nothing else about that
 *   owner's other repositories is implied, because a takedown is a statement about
 *   a specific source.
 * - `path` — the target's path, exactly, or anything beneath it at a `/` boundary.
 * - `content-hash` — the target's bytes. This is the scope that survives a mirror or
 *   a re-upload under a different name.
 * - `example` — the catalogue entry itself, for material this catalogue generated
 *   and no upstream can be asked about.
 *
 * A lifted exclusion matches nothing.
 */
export function matches(exclusion: Exclusion, target: IngestTarget): boolean {
	if (!exclusion.active) return false;
	switch (exclusion.scope) {
		case "repository":
			return target.fullName !== null && target.fullName !== undefined
				? normalise(target.fullName) === exclusion.match
				: false;
		case "path": {
			const path = normalise(target.path);
			if (!path) return false;
			if (path === exclusion.match) return true;
			// Beneath it, at a directory boundary — never a partial name.
			return path.startsWith(`${exclusion.match}/`);
		}
		case "content-hash": {
			const hash = normalise(target.contentHash).replace(/^sha-?256:/, "");
			const match = exclusion.match.replace(/^sha-?256:/, "");
			return hash.length > 0 && hash === match;
		}
		case "example":
			return target.exampleSlug !== null && target.exampleSlug !== undefined
				? normalise(target.exampleSlug) === exclusion.match
				: false;
	}
}

/** The first exclusion covering a target, or null. Deterministic: the list is sorted. */
export function exclusionFor(
	exclusions: readonly Exclusion[],
	target: IngestTarget,
): Exclusion | null {
	return exclusions.find((exclusion) => matches(exclusion, target)) ?? null;
}

/** A sentence for the run report, so a skip says why rather than only that. */
export function describeExclusion(exclusion: Exclusion): string {
	return `${exclusion.scope} ${exclusion.match}${
		exclusion.reason ? ` (${exclusion.reason})` : ""
	} — excluded ${exclusion.recordedAt ? `on ${exclusion.recordedAt.slice(0, 10)}` : "earlier"}`;
}

/** The candidate fields an exclusion is matched against. */
export const targetOfCandidate = (candidate: Candidate): IngestTarget => ({
	fullName: candidate.fullName,
});

/**
 * The candidates a refresh may still touch.
 *
 * Used by `planRefresh` so the skip is part of the plan rather than a check the
 * crawler has to remember. Returned as the survivors so the caller can report what
 * was removed and why without re-filtering.
 */
export function withoutExcluded(
	candidates: readonly Candidate[],
	exclusions: readonly Exclusion[],
): { kept: Candidate[]; excluded: { candidate: Candidate; exclusion: Exclusion }[] } {
	const kept: Candidate[] = [];
	const excluded: { candidate: Candidate; exclusion: Exclusion }[] = [];
	for (const candidate of candidates) {
		const exclusion = exclusionFor(exclusions, targetOfCandidate(candidate));
		if (exclusion) excluded.push({ candidate, exclusion });
		else kept.push(candidate);
	}
	return { kept, excluded };
}

/**
 * The exclusions that apply to a payload example.
 *
 * An example has more to match on than a repository does: the repository it came
 * from, the path inside it, the digest of its bytes, and its own slug. Any one of
 * them excludes it, which is why this takes the whole record rather than one field.
 */
export function exclusionForExample(
	exclusions: readonly Exclusion[],
	example: {
		slug?: string | null;
		sourceRepo?: string | null;
		sourcePath?: string | null;
		contentHash?: string | null;
	},
): Exclusion | null {
	return exclusionFor(exclusions, {
		fullName: example.sourceRepo ?? null,
		path: example.sourceRepo && example.sourcePath ? `${example.sourceRepo}/${example.sourcePath}` : null,
		contentHash: example.contentHash ?? null,
		exampleSlug: example.slug ?? null,
	});
}