/**
 * Asset use, handoff and integrity (#42).
 *
 * Asset Hunter is two products in one catalogue, and this module is the seam
 * between them: the possibility half ("this treatment exists") and the asset
 * half ("you may use this file, and here is what you owe if you do"). The whole
 * file exists so those two halves cannot drift into each other.
 *
 * Three rules decide everything below, and each one is a rule this project has
 * already been bitten by somewhere:
 *
 * 1. **A use state is derived from the recorded rights status and never from
 *    the payload.** A file being present says nothing about whether it may be
 *    taken, so `useStateFor` looks only at the status. An absent or
 *    unrecognised status lands in `reference-only`, because "nobody wrote a
 *    status down" is not evidence of permission.
 * 2. **No download control exists without a retained, hashed, permitted
 *    payload.** `useActions` refuses to emit one, and the payload route
 *    re-checks the same decision rather than trusting the page that asked.
 *    A hand-typed address gets the same answer as a rendered link.
 * 3. **A credit is reproduced, never generated.** `creditText` and
 *    `creditLines` emit only recorded facts. A missing author stays missing
 *    rather than becoming a plausible name, which is the one thing issue #5
 *    forbids outright.
 *
 * Everything here is a pure function over the catalogue record. That is what
 * makes the honesty rules testable: "reference-only material never gets a
 * download action" is an assertion, not a code review.
 */
import type { Effect } from "effect";
import type { Example } from "./catalogue.ts";
import { runApp, type AppServices, type RunOptions } from "./effect/root.ts";
import {
	USE_STATE_LABEL,
	USE_STATE_MEANING,
	USE_STATE_OBLIGATION,
	type RightsStatus,
	type UseState,
} from "./vocabulary.ts";
import { safeContentType, safeHttpUrl } from "./security.ts";

/**
 * Rights status → use state.
 *
 * A `Map` rather than an object literal because the input is a database string:
 * an object lookup would answer `Object.prototype` for a status called
 * `constructor` and hand back a function where a use state belongs.
 */
const RIGHTS_TO_USE = new Map<RightsStatus, UseState>([
	["cleared", "reusable"],
	["attribution", "reusable-with-attribution"],
	["review", "review-required"],
	["reference", "reference-only"],
]);

/** The state an example with no usable rights status is treated as having. */
export const UNSTATED_USE_STATE: UseState = "reference-only";

/** Statuses whose use state is "you may use this, subject to the rules". */
const REUSABLE_STATES = new Set<UseState>(["reusable", "reusable-with-attribution"]);

/**
 * The use state for an example, from its recorded rights status alone.
 *
 * Refuses to answer "reusable" for anything it does not recognise. That
 * asymmetry is the point: a new status added to the engine tomorrow renders as
 * the most restrictive state until this map is taught the word, and the failure
 * mode is an over-cautious page rather than a cleared-looking one.
 */
export function useStateFor(
	example: Pick<Example, "rightsStatus"> | null | undefined,
): UseState {
	const status = example?.rightsStatus as RightsStatus | null | undefined;
	return (status ? RIGHTS_TO_USE.get(status) : undefined) ?? UNSTATED_USE_STATE;
}

/** True when the recorded status permits reuse at all. */
export function isReusable(state: UseState): boolean {
	return REUSABLE_STATES.has(state);
}

/* -------------------------------------------------------------------------- */
/* Reading one record                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Runs a catalogue read to a value.
 *
 * The asset-use flow needs two things the other surfaces do not: a *single*
 * example by its own id, and the freedom to fail loudly rather than render an
 * empty page. Both live behind the same read, and this is the one place that
 * knows how to turn what the read hands back into a value or a thrown error.
 *
 * Since #62 the read is an Effect, so "turn it into a value" is a runner, and the
 * runner lives in exactly one place. This is a one-line delegation to it rather
 * than a second, structural way of working out what a read is: the earlier
 * version probed the value for a `runPromise` method, which is not how an Effect
 * is run, so it silently returned the Effect itself and every page behind it
 * 404'd.
 *
 * The trade is stated rather than hidden. This is a domain module, and a domain
 * module arguably should not import a composition root. It is the lesser of two
 * evils against duplicating the runner, which the house style forbids outright. A
 * route that would rather not go through here should import `runApp` from
 * `./effect/root.ts` itself.
 */
export const runRead = <A, E>(
	read: Effect.Effect<A, E, AppServices>,
	options: RunOptions = {},
): Promise<A> => runApp(read, options);

/* -------------------------------------------------------------------------- */
/* The handoff decision                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Which rule held the payload back. `null` means nothing held it back and a
 * payload handoff is on offer.
 *
 * Ordered from the most to the least alarming, because the first one that
 * applies is the one the reader is told about: a licence that forbids use
 * matters more than a copy we happen not to hold.
 */
export type HandoffBlock =
	| "rights"
	| "obligation"
	| "not-retained"
	| "unverified"
	| null;

export interface Handoff {
	/**
	 * What may be handed over. `"record"` is always available and is the
	 * source/licence/provenance evidence itself; `"payload"` is the original
	 * file, and is only ever offered under all four conditions below.
	 */
	as: "payload" | "record";
	/** Always populated, in words. This is what the page shows. */
	statement: string;
	/** The rule that held the payload back, or null. */
	blockedBy: HandoffBlock;
}

export interface UseDecision {
	state: UseState;
	/** Looked up, never assembled from the state slug. */
	label: string;
	meaning: string;
	/** The rights status this state was derived from, if it is a real one. */
	rightsStatus: RightsStatus | null;
	/** What the reader has to do, or null when the state imposes nothing. */
	obligation: string | null;
	/** A recorded credit exists and is complete enough to travel with the asset. */
	creditReady: boolean;
	/** Why the credit is not ready, when it is not. */
	creditGap: string | null;
	handoff: Handoff;
}

/* -------------------------------------------------------------------------- */
/* Content hashes                                                              */
/* -------------------------------------------------------------------------- */

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Normalises a recorded hash to bare lowercase hex.
 *
 * Accepts the `sha256:` and `SHA-256:` prefixes that tools add and the uppercase
 * some licence scanners emit, because refusing to compare `SHA256:AB…` against
 * `ab…` would report a mismatch for an identical file — and a false mismatch on
 * a rights record is the kind of error that makes people stop reading the
 * provenance at all.
 */
export function normaliseHash(value: string | null | undefined): string | null {
	if (!value) return null;
	const bare = value.trim().replace(/^sha-?256:/i, "").toLowerCase();
	return SHA256_HEX.test(bare) ? bare : null;
}

/** True when a recorded content hash is a well-formed SHA-256. */
export function isContentHash(value: string | null | undefined): boolean {
	return normaliseHash(value) !== null;
}

/** Whether a digest and a recorded hash are the same file. */
export function hashesMatch(
	expected: string | null | undefined,
	actual: string | null | undefined,
): boolean {
	const a = normaliseHash(expected);
	const b = normaliseHash(actual);
	return a !== null && b !== null && a === b;
}

/**
 * SHA-256 of a byte array, as lowercase hex.
 *
 * Web Crypto rather than `node:crypto` so the same function runs in the Worker
 * and in the test suite, and so a verification that works locally cannot fail in
 * production for a reason that has nothing to do with the file.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const view = new Uint8Array(bytes.byteLength);
	view.set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", view);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/* -------------------------------------------------------------------------- */
/* Credit                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreditLine {
	label: string;
	value: string;
}

/**
 * The recorded credit, or null when there is none.
 *
 * A recorded attribution is what the licence obliges a reader to reproduce, so
 * it is kept exactly as written. Nothing is appended, capitalised or tidied: the
 * point of a credit is that it is the author's, not ours.
 */
export function creditOf(example: Pick<Example, "attribution">): string | null {
	const text = example.attribution?.trim();
	return text ? text : null;
}

/** True when a credit exists that can travel with the asset. */
export function creditReady(example: Pick<Example, "attribution">): boolean {
	return creditOf(example) !== null;
}

/**
 * The evidence rows behind a use decision, in a fixed order.
 *
 * These labels are the vocabulary's — "licence evidence" and "attribution" are
 * the terms `docs/VOCABULARY.md` fixes, and they were spelled loosely on the
 * drill-in before this function existed. They live here now so the drill-in and
 * the use page cannot disagree about what a row is.
 */
export function creditLines(example: Example): CreditLine[] {
	return [
		{ label: "Attribution", value: example.attribution?.trim() ?? "" },
		{ label: "Licence", value: example.licenceSpdx?.trim() ?? "" },
		{ label: "Licence evidence", value: example.licenceEvidence?.trim() ?? "" },
		{ label: "Source", value: example.sourceUrl?.trim() ?? "" },
		{ label: "Repository", value: example.sourceRepo?.trim() ?? "" },
		{ label: "Ref", value: example.sourceRef?.trim() ?? "" },
		{ label: "Path", value: example.sourcePath?.trim() ?? "" },
		{ label: "Content hash", value: example.contentHash?.trim() ?? "" },
	].filter((row) => row.value.length > 0);
}

/**
 * The copyable credit block for one example.
 *
 * The recorded attribution, the licence it is offered under, and the pointer
 * that says which file the credit is for. The licence evidence quote is
 * deliberately left out: it is a paragraph of licence text, it belongs in the
 * evidence row where it can be read, and pasting it into a credits file changes
 * what the file is.
 *
 * Only recorded facts, each on its own line, so it can be pasted into a
 * `CREDITS.md`, a game's third-party notices file, or a comment on a pull
 * request without editing. When nothing is recorded, the answer is `null` — not
 * a template with holes in it, because a credit block with `<author>` in it is
 * the easiest way to ship an unattributed asset while believing you did not.
 */
export function creditText(example: Example): string | null {
	const lines = creditLines(example)
		.filter((row) => row.label !== "Licence evidence")
		.map((row) => `${row.label}: ${row.value}`);
	return lines.length > 0 ? lines.join("\n") : null;
}

/** The credit blocks for a whole selection, each under its own heading. */
export function selectionCreditText(
	examples: Example[],
	titleOf: (example: Example) => string,
): string | null {
	const blocks = examples
		.map((example) => {
			const text = creditText(example);
			return text ? `## ${titleOf(example)}\n\n${text}` : null;
		})
		.filter((block): block is string => block !== null);
	if (blocks.length === 0) return null;
	return ["# Credits", "", ...blocks].join("\n\n");
}

/* -------------------------------------------------------------------------- */
/* The decision                                                                */
/* -------------------------------------------------------------------------- */

const CREDIT_GAP =
	"No attribution is recorded against this example, so there is no credit to reproduce. " +
	"Until the licence evidence is read and the credit recorded, this asset is not handed over.";

/**
 * The use decision for one example: what a reader may do, what they owe, and
 * what is actually available to take.
 *
 * The order of the checks is the argument. Rights come first, because a
 * licence that forbids reuse is the answer whatever else is true. The
 * obligation comes second, because a permitted use whose condition cannot be met
 * is not a permitted use. Retention and the recorded hash come last, because
 * they are facts about this deployment rather than about the author's
 * permission.
 */
export function useDecision(example: Example): UseDecision {
	const status = RIGHTS_TO_USE.has(example.rightsStatus as RightsStatus)
		? (example.rightsStatus as RightsStatus)
		: null;
	const state = useStateFor(example);
	const credit = creditReady(example);

	const handoff: Handoff = (() => {
		if (!isReusable(state)) {
			return {
				as: "record",
				blockedBy: "rights",
				/*
				 * The handoff fact and nothing else.
				 *
				 * This used to be `${label}. ${USE_STATE_OBLIGATION[state]} No file is
				 * served…`, because `handoff.statement` doubles as the whole answer in the
				 * plain-text body `/api/payload/<example>` returns for a refusal. On the
				 * page it is not the whole answer: `ExampleUse` renders the state and the
				 * obligation on their own lines directly above it, so the same sentence
				 * was printed twice, three lines apart, on the one page whose entire job
				 * is an unambiguous decision (DESIGN.md §9.6). The obligation is still on
				 * the record — `recordDocument()` carries `obligation` and `label`
				 * separately — and the refusal body still reads as a refusal.
				 */
				statement: "No file is served from this record, at this address or any other.",
			};
		}
		if (!credit) {
			return {
				as: "record",
				blockedBy: "obligation",
				statement:
					`${USE_STATE_LABEL[state]}. ${CREDIT_GAP}`,
			};
		}
		if (!example.downloadable) {
			return {
				as: "record",
				blockedBy: "not-retained",
				statement:
					"Permitted for reuse, and Asset Hunter holds no copy of the original. " +
					"What you can see here is a preview, not the asset — open the canonical source, " +
					"and keep this record with whatever you take.",
			};
		}
		if (!isContentHash(example.contentHash)) {
			return {
				as: "record",
				blockedBy: "unverified",
				statement:
					"The original is retained, but no content hash is recorded against it, so it cannot be " +
					"handed over as provably the same file. The source and licence record is everything " +
					"that is known about it.",
			};
		}
		return {
			as: "payload",
			blockedBy: null,
			statement:
				"The retained original is served unmodified, with the SHA-256 recorded on this page. " +
				"Check it against your copy before you rely on it.",
		};
	})();

	return {
		state,
		label: USE_STATE_LABEL[state],
		meaning: USE_STATE_MEANING[state],
		rightsStatus: status,
		obligation: USE_STATE_OBLIGATION[state],
		creditReady: credit,
		creditGap: credit ? null : CREDIT_GAP,
		handoff,
	};
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

export type UseActionId =
	| "download"
	| "record"
	| "upstream"
	| "credit"
	| "licence-evidence"
	| "revision";

export interface UseAction {
	id: UseActionId;
	/** What the control does, verb first. Never "Submit", never "Go". */
	label: string;
	/** Why it is on offer. Rendered with the control, so nothing is unexplained. */
	note: string;
	kind: "download" | "link" | "copy" | "disclosure";
	/** Absolute path, for `link` and `download`. */
	href?: string;
	/** Element id this control copies, for `copy`. */
	copies?: string;
	/** Where a link goes, for `link`. */
	external?: boolean;
}

/** The paths the asset-use flow serves. One place, so no component builds a URL. */
export const assetUsePaths = {
	/** Per-possibility selection: the drill-in's use half. */
	use: (possibilitySlug: string) => `/use/${encodeURIComponent(possibilitySlug)}`,
	/** Source, licence and provenance for one example. Never gated. */
	record: (exampleId: string) => `/api/record/${encodeURIComponent(exampleId)}`,
	/** The retained original, for one example. Gated by the same decision. */
	payload: (exampleId: string) => `/api/payload/${encodeURIComponent(exampleId)}`,
} as const;

/** The id of an example's copyable credit block on a page. */
export const creditBlockId = (exampleId: string) => `credit-${exampleId}`;

/**
 * The actions available for one example.
 *
 * A control appears only when the thing it does is actually true. There is no
 * disabled download and no greyed-out "Download" waiting for permission: an
 * action that cannot be taken is a statement about the record, and statements
 * about the record are made in words by `useDecision().handoff.statement`.
 *
 * In particular `download` is emitted only for a `"payload"` handoff, which
 * needs all four of: a reuse-permitting status, a recorded credit, a retained
 * payload, and a recorded content hash.
 */
export function useActions(example: Example): UseAction[] {
	const actions: UseAction[] = [];

	if (useDecision(example).handoff.as === "payload") {
		actions.push({
			id: "download",
			label: "Download the original",
			note: "The retained original, byte for byte, with the recorded SHA-256 sent alongside it.",
			kind: "download",
			href: assetUsePaths.payload(example.slug),
		});
	}

	// The record is always offered. It is the evidence itself, and the evidence
	// is the one thing this catalogue owes a reader whatever the rights are —
	// including, especially, when the rights forbid reuse.
	actions.push({
		id: "record",
		label: "Open the source and licence record",
		note: "The provenance and licence evidence for this example, as data. Available whatever the rights are.",
		kind: "link",
		href: assetUsePaths.record(example.slug),
	});

	if (isHttpUrl(example.sourceUrl)) {
		actions.push({
			id: "upstream",
			label: "Open the canonical source",
			note: "Where this actually came from. Licence terms apply there, and they are the authority.",
			kind: "link",
			href: example.sourceUrl as string,
			external: true,
		});
	}

	if (creditReady(example)) {
		actions.push({
			id: "credit",
			label: "Copy the credit",
			note: "Reproduced exactly as recorded. Paste it wherever the asset appears.",
			kind: "copy",
			copies: creditBlockId(example.slug),
		});
	}

	if (example.licenceEvidence?.trim()) {
		actions.push({
			id: "licence-evidence",
			label: "Read the licence evidence",
			note: "The text that was read, with where it was read from.",
			kind: "disclosure",
		});
	}

	if (example.sourceRef?.trim() || example.sourcePath?.trim() || example.contentHash?.trim()) {
		actions.push({
			id: "revision",
			label: "Inspect the source revision and content hash",
			note: "Which commit, which file, which bytes. This is how a claim gets checked.",
			kind: "disclosure",
		});
	}

	return actions;
}

/** Only http(s) is followed out of the catalogue; anything else is not a source. */
function isHttpUrl(value: string | null | undefined): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/* -------------------------------------------------------------------------- */
/* Selection summary                                                           */
/* -------------------------------------------------------------------------- */

export interface UseSummary {
	total: number;
	byState: Record<UseState, number>;
	/** Examples a reader may reuse without further work. */
	reusable: number;
	/** Examples a reader may reuse if the recorded credit travels with them. */
	creditRequired: number;
	/** Examples with a retained original this deployment will hand over. */
	payloads: number;
	/** The states in the order a reader should read them, worst first. */
	order: UseState[];
}

/**
 * Counts for a whole selection, with the zeros left in.
 *
 * `payloads: 0` is a real answer and is rendered as one. A selection that
 * reports a download count it cannot back is worse than one that says nothing
 * is downloadable, because the second is checkable and the first is not.
 */
export function summariseUse(examples: Example[]): UseSummary {
	const order: UseState[] = [
		"reference-only",
		"review-required",
		"reusable-with-attribution",
		"reusable",
	];
	const byState = {
		reusable: 0,
		"reusable-with-attribution": 0,
		"review-required": 0,
		"reference-only": 0,
	} satisfies Record<UseState, number>;

	let payloads = 0;
	for (const example of examples) {
		const decision = useDecision(example);
		byState[decision.state] += 1;
		if (decision.handoff.as === "payload") payloads += 1;
	}

	return {
		total: examples.length,
		byState,
		reusable: byState.reusable,
		creditRequired: byState["reusable-with-attribution"],
		payloads,
		order,
	};
}

/** One line naming each state that appears, with a count, worst first. */
export function summaryLine(summary: UseSummary): string {
	const present = summary.order.filter((state) => summary.byState[state] > 0);
	if (present.length === 0) return "No examples yet";
	return present
		.map((state) => `${summary.byState[state]} ${USE_STATE_LABEL[state].toLowerCase()}`)
		.join(" · ");
}

/* -------------------------------------------------------------------------- */
/* The machine-readable record                                                 */
/* -------------------------------------------------------------------------- */

export const RECORD_SCHEMA = "asset-hunter.record/1";

/**
 * The source/licence/provenance record for one example.
 *
 * This is the "hand off with source and licence metadata" half of the flow, and
 * it is the answer today: the catalogue does not yet retain the originals, so
 * what it can honestly deliver is the evidence, and the evidence is worth more
 * than a file with no licence behind it.
 *
 * Every field is a recorded value or null. Nothing is derived, and there is no
 * field for a "probably the author", because a record that guesses is a record
 * nobody can rely on.
 */
export function recordDocument(example: Example) {
	const decision = useDecision(example);
	return {
		schema: RECORD_SCHEMA,
		id: example.slug,
		title: example.title,
		useState: decision.state,
		useStateLabel: decision.label,
		useStateMeaning: decision.meaning,
		obligation: decision.obligation,
		credit: creditText(example),
		creditReady: decision.creditReady,
		origin: example.origin ?? null,
		rightsStatus: decision.rightsStatus,
		rightsNote: example.rightsNote ?? null,
		licenceSpdx: example.licenceSpdx ?? null,
		licenceEvidence: example.licenceEvidence ?? null,
		sourceUrl: example.sourceUrl ?? null,
		sourceRepo: example.sourceRepo ?? null,
		sourceRef: example.sourceRef ?? null,
		sourcePath: example.sourcePath ?? null,
		contentHash: example.contentHash ?? null,
		contentHashVerified: isContentHash(example.contentHash),
		/** What this record can hand over, and what it cannot. */
		handoff: decision.handoff.as,
		handoffBlockedBy: decision.handoff.blockedBy,
		handoffStatement: decision.handoff.statement,
		/** The retained original, as a fact about the record rather than a promise. */
		payloadRetained: example.downloadable,
	};
}

/* -------------------------------------------------------------------------- */
/* Serving the retained original                                               */
/* -------------------------------------------------------------------------- */

/** Bytes read back from the retained store, if there are any. */
export interface RetainedPayload {
	bytes: Uint8Array;
	/**
	 * Recorded on the object. Left null rather than guessed from the media kind:
	 * `media_kind` is a catalogue label, not a MIME type, and a wrong
	 * Content-Type is how a browser runs something it should have downloaded.
	 */
	contentType?: string | null;
	filename?: string | null;
}

export interface PayloadResult {
	status: number;
	headers: Record<string, string>;
	/** Present for every response that is not the file itself. */
	body: string | null;
	/** Present only when the retained original is served. */
	bytes: Uint8Array | null;
}

/**
 * A filename for the download, derived from the recorded source path.
 *
 * Sanitised because it goes into a `Content-Disposition` header: a recorded path
 * is untrusted input, and a quote or a backslash in a filename is a header the
 * reader's browser will parse differently from the one we meant.
 */
export function payloadFilename(example: Example): string {
	const fromPath = example.sourcePath?.split("/").pop()?.trim();
	const raw = fromPath || example.slug;
	const safe = raw
		.replace(/[^\w.\-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 96);
	return safe || `${example.slug}.bin`;
}

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * A refusal as plain text: which rule fired, what it obliges, and what is on
 * offer instead.
 *
 * Kept beside `payloadResult` rather than inside `useDecision` because the
 * decision has three parts and each surface shows a different subset. The page
 * shows them as three labelled lines; a refusal body has to state them in one
 * sentence each, in that order, or it says only that the rule fired.
 */
function refusalText(decision: UseDecision): string {
	return [decision.label, decision.obligation, decision.handoff.statement]
		.filter((part): part is string => Boolean(part))
		.join(" ");
}

/**
 * The header set on every response this module produces, bytes or refusal.
 *
 * `nosniff` and a sandboxing `Content-Security-Policy` are what make
 * `content-disposition: attachment` a *second* line of defence rather than the
 * only one. EmDash's own media route sets exactly this pair on R2 objects
 * (`node_modules/emdash/src/astro/routes/api/media/file/[...key].ts`), so a file
 * this app hands over is inert by the same rules as one uploaded through the CMS
 * — including the case where the recorded content type is `text/html`, which
 * `attachment` alone would be trusting the browser to honour.
 *
 * `object-src 'none'` and `base-uri 'none'` are inside the sandbox for the same
 * reason: an HTML payload with `<base href>` or a `<object>` should not get to
 * rewrite where its own relative URLs point even if a future client ignored the
 * disposition.
 */
const PAYLOAD_HEADERS = {
	...NO_STORE,
	"x-content-type-options": "nosniff",
	"content-security-policy":
		"sandbox; default-src 'none'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'",
} as const;
/**
 * What `/api/payload/<example>` serves.
 *
 * The gate is `useDecision`, recomputed here from the record rather than taken
 * from the request, so a URL that was never rendered gets the same refusal a
 * hidden control would have. That is the whole reason this function is pure and
 * lives in the library rather than being inlined into the route: the rule under
 * test is the rule that runs.
 *
 * The status codes are chosen to say different things:
 *
 * - `403` the licence does not permit the handover. The record exists; the
 *   answer is no.
 * - `409` the handover is permitted but there is nothing here to hand over —
 *   the record says no payload is retained, or none is recorded that can be
 *   verified. A `404` would say the record does not exist, which is a different
 *   and untrue claim.
 * - `503` the bytes are there but do not match the recorded hash, or could not
 *   be read. Nothing is served, because the one thing this route can promise is
 *   that what it serves is the file the record describes.
 * - `200` the retained original, unmodified, with the digest attached.
 */
export async function payloadResult(input: {
	example: Example;
	retained: RetainedPayload | null;
}): Promise<PayloadResult> {
	const { example, retained } = input;
	const decision = useDecision(example);
	const headers: Record<string, string> = {
		...PAYLOAD_HEADERS,
		"x-ah-use-state": decision.state,
		"x-ah-record": assetUsePaths.record(example.slug),
	};

	if (decision.handoff.blockedBy === "rights" || decision.handoff.blockedBy === "obligation") {
		return {
			status: 403,
			headers: { ...headers, "x-ah-blocked-by": decision.handoff.blockedBy, "content-type": "text/plain; charset=utf-8" },
			/*
			 * The rule around the handoff fact, because here it *is* the whole
			 * answer. On a page the state, the obligation and the handoff are three
			 * labelled lines, so `handoff.statement` carries only the last of them and
			 * repeating the other two would print the obligation twice (#64). A plain
			 * text refusal has no labels, so it says which rule fired and why — which
			 * is what `tests/asset-use.test.ts` asserts: a refusal has to say what the
			 * rule is, not just that the rule fired.
			 */
			body: `${refusalText(decision)}\n`,
			bytes: null,
		};
	}

	// Permitted, but there is nothing verified to hand over. The record is still
	// the deliverable, so it is in the body rather than behind a second request.
	const record = recordDocument(example);
	if (decision.handoff.blockedBy !== null || retained === null) {
		return {
			status: 409,
			headers: { ...headers, "x-ah-blocked-by": decision.handoff.blockedBy ?? "unreadable", "content-type": "application/json; charset=utf-8" },
			body: `${JSON.stringify({ ...record, handoffStatement: decision.handoff.blockedBy === null ? "The retained payload could not be read, so nothing is served." : decision.handoff.statement }, null, "\t")}\n`,
			bytes: null,
		};
	}

	const digest = await sha256Hex(retained.bytes);
	if (!hashesMatch(example.contentHash, digest)) {
		return {
			status: 503,
			headers: { ...headers, "x-ah-integrity": "mismatch", "content-type": "text/plain; charset=utf-8" },
			body:
				"The retained bytes do not match the content hash recorded on this example, so nothing is served. " +
				`Recorded ${normaliseHash(example.contentHash)}, read ${digest}.\n`,
			bytes: null,
		};
	}

	return {
		status: 200,
		headers: {
			...headers,
			"x-ah-integrity": "verified",
			"x-ah-sha256": digest,
			// No Content-Type is invented: `application/octet-stream` plus an
			// attachment disposition makes the browser save it rather than try to
			// render it, which is the safe answer for an unknown asset type. A
			// recorded type is used when it is a well-formed MIME type, and the
			// sandbox above holds even if that type turns out to be one a browser
			// would render.
			"content-type": safeContentType(retained.contentType) ?? "application/octet-stream",
			"content-length": String(retained.bytes.byteLength),
			"content-disposition": `attachment; filename="${payloadFilename(example)}"`,
		},
		body: null,
		bytes: retained.bytes,
	};
}

/* -------------------------------------------------------------------------- */
/* Inspection helpers used by the page                                         */
/* -------------------------------------------------------------------------- */

/** Provenance rows worth showing in the revision disclosure. */
export function revisionRows(example: Example): CreditLine[] {
	return creditLines(example).filter((row) =>
		["Ref", "Path", "Content hash", "Repository", "Source"].includes(row.label),
	);
}
