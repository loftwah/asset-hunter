/**
 * Incremental refresh planning (#41).
 *
 * This module decides **what work a refresh owes**, and nothing else. It is
 * pure: no network, no filesystem, no clock. The crawl reads the plan and does
 * (or skips) the work; the report renders the plan. That split is the point —
 * "which repositories need re-reading" is a question with a checkable answer,
 * and burying it inside the crawler means it can never be tested without a
 * network.
 *
 * ## The rule
 *
 * A source is re-inspected when something that could change what the catalogue
 * says about it has changed. Cheap metadata decides that; bytes are only read
 * once a source has earned it.
 *
 * | Observation | Re-inspect? | Why |
 * | ----------- | ----------- | --- |
 * | new repository | yes | never seen |
 * | `pushedAt` moved | yes | something changed upstream |
 * | `archived` flipped | yes | it is no longer usable material |
 * | default branch moved | yes | the tree we read may not exist |
 * | star count moved | **no** | stars are not evidence of anything the catalogue claims |
 * | description edited | **no** | it is a hint, not evidence |
 * | nothing moved | no | the second run must be cheap — this is the acceptance criterion |
 *
 * Star count is the interesting exclusion. It is the one field that changes on
 * almost every run of a real crawl, and re-reading a repository because
 * someone starred it would make "unchanged sources do minimal work on the
 * second run" false in practice rather than only in the fixture.
 *
 * ## Explicit exclusions (#54)
 *
 * An exclusion is not a hint about this run. It is a standing instruction written by
 * a person through the rights workflow, and a refresh that re-reads an excluded
 * source is doing the thing the takedown stopped. So the plan consults the exclusion
 * list first and reports what it skipped *because* of one, separately from the
 * ordinary skips — a run that reports "12 unchanged" and says nothing about the
 * exclusion reads as though nothing was special about it.
 *
 * ## Honesty about what disappeared
 *
 * A source that 404s is not the same as a source that was never there. The
 * first is recorded as `vanished` with the evidence and the date; the second
 * never becomes a candidate. Collapsing the two would make a renamed or
 * deleted repository silently vanish from the catalogue with no trace, which is
 * the outcome #41 names as unacceptable.
 */

import type { Candidate } from "./candidates.ts";
import { exclusionFor, targetOfCandidate, type Exclusion } from "./exclusions.ts";

/** What a cheap metadata read told us about a repository right now. */
export interface SourceObservation {
	fullName: string;
	/** ISO timestamp of the most recent push, as GitHub reports it. */
	pushedAt: string;
	archived: boolean;
	fork: boolean;
	defaultBranch: string;
	/** The commit the API currently resolves for the default branch. */
	headSha: string;
	stars: number;
}

/** What a refresh owes one source. */
export type SourceAction =
	| { kind: "inspect"; reason: InspectReason; fullName: string }
	| { kind: "skip"; reason: SkipReason; fullName: string };

/**
 * Why a source is being re-read.
 *
 * Named rather than a boolean so the report can say *why* the run did the work
 * it did. A refresh that only ever reports "changed" teaches nothing about
 * which signal is actually moving.
 */
export type InspectReason =
	| "new-source"
	| "upstream-pushed"
	| "archived"
	| "branch-moved"
	| "missing-before";

/** Why a source is being left alone. */
export type SkipReason = "unchanged" | "not-usable" | "fork" | "excluded";

/**
 * What a refresh plan needs to know about standing exclusions (#54).
 *
 * Optional and last, so every existing call is unchanged and a run that knows
 * nothing about exclusions behaves exactly as it did before #54.
 */
export interface RefreshOptions {
	/** Exclusions read from EmDash before the run. See `./exclusions.ts`. */
	exclusions?: readonly Exclusion[];
}

/** Why a source is no longer reachable. Recorded, never deleted. */
export interface Vanished {
	fullName: string;
	/** The commit we last successfully read. */
	lastSeenRef: string;
	/** When we noticed, ISO. */
	noticedAt: string;
	/** What the API said — 404, 410, a redirect to a new name. */
	reason: string;
}

/**
 * Decides what a refresh owes.
 *
 * Takes the recorded candidates and the cheap observations just made. Returns
 * the work, plus anything that has disappeared.
 *
 * `observations` is keyed by full name because that is the identity GitHub
 * gives us; a candidate whose repository is not in the map is *not* treated as
 * vanished, because "we did not look" and "it is gone" are different facts and
 * only one of them justifies telling a reader something.
 */
export function planRefresh(
	candidates: readonly Candidate[],
	observations: ReadonlyMap<string, SourceObservation>,
	now: string,
	options: RefreshOptions = {},
): {
	inspect: SourceAction[];
	skip: SourceAction[];
	vanished: Vanished[];
	unchanged: number;
	excluded: { fullName: string; exclusion: Exclusion }[];
} {
	const inspect: SourceAction[] = [];
	const skip: SourceAction[] = [];
	const vanished: Vanished[] = [];
	const excluded: { fullName: string; exclusion: Exclusion }[] = [];
	let unchanged = 0;
	// Only active exclusions can skip anything, and they are consulted before every
	// other rule below — including the "is it new?" branch at the end. A takedown that
	// only stopped re-*inspecting* a known repository would still let a search result
	// bring it straight back, which is the "the crawler must not ingest the same exact
	// resource again" half of #54.
	const exclusions = (options.exclusions ?? []).filter((entry) => entry.active);
	const excludedNames = new Set<string>();

	for (const candidate of candidates) {
		const seen = observations.get(candidate.fullName);

		const exclusion = exclusions.length ? exclusionFor(exclusions, targetOfCandidate(candidate)) : null;
		if (exclusion) {
			excluded.push({ fullName: candidate.fullName, exclusion });
			excludedNames.add(candidate.fullName.toLowerCase());
			skip.push({ kind: "skip", reason: "excluded", fullName: candidate.fullName });
			continue;
		}

		// Not observed this run. Left out of the plan entirely rather than
		// reported as vanished — see the module comment.
		if (!seen) continue;

		// A fork was never going to be retained material; re-reading it would
		// spend a download on something the brief already excluded.
		if (seen.fork && !candidate.policyApplied.includes("keep")) {
			skip.push({ kind: "skip", reason: "fork", fullName: candidate.fullName });
			continue;
		}

		if (seen.archived && !candidate.archived) {
			inspect.push({ kind: "inspect", reason: "archived", fullName: candidate.fullName });
			continue;
		}
		if (seen.archived) {
			skip.push({ kind: "skip", reason: "not-usable", fullName: candidate.fullName });
			continue;
		}

		const pushed = laterThan(seen.pushedAt, candidate.pushedAt);
		const branchMoved = seen.defaultBranch !== candidate.defaultBranch;
		const commitMoved = seen.headSha !== candidate.ref;

		if (pushed || branchMoved || commitMoved) {
			inspect.push({
				kind: "inspect",
				reason: branchMoved ? "branch-moved" : "upstream-pushed",
				fullName: candidate.fullName,
			});
			continue;
		}

		unchanged++;
		skip.push({ kind: "skip", reason: "unchanged", fullName: candidate.fullName });
	}

	// Observations we have never recorded become work immediately: a repository
	// that appeared in a search result is new material whether or not this run
	// was asked to find it — unless it has been excluded, which is checked here as
	// well as above so a first sighting of an excluded repository is skipped rather
	// than inspected and then quietly dropped.
	const known = new Set(candidates.map((c) => c.fullName));
	for (const seen of observations.values()) {
		if (known.has(seen.fullName)) continue;
		const exclusion = exclusions.length
			? exclusionFor(exclusions, { fullName: seen.fullName })
			: null;
		if (exclusion) {
			excluded.push({ fullName: seen.fullName, exclusion });
			excludedNames.add(seen.fullName.toLowerCase());
			continue;
		}
		inspect.push({ kind: "inspect", reason: "new-source", fullName: seen.fullName });
	}

	return { inspect, skip, vanished, unchanged, excluded };
}

/**
 * Records a source that could not be read.
 *
 * Kept separately from `planRefresh` because noticing and reporting are
 * different moments: the crawl finds out during a fetch, and the plan is built
 * before any fetch happens. A source can vanish *during* a refresh, so the two
 * cannot be one function without making the plan depend on work it is supposed
 * to plan.
 */
export function noteVanished(
	candidate: Candidate,
	reason: string,
	now: string,
): Vanished {
	return {
		fullName: candidate.fullName,
		lastSeenRef: candidate.ref,
		noticedAt: now,
		reason,
	};
}

/**
 * Whether a rights change demands a re-read of the *licence file*.
 *
 * Separate from `planRefresh` on purpose. The refresh plan asks "did the source
 * move?"; this asks "given that it did, must the licence be re-classified?".
 * A repository whose stars changed needs neither.
 */
export function needsLicenceReread(
	before: Pick<Candidate, "rights">,
	after: Pick<Candidate, "rights">,
): boolean {
	return (
		before.rights.status !== after.rights.status ||
		before.rights.spdx !== after.rights.spdx ||
		before.rights.licenceSha256 !== after.rights.licenceSha256 ||
		before.rights.assetScoped !== after.rights.assetScoped
	);
}

/**
 * A compact run report (#41 observability).
 *
 * Every field is something an operator would otherwise have to count by hand
 * from a transcript, and every one of them can be zero. `unchanged` matters as
 * much as `inspected`: a refresh that re-read everything reports the same
 * numbers forever and gives no signal.
 */
/**
 * What a run measured.
 *
 * `excluded` is deliberately *not* one of these. The metrics are the crawl's own
 * observations — what it checked, what changed, what it read — and a source a
 * takedown stopped it from reading was never observed at all. Counting it here
 * would put a decision somebody else made into a column headed "what this run
 * measured". The exclusions a plan skipped are reported by the plan instead,
 * where they can be named.
 */
export interface RefreshMetrics {
	sourcesChecked: number;
	sourcesChanged: number;
	sourcesUnchanged: number;
	newSources: number;
	vanished: number;
	bytesDownloaded: number;
	licenceRereads: number;
}

export const emptyMetrics = (): RefreshMetrics => ({
	sourcesChecked: 0,
	sourcesChanged: 0,
	sourcesUnchanged: 0,
	newSources: 0,
	vanished: 0,
	bytesDownloaded: 0,
	licenceRereads: 0,
});

/** Renders the metrics as the lines the CLI prints. */
export function formatMetrics(m: RefreshMetrics): string[] {
	const lines = [
		`  checked     ${m.sourcesChecked}`,
		`  changed     ${m.sourcesChanged}`,
		`  unchanged   ${m.sourcesUnchanged}`,
		`  new         ${m.newSources}`,
	];
	if (m.vanished) lines.push(`  vanished    ${m.vanished}`);
	if (m.bytesDownloaded) lines.push(`  downloaded  ${(m.bytesDownloaded / 1024).toFixed(0)}kB`);
	if (m.licenceRereads) lines.push(`  licence re-reads ${m.licenceRereads}`);
	return lines;
}

/**
 * Is `a` later than `b`?
 *
 * Unparseable input answers `true`, which makes the refresh do the work. That
 * is the safe direction: an unreadable timestamp must not be the reason a
 * licence change goes unnoticed.
 */
function laterThan(a: string, b: string): boolean {
	const left = Date.parse(a);
	const right = Date.parse(b);
	if (Number.isNaN(left) || Number.isNaN(right)) return true;
	return left > right;
}
