/**
 * Rights correction, opt-out and takedown — the decisions (#54).
 *
 * This module is the vocabulary and the arithmetic of a rights dispute, and it
 * is deliberately pure. Everything effectful about #54 — reading disputes out of
 * EmDash, writing one, flipping `visibility`, appending an audit event — lives
 * in `./takedown.ts` behind the composition root. What stays here is the part
 * that must be *true* rather than *reachable*: what counts as a rights concern,
 * which dispute states withhold a download, what an exclusion covers, and what a
 * possibility looks like once one of its examples is gone.
 *
 * Three decisions are made here and nowhere else.
 *
 * **1. Which reports are rights matters, not quality signals.** A broken preview
 * and a creator saying "take my work down" both arrive as a report, and they are
 * not the same kind of thing. One is a bug; the other is a claim about somebody
 * else's work. Averaging them into a queue would put a takedown below a typo.
 * {@link RIGHTS_SENSITIVE_REASONS} is that separation, and it is also what the
 * reporter path uses to decide to withdraw a download immediately.
 *
 * **2. An open dispute withholds the asset, and nothing else.** Quarantine is a
 * *gate*, not a deletion: the licence evidence, the provenance, the commit, the
 * digest and the attribution all stay exactly where they were, because the
 * evidence is what a later correction is made from. Only the payload handoff
 * goes away, and it goes away with a sentence that says why.
 *
 * **3. An exclusion outlives a refresh.** A takedown recorded as a tick in an
 * editor's head is worthless, because the crawl will hand the same resource back
 * on the next run. {@link EXCLUSION_SCOPES} is the machine-readable form, and
 * `engine/src/exclusions.ts` is the other end of it.
 *
 * ## Vocabulary
 *
 * | Word        | Means                                                        |
 * | ----------- | ------------------------------------------------------------ |
 * | **dispute** | an open rights correction about one example or possibility     |
 * | **quarantine** | the state in which a dispute withdraws the direct-use path    |
 * | **exclusion** | a durable instruction that a source must not be ingested again |
 * | **audit event** | one append-only row: what changed, and why                 |
 *
 * These four words are the whole of #54 and they are not interchangeable with
 * the words already in `rating.ts`: a *report* is a reader's signal, a *dispute*
 * is the case opened by it.
 */

import { REPORT_REASONS, type ReportReason } from "./rating.ts";

/* -------------------------------------------------------------------------- */
/* Which reports are rights matters                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reasons that are answered before anything else in the queue.
 *
 * Each of these says something is *wrong about a record* or somebody is asking
 * not to be surfaced — not that an entry is disappointing. The set drives three
 * behaviours at once, which is why it is one list rather than a flag on each
 * reason:
 *
 * - the cockpit orders by it, and marks those rows urgent;
 * - the report endpoint opens a dispute and withdraws the download immediately,
 *   because waiting for an editor to notice is the failure #54 exists to prevent;
 * - {@link HIDES_POSSIBILITY} is derived from it, because a report about a whole
 *   entry is a different act from a report about one example.
 *
 * `licence-changed` is here because it was already the reason the cockpit
 * prioritised, and moving it would have weakened an existing behaviour.
 */
export const RIGHTS_SENSITIVE_REASONS: readonly ReportReason[] = [
	"rights-infringement",
	"opt-out-request",
	"licence-changed",
	"attribution-wrong",
	"not-downloadable",
];

/** Whether a report reason is about rights rather than quality. */
export function isRightsSensitive(reason: ReportReason): boolean {
	return RIGHTS_SENSITIVE_REASONS.includes(reason);
}

/**
 * Reasons that withdraw a whole possibility from the catalogue on filing.
 *
 * Only the two that are a person asking not to be shown. A licence correction
 * against a *possibility* is a correction to what its examples may be used for —
 * the entry is still a real possibility, and hiding it would delete the very
 * thing #54 says must survive an example being removed. A creator asking to be
 * removed, or an infringement claim, is a different act: the entry stops being
 * served at all, immediately, and comes back if the request was wrong.
 */
export const HIDES_POSSIBILITY: readonly ReportReason[] = [
	"rights-infringement",
	"opt-out-request",
];

/* -------------------------------------------------------------------------- */
/* Dispute state                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where a dispute is.
 *
 * `open` and `quarantined` are both live: `open` is "noticed, nothing decided",
 * `quarantined` is "the direct-use path is withdrawn while it is examined". They
 * withhold identically, because the delay between noticing and acting is exactly
 * when a download goes out. `corrected` and `dismissed` are terminal, and both
 * leave the record standing — a dispute is never erased, so the audit trail
 * always has something to point at.
 */
export type DisputeState = "open" | "quarantined" | "corrected" | "dismissed";

export const DISPUTE_STATES: readonly DisputeState[] = [
	"open",
	"quarantined",
	"corrected",
	"dismissed",
];

export const DISPUTE_STATE_LABEL: Record<DisputeState, string> = {
	open: "Open",
	quarantined: "Quarantined",
	corrected: "Corrected",
	dismissed: "Dismissed",
};

/** One sentence each, because a state nobody can explain is a state nobody acts on. */
export const DISPUTE_STATE_MEANING: Record<DisputeState, string> = {
	open: "A rights concern has been filed and nobody has looked at it yet.",
	quarantined:
		"The direct-use path is withdrawn while the concern is examined. The record, the provenance and the licence evidence are kept.",
	corrected: "The record was corrected. What changed and why is in the audit trail.",
	dismissed: "The concern was reviewed and did not hold. The record was left as it was.",
};

/** The states that still withhold the asset. Everything else is resolved. */
export const LIVE_DISPUTE_STATES: readonly DisputeState[] = ["open", "quarantined"];

/**
 * Narrows a stored value to a state, or null when it is not one.
 *
 * Null is *not* "resolved". {@link withholdsAsset} is what the gate asks, and it
 * treats anything that is not a known terminal state as live — an unrecognised
 * value in a rights field must not read as permission, the same direction as
 * `flagValue` and `useStateFor`.
 */
export function parseDisputeState(input: unknown): DisputeState | null {
	const value = String(input ?? "");
	return DISPUTE_STATES.includes(value as DisputeState) ? (value as DisputeState) : null;
}

/**
 * Whether a stored dispute state withholds the direct-use path.
 *
 * Three cases, and the middle one is the reason this is a function and not a `Map`
 * lookup:
 *
 * - **nothing recorded** — no field, or blank — is *not* a dispute. Every example in
 *   the catalogue has no dispute until somebody files one, and a catalogue where
 *   absence reads as a live takedown is a catalogue that serves nothing at all.
 * - **`open` / `quarantined`** withholds. That is the whole point of them.
 * - **anything else** withholds. A state this build cannot read is not evidence that
 *   the dispute was resolved, so the direction is the same one `flagValue` and
 *   `useStateFor` take: an unrecognised value in a rights field is never permission.
 */
export function withholdsAsset(state: string | null | undefined): boolean {
	const raw = typeof state === "string" ? state.trim() : "";
	if (!raw) return false;
	const parsed = parseDisputeState(raw);
	return parsed === null || LIVE_DISPUTE_STATES.includes(parsed);
}

/* -------------------------------------------------------------------------- */
/* Exclusion scope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What an exclusion names.
 *
 * The narrowest scope that answers the request, because each one is a promise
 * about the future: a `repository` exclusion promises the crawl will not read
 * that repository again, and not that other repositories by the same owner are
 * affected. `content-hash` is the exact-bytes scope — the same file re-uploaded
 * under a different path — and `example` is the record this catalogue itself
 * wrote, for the case where the subject is a generated plate rather than
 * something upstream.
 */
export type ExclusionScope = "repository" | "path" | "content-hash" | "example";

export const EXCLUSION_SCOPES: readonly ExclusionScope[] = [
	"repository",
	"path",
	"content-hash",
	"example",
];

export const EXCLUSION_SCOPE_LABEL: Record<ExclusionScope, string> = {
	repository: "Repository",
	path: "Path within a repository",
	"content-hash": "Exact content hash",
	example: "Catalogue example",
};

export const EXCLUSION_SCOPE_MEANING: Record<ExclusionScope, string> = {
	repository:
		"Nothing from this repository is ingested again, at any path, whatever the catalogue calls it.",
	path:
		"Nothing at this path, or below it, is ingested again. Other paths in the same repository are unaffected.",
	"content-hash":
		"Nothing with these exact bytes is ingested again, however it arrives or wherever it is found.",
	example:
		"This catalogue entry is not republished. Nothing upstream is affected, because nothing upstream was ours.",
};

/**
 * The shape a value has to have, in the words a refusal uses.
 *
 * Separate from the meaning because the meaning is prose for a reader and this is the
 * sentence that tells an editor exactly what was wrong with what they typed. Deriving
 * one from the other produces sentences like "needs nothing from this repository is
 * ingested again", which is worse than saying nothing at all.
 */
export const EXCLUSION_SCOPE_REQUIREMENT: Record<ExclusionScope, string> = {
	repository: "a repository is written owner/repository",
	path: "a path is written owner/repository/path/to/file",
	"content-hash": "a content hash is 64 hex characters, with or without a sha256: prefix",
	example: "an example is written as its slug, with no path and no spaces",
};

/** Whether an exclusion is in force. A lifted one is kept, and reads as `false`. */
export function exclusionIsActive(state: string | null | undefined): boolean {
	// The asymmetry is deliberate and matches `withholdsAsset`: an exclusion whose
	// state cannot be read is treated as active. A takedown that quietly stops
	// being a takedown because a column came back blank is the worst failure here.
	return String(state ?? "active") !== "lifted";
}

export function parseExclusionScope(input: unknown): ExclusionScope | null {
	const value = String(input ?? "");
	return EXCLUSION_SCOPES.includes(value as ExclusionScope) ? (value as ExclusionScope) : null;
}

/* -------------------------------------------------------------------------- */
/* The audit trail                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every action a rights case can take.
 *
 * Named rather than free text because an audit trail nobody can query is a log,
 * and a log cannot answer "what happened to the thing I reported". Each action
 * is what a row records; the `what` it changed is carried in the row itself
 * (`field`, `before`, `after`), because "we looked at it" and "we changed the
 * licence to reference" are different facts and only one of them is a repair.
 */
export type AuditAction =
	| "dispute-opened"
	| "quarantined"
	| "quarantine-released"
	| "visibility-changed"
	| "licence-corrected"
	| "download-withheld"
	| "source-excluded"
	| "exclusion-lifted"
	| "possibility-republished"
	| "dispute-resolved";

export const AUDIT_ACTIONS: readonly AuditAction[] = [
	"dispute-opened",
	"quarantined",
	"quarantine-released",
	"visibility-changed",
	"licence-corrected",
	"download-withheld",
	"source-excluded",
	"exclusion-lifted",
	"possibility-republished",
	"dispute-resolved",
];

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
	"dispute-opened": "Dispute opened",
	quarantined: "Quarantined",
	"quarantine-released": "Quarantine released",
	"visibility-changed": "Visibility changed",
	"licence-corrected": "Licence corrected",
	"download-withheld": "Download withheld",
	"source-excluded": "Source excluded",
	"exclusion-lifted": "Exclusion lifted",
	"possibility-republished": "Possibility republished",
	"dispute-resolved": "Dispute resolved",
};

export function parseAuditAction(input: unknown): AuditAction | null {
	const value = String(input ?? "");
	return AUDIT_ACTIONS.includes(value as AuditAction) ? (value as AuditAction) : null;
}

/* -------------------------------------------------------------------------- */
/* The reader-facing sentence                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a reader is told when an asset is withheld pending a rights review.
 *
 * One sentence, four things in it: the asset is not being served, a rights
 * concern is open, the record is still there, and nothing has been deleted. The
 * fourth matters most — "we have removed your work" and "we have not served
 * your file while we check" are different claims, and only the second one is
 * true. Getting that wrong in the direction of the first would be a claim the
 * catalogue cannot support.
 */
export const WITHHELD_STATEMENT =
	"Withheld while a rights concern is examined. Nothing is served from this record, " +
	"at this address or any other. The source, licence evidence and content hash are kept — " +
	"the asset is not handed over, and nothing recorded about it has been deleted.";

/* -------------------------------------------------------------------------- */
/* The possibility graph                                                        */
/* -------------------------------------------------------------------------- */

/** The narrow shape the recompute needs, so a row or a test literal both fit. */
export interface ExampleFacts {
	slug: string;
	rightsStatus?: string | null;
	origin?: string | null;
	sourcePath?: string | null;
	contentHash?: string | null;
	mediaKind?: string | null;
	downloadable?: boolean | null;
	disputeState?: string | null;
}

/** Rights, weakest last. Mirrors the engine's `worstRights`; see `weakestRights`. */
const RIGHTS_ORDER = ["cleared", "attribution", "review", "reference"];

/**
 * The weakest rights status across a set of examples.
 *
 * Duplicated from `engine/src/publish.ts#worstRights` on purpose, because
 * `docs/ARCHITECTURE.md` forbids the app importing engine code — the two systems
 * are an HTTP contract, not a shared module. That leaves one number computed
 * twice, so `tests/takedown.test.ts` asserts the two agree rather than leaving
 * the duplication to be discovered by a curator.
 *
 * A possibility's status is the *floor* across its examples, never the best one.
 * An entry that says "cleared" because one of five sources was MIT while the rest
 * had no licence is exactly the false certainty this product exists to prevent.
 */
export function weakestRights(statuses: readonly (string | null | undefined)[]): string {
	if (statuses.length === 0) return "reference";
	return statuses.reduce<string>((worst, status) => {
		const value = String(status ?? "reference");
		const index = RIGHTS_ORDER.indexOf(value);
		// An unrecognised status sorts as the weakest thing there is. Same
		// direction as `useStateFor`: a status this build cannot read is not
		// evidence of permission.
		if (index === -1) return "reference";
		return RIGHTS_ORDER.indexOf(worst) > index ? worst : value;
	}, "cleared");
}

/**
 * The examples that may still represent a possibility.
 *
 * A withdrawn example is filtered out of the *representation* calculation, not
 * deleted from the record. Its provenance stays in the audit trail, which is what
 * makes the recompute honest: the count goes down because an example was
 * removed, and the audit trail says which one and why.
 */
export function representable(examples: readonly ExampleFacts[]): ExampleFacts[] {
	return examples.filter((example) => !withholdsAsset(example.disputeState));
}

/** Origin, most upstream first. A real asset represents better than our own plate. */
// `none` is last on purpose: an entry with no media is not in the provenance
// comparison at all, and sorting it before a real asset would misreport the risk.
const ORIGIN_ORDER = ["upstream", "derived", "generated", "none"];

/**
 * Which example represents a possibility.
 *
 * Deterministic and explainable, because "the wall changed" is not an acceptable
 * answer to "why is this the picture now". Ordered by:
 *
 * 1. not withheld — an example under a live dispute never represents anything;
 * 2. origin — `upstream` before `derived` before `generated`, so a real asset is
 *    preferred over a plate we made to demonstrate it;
 * 3. rights — a licence that was read beats one that was not;
 * 4. slug, so two runs over the same evidence choose the same example.
 *
 * Null when nothing is left to represent. That is a real answer and it is the
 * one case where the possibility itself has to be dealt with, so it is returned
 * rather than papered over with a placeholder.
 */
export function chooseRepresentative(
	examples: readonly ExampleFacts[],
): ExampleFacts | null {
	const ranked = [...representable(examples)].sort((a, b) => {
		const byOrigin =
			ORIGIN_ORDER.indexOf(String(a.origin ?? "generated")) -
			ORIGIN_ORDER.indexOf(String(b.origin ?? "generated"));
		if (byOrigin !== 0) return byOrigin;
		const byRights =
			RIGHTS_ORDER.indexOf(weakestRights([a.rightsStatus])) -
			RIGHTS_ORDER.indexOf(weakestRights([b.rightsStatus]));
		if (byRights !== 0) return byRights;
		return a.slug.localeCompare(b.slug);
	});
	return ranked[0] ?? null;
}

export interface Recomputed {
	/** How many examples still stand behind the entry. */
	exampleCount: number;
	/** How many of them have a licence that was actually read. */
	distinctSources: number;
	/** The floor across the examples that remain. */
	rightsStatus: string;
	/** The example that now represents the entry, or null when none is left. */
	representative: ExampleFacts | null;
	/** Things a person has to look at. Empty is a real answer. */
	notes: string[];
}

/**
 * Recomputes a possibility after one of its examples is removed or replaced.
 *
 * The claim `docs/ARCHITECTURE.md` makes is that "a possibility concept does not
 * necessarily need deletion merely because one example must be removed", and
 * this function is that claim in code: the entry survives, its count falls to
 * what is actually there, its status is re-floored across the remaining
 * examples, and its representative is re-chosen by {@link chooseRepresentative}.
 *
 * Three cases it refuses to hide:
 *
 * - a representative that was the removed example is replaced, and the note says
 *   so, because a wall that silently swapped its picture is unexplainable;
 * - no example remains, which is `rights_status: "reference"`, count 0 and a
 *   note — the entry is not deleted here, because deletion is a person's
 *   decision, but it must not keep claiming a representative it does not have;
 * - an entry whose status *weakens* as a result says so, because a corrected
 *   example that makes the entry less reusable than it looked is exactly what an
 *   audit trail exists to record.
 */
export function recomputePossibility(
	before: readonly ExampleFacts[],
	after: readonly ExampleFacts[],
): Recomputed {
	const kept = representable(after);
	const previous = chooseRepresentative(before);
	const representative = chooseRepresentative(kept);
	const notes: string[] = [];

	if (representative === null) {
		notes.push(
			"no example is left to represent this entry; it needs another example or a curator's decision to withdraw it",
		);
	} else if (previous && previous.slug !== representative.slug) {
		notes.push(`represented by ${representative.slug} instead of ${previous.slug}`);
	}

	// A licence that was readable and is not any more is a change a reader can
	// see, so it is reported rather than left in the audit trail alone.
	const wasVerified = (before ?? []).filter(
		(example) => example.rightsStatus === "cleared" || example.rightsStatus === "attribution",
	).length;
	const nowVerified = kept.filter(
		(example) => example.rightsStatus === "cleared" || example.rightsStatus === "attribution",
	).length;
	if (nowVerified < wasVerified) {
		notes.push(
			`${wasVerified - nowVerified} example(s) with a readable licence were removed; this entry's verified-source count falls to ${nowVerified}`,
		);
	}

	return {
		exampleCount: kept.length,
		distinctSources: nowVerified,
		rightsStatus: weakestRights(kept.map((example) => example.rightsStatus)),
		representative,
		notes,
	};
}

/* -------------------------------------------------------------------------- */
/* Reader-facing copy for the reporter path                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the reader is told after filing, per reason.
 *
 * Distinct from the report's `action` (which tells an editor what to do). This tells
 * the person who filed what happened to their report — and for a rights report it has
 * to be true immediately, because they filed it because something was being served
 * that should not have been.
 *
 * The wording keeps an example and an entry apart, because they are different acts: an
 * example is withheld and keeps its record and evidence, while a whole entry leaves the
 * public catalogue and 404s at its old address. Telling somebody their example is "off
 * the public catalogue" would be a claim about a page that never existed.
 */
export function filedNote(reason: ReportReason, subjectType: "possibility" | "example"): string {
	if (reason === "opt-out-request" || reason === "rights-infringement") {
		return subjectType === "possibility"
			? "Filed — this entry is off the public catalogue while it is reviewed, and nothing was deleted"
			: "Filed — this example is withheld while it is reviewed, and nothing was deleted";
	}
	if (reason === "not-downloadable") {
		return "Filed — the download is withheld while this is examined";
	}
	if (reason === "licence-changed" || reason === "attribution-wrong") {
		return subjectType === "example"
			? "Filed — the download is withheld while the licence evidence is re-read"
			: "Filed — a licence concern is read before anything else";
	}
	return "Filed for an editor";
}

/**
 * Whether the reasons here are still the ones this build knows about.
 *
 * A cheap guard against a seed or an older database presenting a reason the
 * reporter path cannot honour. Exported because `REPORTS` is a record and a
 * record can gain a key without the set being updated.
 */
export function rightsSensitiveReasonsAreKnown(): boolean {
	return RIGHTS_SENSITIVE_REASONS.every((reason) => REPORT_REASONS.includes(reason));
}