/**
 * Rights correction and takedown, as Effects (#54).
 *
 * Everything in this module is a **write to EmDash content** and nothing else: a
 * dispute is an entry, an exclusion is an entry, an audit event is an entry. There
 * is no side table, no file, no second store. That is not a preference — it is the
 * reason a creator's takedown request can be answered by the people who hold the
 * catalogue rather than by an engineer reconstructing what happened from a log.
 *
 * ## The rules this file encodes
 *
 * 1. **A rights report withdraws the asset immediately.** Not "queues for review
 *    and hopes somebody is watching". `openDispute` writes `dispute_state` onto
 *    the example and the gate in `./asset-use.ts` reads that field, so a URL
 *    handed out before the report stops working the moment the report lands —
 *    without the reader having to reload a page that might have cached the link.
 * 2. **Evidence is never deleted.** Quarantine flips a state and writes a row. It
 *    does not touch `licence_evidence`, `content_hash`, `attribution` or any
 *    provenance field, because the correction that resolves the dispute is made
 *    *from* that evidence. A takedown that destroyed it would also destroy the
 *    ability to say what was wrong.
 * 3. **Every change says what it changed.** Each action appends an audit event
 *    carrying the field, the value before, the value after and the reason.
 * 4. **Exclusions are machine-readable and outlive a run.** `excludeSource` is the
 *    only thing that stops a crawl re-finding material, and
 *    `engine/src/exclusions.ts` is the other end of the same record.
 *
 * ## Effect discipline
 *
 * Reads go through {@link EmDashContent} (Schema-decoded, typed read failures);
 * writes go through {@link EmDashContentApi} (typed write failures, explicit
 * publish). Both are named in `R` and both are supplied by
 * `src/lib/effect/root.ts` — the only file in `src/` that calls a runner. Every
 * decision about *what* to write is in `./disputes.ts`, which is pure, so the rules
 * are unit-testable without a database and these effects have nothing left to
 * decide.
 */
import { Effect, Schema } from "effect";
import { EmDashContent, EmDashContentApi, type EmDashRequest } from "./effect/emdash.ts";
import { decodeOr } from "./effect/decode.ts";
import { CatalogueDecodeError, EmDashTransportError, EmDashWriteError } from "./effect/errors.ts";
import { AuditEventData, DisputeData, ExclusionData, type RawEntryValue } from "./effect/schemas.ts";
import {
	AUDIT_ACTION_LABEL,
	DISPUTE_STATE_LABEL,
	EXCLUSION_SCOPE_REQUIREMENT,
	exclusionIsActive,
	filedNote,
	HIDES_POSSIBILITY,
	isRightsSensitive,
	parseDisputeState,
	parseExclusionScope,
	recomputePossibility,
	representable,
	withholdsAsset,
	type AuditAction,
	type DisputeState,
	type ExampleFacts,
	type ExclusionScope,
} from "./disputes.ts";
import { REPORTS, parseReason, type ReportReason } from "./rating.ts";
import type { Actor } from "./signals.ts";
import { sha256Hex } from "./asset-use.ts";
import type { EmDashReadError } from "./effect/emdash.ts";

/* -------------------------------------------------------------------------- */
/* The model                                                                    */
/* -------------------------------------------------------------------------- */

export type SubjectType = "possibility" | "example";

/** One rights case, as the cockpit reads it. */
export interface Dispute {
	id: string;
	subjectType: SubjectType;
	subjectSlug: string;
	reason: ReportReason;
	state: DisputeState | null;
	/** The stored state, so an unrecognised one is visible rather than hidden. */
	rawState: string;
	detail: string | null;
	reportId: string | null;
	reporterId: string | null;
	reportedAt: string;
	resolution: string | null;
	resolvedAt: string | null;
	resolvedBy: string | null;
	createdAt: string;
	updatedAt: string;
}

/** A standing instruction that something must not be ingested again. */
export interface Exclusion {
	id: string;
	scope: ExclusionScope;
	/** The exact string the engine compares against. Never a display label. */
	match: string;
	reason: ReportReason | null;
	detail: string | null;
	active: boolean;
	disputeSlug: string | null;
	recordedAt: string;
	recordedBy: string | null;
	liftedAt: string | null;
	liftedBy: string | null;
	liftReason: string | null;
}

/** One append-only row: what changed, from what, to what, and why. */
export interface AuditEvent {
	id: string;
	action: AuditAction;
	label: string;
	subjectType: SubjectType;
	subjectSlug: string;
	field: string | null;
	before: string | null;
	after: string | null;
	reason: ReportReason | null;
	detail: string | null;
	actorId: string | null;
	occurredAt: string;
}

/** Everything a write in this module can fail with. */
export type TakedownWrite = EmDashWriteError | EmDashTransportError | ExclusionRefused;

/**
 * A requested exclusion that could not be recorded.
 *
 * A refusal rather than a transport failure: nothing was written because the input
 * could not mean what it claimed, and repeating the request cannot change that.
 * `match` is echoed back so the editor can see exactly what was refused. This is a
 * typed error rather than a `false` so the caller has to deal with it.
 */
export class ExclusionRefused extends Schema.TaggedError<ExclusionRefused>()("ExclusionRefused", {
	scope: Schema.String,
	match: Schema.String,
	detail: Schema.String,
}) {}

/** The failure channel of every read here: the CMS refused, or we cannot read it. */
type TakedownRead<A> = Effect.Effect<A, EmDashReadError, EmDashContent>;

/* -------------------------------------------------------------------------- */
/* Projections — pure; the validation is the Effect part                       */
/* -------------------------------------------------------------------------- */

const decodeDisputeRow = decodeOr(DisputeData, "dispute row");
const decodeExclusionRow = decodeOr(ExclusionData, "exclusion row");
const decodeAuditRow = decodeOr(AuditEventData, "audit event row");

/**
 * A CMS text field, narrowed once.
 *
 * Takes `unknown` on purpose: `api.read` hands back a `Record<string, unknown>`
 * because it cannot know which collection it is reading, so every field of a record
 * read through the write API arrives untyped. Narrowing at the call site would mean
 * a cast in twenty places.
 */
const str = (value: unknown): string | null =>
	typeof value === "string" && value.trim() ? value.trim() : null;

const subjectTypeOf = (value: unknown): SubjectType | null =>
	value === "possibility" || value === "example" ? value : null;

const named = (entry: RawEntryValue) =>
	Effect.mapError((error: CatalogueDecodeError) =>
		new CatalogueDecodeError({ subject: entry.id, detail: error.detail }),
	);

/**
 * Projects a dispute row, or null when it cannot be read honestly.
 *
 * Null on a missing subject or an unknown subject type. The row is *dropped* rather
 * than rendered with holes in it: a queue entry with a blank subject is an entry
 * nobody can action, and an action that lands on the wrong record is worse than an
 * absent one.
 */
function toDispute(entry: RawEntryValue): Effect.Effect<Dispute | null, CatalogueDecodeError> {
	return decodeDisputeRow(entry.data).pipe(
		Effect.map((d): Dispute | null => {
			const subjectType = subjectTypeOf(d.subject_type);
			const subjectSlug = str(d.subject_slug);
			if (!subjectType || !subjectSlug) return null;
			// An absent state is `open`, because a case with no state recorded is a
			// case nobody has acted on — and it must still withhold.
			const rawState = str(d.state) ?? "open";
			return {
				id: entry.id,
				subjectType,
				subjectSlug,
				// An unreadable reason is `other`, never invented. `REPORTS` has an
				// entry for it, so the queue still renders something true.
				reason: parseReason(str(d.reason)) ?? "other",
				state: parseDisputeState(rawState),
				rawState,
				detail: str(d.detail),
				reportId: str(d.report_id),
				reporterId: str(d.reporter_id),
				reportedAt: str(d.reported_at) ?? entry.createdAt ?? "",
				resolution: str(d.resolution),
				resolvedAt: str(d.resolved_at),
				resolvedBy: str(d.resolved_by),
				createdAt: entry.createdAt ?? "",
				updatedAt: entry.updatedAt ?? "",
			};
		}),
		named(entry),
	);
}

/**
 * Projects an exclusion row, or null when it excludes nothing.
 *
 * A row with no scope or no match is refused here rather than rendered. The engine
 * would match it against nothing, so the cockpit would show protection that does
 * not protect — which is the specific way a takedown can quietly do nothing.
 */
function toExclusion(entry: RawEntryValue): Effect.Effect<Exclusion | null, CatalogueDecodeError> {
	return decodeExclusionRow(entry.data).pipe(
		Effect.map((d): Exclusion | null => {
			const scope = parseExclusionScope(d.scope);
			const match = str(d.match);
			if (!scope || !match) return null;
			return {
				id: entry.id,
				scope,
				match,
				reason: parseReason(str(d.reason)),
				detail: str(d.detail),
				active: exclusionIsActive(str(d.state)),
				disputeSlug: str(d.dispute_slug),
				recordedAt: str(d.recorded_at) ?? entry.createdAt ?? "",
				recordedBy: str(d.recorded_by),
				liftedAt: str(d.lifted_at),
				liftedBy: str(d.lifted_by),
				liftReason: str(d.lift_reason),
			};
		}),
		named(entry),
	);
}

function toAuditEvent(entry: RawEntryValue): Effect.Effect<AuditEvent | null, CatalogueDecodeError> {
	return decodeAuditRow(entry.data).pipe(
		Effect.map((d): AuditEvent | null => {
			const subjectType = subjectTypeOf(d.subject_type);
			const subjectSlug = str(d.subject_slug);
			const action = str(d.action) as AuditAction | null;
			if (!subjectType || !subjectSlug || !action) return null;
			return {
				id: entry.id,
				action,
				label: AUDIT_ACTION_LABEL[action] ?? String(action),
				subjectType,
				subjectSlug,
				field: str(d.field),
				before: str(d.before),
				after: str(d.after),
				reason: parseReason(str(d.reason)),
				detail: str(d.detail),
				actorId: str(d.actor_id),
				occurredAt: str(d.occurred_at) ?? entry.createdAt ?? "",
			};
		}),
		named(entry),
	);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every dispute, live cases first.
 *
 * Low volume by construction — one row per subject — so one query and an in-memory
 * sort. A row that cannot be decoded is dropped rather than fatal, for the reason
 * `loadReports` in `./signals.ts` gives: one malformed row must not cost a curator
 * the rest of the queue.
 */
export function loadDisputes(): TakedownRead<Dispute[]> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const page = yield* emdash.collection("disputes", { limit: 200 });
		const rows = yield* Effect.forEach(page.entries, (row) =>
			toDispute(row).pipe(Effect.catchTag("CatalogueDecodeError", () => Effect.succeed(null))),
		);
		return rows
			.filter((dispute): dispute is Dispute => dispute !== null)
			.sort(
				(a, b) =>
					Number(isLive(a)) - Number(isLive(b)) || a.subjectSlug.localeCompare(b.subjectSlug),
			);
	});
}

/**
 * Whether a dispute still needs a decision.
 *
 * An unrecognised state counts as live, because `withholdsAsset` withholds on one
 * and a queue that hid it would hide the one thing that has to be looked at.
 */
export function isLive(dispute: Dispute): boolean {
	return withholdsAsset(dispute.rawState);
}

/** Every exclusion, active ones first. */
export function loadExclusions(): TakedownRead<Exclusion[]> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const page = yield* emdash.collection("exclusions", { limit: 200 });
		const rows = yield* Effect.forEach(page.entries, (row) =>
			toExclusion(row).pipe(Effect.catchTag("CatalogueDecodeError", () => Effect.succeed(null))),
		);
		return rows
			.filter((exclusion): exclusion is Exclusion => exclusion !== null)
			.sort((a, b) => Number(b.active) - Number(a.active) || a.match.localeCompare(b.match));
	});
}

/**
 * The audit trail, oldest first.
 *
 * Never public. It exists so a later reader can answer "what happened to the thing
 * I reported", which is a question only an editor has the standing to be asked.
 * A `subjectSlug` narrows it to one case.
 */
export function loadAuditEvents(subjectSlug?: string): TakedownRead<AuditEvent[]> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const page = yield* emdash.collection("audit_events", { limit: 200 });
		const rows = yield* Effect.forEach(page.entries, (row) =>
			toAuditEvent(row).pipe(Effect.catchTag("CatalogueDecodeError", () => Effect.succeed(null))),
		);
		const events = rows.filter((event): event is AuditEvent => event !== null);
		return events
			.filter((event) => (subjectSlug ? event.subjectSlug === subjectSlug : true))
			.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
	});
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A caller-supplied string, made safe to put in a slug.
 *
 * The subject of a report arrives from a form a reader filled in, and it becomes part
 * of the URL EmDash is addressed with when a case is published — so `a/b`, `..` or a
 * path with `%2F` in it would put a path where a slug belongs. This is the one place
 * that turns one into the other, and it is exported because the rule is worth a test
 * rather than a promise in a comment.
 */
export const sanitiseSlug = (value: string): string =>
	value
		.trim()
		.replace(/[^\w.-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64) || "unknown";

/**
 * A dispute is one case per subject, so a second rights report about the same
 * example *updates* the case rather than opening a competing one — and two reports
 * arriving in the same second cannot produce two rows. Every filing is still kept,
 * in `reports`, which is the history of concerns rather than the case.
 */
const disputeSlug = (subjectType: SubjectType, subjectSlug: string) =>
	`dis-${subjectType}-${sanitiseSlug(subjectSlug)}`.slice(0, 80);

/**
 * An exclusion's slug is a content address of its scope and match.
 *
 * Content-addressed for the same reason example slugs are: recording the same
 * exclusion twice must land on one row, because two rows make "is this source
 * excluded?" answerable two different ways. Web Crypto so the Worker and a test
 * produce the same slug.
 */
const exclusionSlug = (
	scope: ExclusionScope,
	match: string,
): Effect.Effect<string, never, never> =>
	// The digest is `sha256Hex`, which is Web Crypto rather than `node:crypto` so
	// the same slug is produced in a Worker and in a test.
	Effect.promise(async () => {
		const digest = await sha256Hex(
			new TextEncoder().encode(`${scope}:${match.trim().toLowerCase()}`),
		);
		return `ex-${scope}-${digest.slice(0, 16)}`;
	});

/**
 * A process-local counter, so two audit rows written in the same second cannot
 * collide on a slug.
 *
 * Found the hard way: `openDispute` writes a `dispute-opened` row twice when the
 * subject was already quarantined — once for the field change and once for the case
 * itself — and both were created inside the same second, so the second create came
 * back `409 SLUG_CONFLICT` and took the whole withdrawal down with it. A counter in
 * the moment part of the slug makes an append-only trail actually append.
 */
let auditSequence = 0;

/**
 * Audit events are append-only, so their slug carries the moment and a sequence.
 *
 * Sanitised, and the reason is worth recording: an exclusion's subject is a
 * repository name, so `aud-source-excluded-asset-hunter/opt-out-demo-…` carries a
 * slash — and a slug with a slash in it is created fine (the create carries it in a
 * JSON body) and then 404s on the publish call, which addresses it as a path. The row
 * landed and the case was recorded correctly, but the action reported a failure
 * afterwards, which is the kind of noise that teaches people to ignore an error.
 */
export const auditSlug = (action: AuditAction, subjectSlug: string, at: string): string => {
	auditSequence = (auditSequence + 1) % 46656;
	const moment = Date.parse(at).toString(36) || Date.now().toString(36);
	const subject = sanitiseSlug(subjectSlug).slice(0, 40);
	return `aud-${action}-${subject}-${moment}-${auditSequence.toString(36)}`.slice(0, 80);
};

/* -------------------------------------------------------------------------- */
/* The write primitives                                                         */
/* -------------------------------------------------------------------------- */

/** The value of a field as a string, or null when it holds nothing. */
const fieldValue = (data: Readonly<Record<string, unknown>>, field: string): string | null => {
	const value = data[field];
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	const text = String(value);
	return text.trim() ? text : null;
};

interface AuditInput {
	action: AuditAction;
	subjectType: SubjectType;
	subjectSlug: string;
	/** The field that changed, or null when the action was not a field change. */
	field?: string | null;
	before?: string | null;
	after?: string | null;
	reason?: ReportReason | null;
	detail?: string | null;
	actor: Actor | null;
}

/**
 * Appends one row to the audit trail.
 *
 * Append-only and never edited afterwards. `before` and `after` are recorded as
 * held rather than normalised, because "what it used to say" is only evidence while
 * it is still exactly what it said.
 *
 * The reporter's email is deliberately *not* stored here. The contact record is the
 * report; an audit trail is a list of decisions, and copying somebody's email into
 * a second collection doubles the places it has to be honoured or erased from
 * without adding anything a reader needs.
 */
function recordAudit(request: EmDashRequest, input: AuditInput) {
	return Effect.gen(function* () {
		const api = yield* EmDashContentApi;
		const occurredAt = new Date().toISOString();
		const slug = auditSlug(input.action, input.subjectSlug, occurredAt);
		yield* api.create(request, "audit_events", slug, {
			title: `${input.action} — ${input.subjectSlug}`,
			action: input.action,
			subject_type: input.subjectType,
			subject_slug: input.subjectSlug,
			field: input.field ?? null,
			before: input.before ?? null,
			after: input.after ?? null,
			reason: input.reason ?? null,
			detail: input.detail ?? null,
			actor_id: input.actor?.id ?? null,
			occurred_at: occurredAt,
		});
		yield* api.publish(request, "audit_events", slug);
	});
}

/**
 * Reads an entry back as a writable record, with the revision token a write needs.
 *
 * `null` when the entry is not there, which is a real answer rather than a
 * failure: a takedown against a subject that has since been deleted has nothing
 * left to withhold, and reporting that as an error would be wrong.
 */
function readWritable(
	request: EmDashRequest,
	collection: string,
	slug: string,
): Effect.Effect<{ data: Record<string, unknown>; rev: string | null } | null, EmDashWriteError | EmDashTransportError, EmDashContentApi> {
	return Effect.gen(function* () {
		const api = yield* EmDashContentApi;
		return yield* api.read(request, collection, slug);
	});
}

/**
 * Writes a whole record and publishes it.
 *
 * Whole record, because EmDash's PUT validates the entry: sending only the changed
 * fields fails on everything that happened to be unchanged. References are left
 * alone deliberately — `references` is not part of the body, so EmDash keeps the
 * parent link an example has to its possibility.
 */
function writeAndPublish(
	request: EmDashRequest,
	collection: string,
	slug: string,
	data: Record<string, unknown>,
	rev: string | null,
): Effect.Effect<void, EmDashWriteError | EmDashTransportError, EmDashContentApi> {
	return Effect.gen(function* () {
		const api = yield* EmDashContentApi;
		yield* api.update(request, collection, slug, data, rev);
		yield* api.publish(request, collection, slug);
	});
}

/* -------------------------------------------------------------------------- */
/* Opening a dispute                                                            */
/* -------------------------------------------------------------------------- */

export interface OpenDisputeInput {
	subjectType: SubjectType;
	subjectSlug: string;
	reason: ReportReason;
	detail: string | null;
	/** The report this case came from, when it came from one. */
	reportId?: string | null;
	actor: Actor | null;
	/** Supplied so a decision is reproducible in a test; defaults to now. */
	now?: string;
}

export interface OpenDisputeResult {
	slug: string;
	/** The state written onto the record. */
	state: DisputeState;
	/** What the write actually did, in words, for the caller to show or log. */
	outcomes: string[];
}

/**
 * Opens a rights case and withdraws the direct-use path immediately.
 *
 * Two things happen, in this order, and the order is the point:
 *
 * 1. the **dispute** entry is created or updated, so the case is in the queue even
 *    if step 2 fails;
 * 2. the **subject** is written to withhold — `dispute_state: "quarantined"` on an
 *    example, `visibility: "hidden"` on a possibility and only for the reasons in
 *    `HIDES_POSSIBILITY`.
 *
 * Both are reported back as sentences in `outcomes`, because the caller has to tell
 * somebody what happened and "the write happened" is not an answer a person filing
 * a takedown can act on.
 *
 * A rights report on a possibility that is *not* an opt-out or an infringement
 * claim does not hide the entry. The entry is the possibility, and a possibility
 * does not need deleting because one of its examples is wrong — `republishPossibility`
 * is what happens instead.
 */
export function openDispute(
	request: EmDashRequest,
	input: OpenDisputeInput,
): Effect.Effect<OpenDisputeResult, EmDashWriteError | EmDashTransportError, EmDashContentApi> {
	return Effect.gen(function* () {
		const api = yield* EmDashContentApi;
		const at = input.now ?? new Date().toISOString();
		const slug = disputeSlug(input.subjectType, input.subjectSlug);
		const existing = yield* api.read(request, "disputes", slug);
		const outcomes: string[] = [];

		const data: Record<string, unknown> = {
			title: `${input.reason} — ${input.subjectSlug}`,
			subject_type: input.subjectType,
			subject_slug: input.subjectSlug,
			reason: input.reason,
			state: "quarantined" as DisputeState,
			detail: input.detail ?? null,
			report_id: input.reportId ?? null,
			reporter_id: input.actor?.id ?? null,
			reported_at: at,
			// A reopened case is a live case, so any previous resolution is cleared.
			// The history is not lost: it is in the audit trail, which is append-only.
			resolution: null,
			resolved_at: null,
			resolved_by: null,
		};

		yield* (existing
			? api.update(request, "disputes", slug, data, existing.rev)
			: api.create(request, "disputes", slug, data));
		yield* api.publish(request, "disputes", slug);
		outcomes.push(`dispute ${slug} opened as quarantined`);

		if (input.subjectType === "example") {
			const example = yield* readWritable(request, "examples", input.subjectSlug);
			if (!example) {
				outcomes.push(
					"the example is no longer in the catalogue, so there is nothing left to withhold",
				);
			} else {
				const before = fieldValue(example.data, "dispute_state");
				if (before === "quarantined") {
					outcomes.push("the example was already quarantined; nothing changed");
				} else {
					yield* writeAndPublish(
						request,
						"examples",
						input.subjectSlug,
						{
							...example.data,
							dispute_state: "quarantined",
							dispute_reason: input.reason,
							dispute_note: input.detail ?? null,
							dispute_reported_at: at,
							dispute_resolved_at: null,
						},
						example.rev,
					);
					outcomes.push(
						`example ${input.subjectSlug}: dispute_state ${before ?? "unset"} → quarantined`,
					);
				}
				yield* recordAudit(request, {
					action: before === "quarantined" ? "dispute-opened" : "quarantined",
					subjectType: "example",
					subjectSlug: input.subjectSlug,
					field: "dispute_state",
					before,
					after: "quarantined",
					reason: input.reason,
					detail: input.detail,
					actor: input.actor,
				});
			}
		} else if (HIDES_POSSIBILITY.includes(input.reason)) {
			const possibility = yield* readWritable(request, "possibilities", input.subjectSlug);
			if (!possibility) {
				outcomes.push(
					"the entry is no longer in the catalogue, so there is nothing left to withdraw",
				);
			} else {
				const before = fieldValue(possibility.data, "visibility");
				if (before === "hidden") {
					outcomes.push("the entry was already withdrawn from the catalogue");
				} else {
					yield* writeAndPublish(
						request,
						"possibilities",
						input.subjectSlug,
						{ ...possibility.data, visibility: "hidden" },
						possibility.rev,
					);
					outcomes.push(
						`possibility ${input.subjectSlug}: visibility ${before ?? "published"} → hidden`,
					);
				}
				yield* recordAudit(request, {
					action: "visibility-changed",
					subjectType: "possibility",
					subjectSlug: input.subjectSlug,
					field: "visibility",
					before,
					after: "hidden",
					reason: input.reason,
					detail:
						input.detail ??
						"withdrawn from the public catalogue on filing; the record and its evidence are kept",
					actor: input.actor,
				});
			}
		} else {
			outcomes.push(
				"the entry stays on the catalogue and its examples carry the correction; a curator decides the rest",
			);
		}

		yield* recordAudit(request, {
			action: "dispute-opened",
			subjectType: input.subjectType,
			subjectSlug: input.subjectSlug,
			reason: input.reason,
			detail: input.detail,
			actor: input.actor,
		});

		return { slug, state: "quarantined", outcomes } satisfies OpenDisputeResult;
	});
}

/* -------------------------------------------------------------------------- */
/* Releasing a quarantine                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Puts the direct-use path back without resolving the dispute.
 *
 * The one legitimate use is a quarantine applied in error — filed against the wrong
 * record, or by somebody who is not the author. It is a separate action from
 * `resolveDispute` precisely so that "we stopped withholding" and "the concern was
 * resolved" are two different facts in the audit trail, and neither implies the
 * other.
 */
export function releaseQuarantine(
	request: EmDashRequest,
	input: { exampleSlug: string; note: string | null; actor: Actor | null },
): Effect.Effect<string[], EmDashWriteError | EmDashTransportError, EmDashContentApi> {
	return Effect.gen(function* () {
		const example = yield* readWritable(request, "examples", input.exampleSlug);
		if (!example) return [`example ${input.exampleSlug} is not in the catalogue`];
		const before = fieldValue(example.data, "dispute_state");
		if (!withholdsAsset(before)) return [`example ${input.exampleSlug} was not withheld`];

		yield* writeAndPublish(
			request,
			"examples",
			input.exampleSlug,
			{ ...example.data, dispute_state: "open", dispute_resolved_at: null },
			example.rev,
		);
		yield* recordAudit(request, {
			action: "quarantine-released",
			subjectType: "example",
			subjectSlug: input.exampleSlug,
			field: "dispute_state",
			before,
			// `open` and not `corrected`: the case is still open, so a later refresh
			// cannot mistake this for a resolution.
			after: "open",
			detail: input.note,
			actor: input.actor,
		});
		return [`example ${input.exampleSlug}: dispute_state ${before ?? "unset"} → open`];
	});
}

/* -------------------------------------------------------------------------- */
/* Resolving a dispute                                                          */
/* -------------------------------------------------------------------------- */

export type Resolution = "corrected" | "dismissed";

/**
 * Closes a case, with a sentence saying how.
 *
 * The state is written onto the record as `corrected` or `dismissed` rather than
 * cleared to nothing. Both stop withholding — `withholdsAsset` treats only the two
 * terminal states as resolved — and both leave the trail in place, so a record can
 * still answer "was this ever contested, and what was done about it".
 *
 * A hidden possibility is restored only when this case is what hid it. A curator
 * who hid an entry for a different reason must not have it republished by somebody
 * else's case being closed.
 */
export function resolveDispute(
	request: EmDashRequest,
	input: {
		disputeSlug: string;
		subjectSlug: string;
		subjectType: SubjectType;
		outcome: Resolution;
		resolution: string;
		actor: Actor | null;
	},
): Effect.Effect<string[], EmDashWriteError | EmDashTransportError, EmDashContentApi> {
	return Effect.gen(function* () {
		const api = yield* EmDashContentApi;
		const at = new Date().toISOString();
		const outcomes: string[] = [];

		const dispute = yield* api.read(request, "disputes", input.disputeSlug);
		if (dispute) {
			yield* writeAndPublish(
				request,
				"disputes",
				input.disputeSlug,
				{
					...dispute.data,
					state: input.outcome,
					resolution: input.resolution,
					resolved_at: at,
					resolved_by: input.actor?.id ?? null,
				},
				dispute.rev,
			);
			outcomes.push(`dispute ${input.disputeSlug}: ${input.outcome}`);
		} else {
			outcomes.push(`dispute ${input.disputeSlug} was not in the queue`);
		}

		if (input.subjectType === "example") {
			const example = yield* readWritable(request, "examples", input.subjectSlug);
			if (example) {
				const before = fieldValue(example.data, "dispute_state");
				yield* writeAndPublish(
					request,
					"examples",
					input.subjectSlug,
					{ ...example.data, dispute_state: input.outcome, dispute_resolved_at: at },
					example.rev,
				);
				outcomes.push(
					`example ${input.subjectSlug}: dispute_state ${before ?? "unset"} → ${input.outcome}`,
				);
			}
		} else {
			const possibility = yield* readWritable(request, "possibilities", input.subjectSlug);
			const hiddenByUs =
				dispute !== null && str(dispute.data.subject_slug) === input.subjectSlug;
			if (possibility && fieldValue(possibility.data, "visibility") === "hidden" && hiddenByUs) {
				yield* writeAndPublish(
					request,
					"possibilities",
					input.subjectSlug,
					{ ...possibility.data, visibility: "published" },
					possibility.rev,
				);
				outcomes.push(`possibility ${input.subjectSlug}: visibility hidden → published`);
			} else if (possibility && fieldValue(possibility.data, "visibility") === "hidden") {
				outcomes.push(
					`possibility ${input.subjectSlug} is hidden for another reason and was left hidden`,
				);
			}
		}

		yield* recordAudit(request, {
			action: "dispute-resolved",
			subjectType: input.subjectType,
			subjectSlug: input.subjectSlug,
			field: "dispute_state",
			before: "quarantined",
			after: input.outcome,
			detail: input.resolution,
			actor: input.actor,
		});
		return outcomes;
	});
}

/* -------------------------------------------------------------------------- */
/* Exclusions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether a match could mean what its scope claims.
 *
 * A repository is `owner/repo`, a path is `owner/repo/something`, a content hash is
 * 64 hex characters (with or without the `sha256:` prefix tools add), and an example
 * is a slug. Recorded as a rule rather than left to the engine, because the value is
 * chosen in the admin and a mistake here is silent: the row exists, the cockpit
 * shows it, and nothing is excluded.
 */
export function exclusionMatchIsUsable(scope: ExclusionScope, match: string): boolean {
	const value = match.trim();
	if (!value) return false;
	if (scope === "repository") return /^[\w.-]+\/[\w.-]+$/.test(value);
	if (scope === "path") return /^[\w.-]+\/[\w.-]+\/\S+$/.test(value);
	if (scope === "content-hash") return /^sha-?256:[0-9a-f]{64}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value);
	return /^[\w.-]+$/.test(value);
}

/**
 * Records a standing exclusion.
 *
 * This is the row the crawl consults, and it is the reason a takedown survives a
 * refresh: the next run reads it and does not ingest the material again, without
 * anybody remembering to tick a box. `engine/src/exclusions.ts` is the other end.
 *
 * Recording the same exclusion twice lands on the same row and says so, because two
 * rows would make "is this source excluded?" answerable two ways.
 */
export function excludeSource(
	request: EmDashRequest,
	input: {
		scope: ExclusionScope;
		match: string;
		reason: ReportReason | null;
		detail: string | null;
		disputeSlug: string | null;
		actor: Actor | null;
	},
): Effect.Effect<
	{ slug: string; alreadyActive: boolean; message: string },
	TakedownWrite,
	EmDashContentApi
> {
	return Effect.gen(function* () {
		if (!exclusionMatchIsUsable(input.scope, input.match)) {
			return yield* Effect.fail(
				new ExclusionRefused({
					scope: input.scope,
					match: input.match,
					detail: `That is not a ${input.scope} I can exclude. ${EXCLUSION_SCOPE_REQUIREMENT[input.scope].replace(/^[a-z]/, (c) => c.toUpperCase())}. Nothing was recorded, so nothing is being excluded.`,
				}),
			);
		}
		const api = yield* EmDashContentApi;
		const at = new Date().toISOString();
		const match = input.match.trim();
		const slug = yield* exclusionSlug(input.scope, match);
		const existing = yield* api.read(request, "exclusions", slug);

		if (existing && exclusionIsActive(str(existing.data.state))) {
			return {
				slug,
				alreadyActive: true,
				message: `${match} was already excluded from future ingestion`,
			};
		}

		const data: Record<string, unknown> = {
			title: `${input.scope} — ${match}`,
			scope: input.scope,
			match,
			reason: input.reason ?? null,
			detail: input.detail ?? null,
			state: "active",
			dispute_slug: input.disputeSlug,
			recorded_at: at,
			recorded_by: input.actor?.id ?? null,
			// Re-recording a lifted exclusion is a new decision, so the old lift is
			// overwritten rather than kept alongside. The earlier lift is still
			// readable in the audit trail.
			lifted_at: null,
			lifted_by: null,
			lift_reason: null,
		};
		/*
		 * Create-or-update, with one thing worth knowing about the create branch: a
		 * `read` that answers "not there" is not proof that the slug is free. EmDash
		 * keeps a deleted entry in its trash and a create with the same slug comes back
		 * `409 SLUG_CONFLICT` — which is what happens if somebody deleted an exclusion
		 * row by hand and then the same takedown is recorded again. The 409 is a
		 * refusal like any other and is reported to the editor as one; it is not
		 * retried, because retrying cannot free a slug and would only ever lose the
		 * decision.
		 */
		yield* (existing
			? api.update(request, "exclusions", slug, data, existing.rev)
			: api.create(request, "exclusions", slug, data));
		yield* api.publish(request, "exclusions", slug);
		yield* recordAudit(request, {
			action: "source-excluded",
			subjectType: "example",
			subjectSlug: match,
			field: input.scope,
			before: existing ? str(existing.data.state) : null,
			after: "active",
			reason: input.reason,
			detail: input.detail ?? `excluded from future ingestion (${input.scope}); the record and its evidence are kept`,
			actor: input.actor,
		});
		return {
			slug,
			alreadyActive: false,
			message: `${match} will not be ingested again (${input.scope})`,
		};
	});
}

/**
 * Lifts an exclusion.
 *
 * Takes a reason, because "we changed our minds" and "the author said it was fine"
 * are different answers and a later reader is entitled to know which happened. The
 * row stays, set to `lifted`, so the fact that something was once excluded is still
 * on the record.
 */
export function liftExclusion(
	request: EmDashRequest,
	input: { slug: string; reason: string; actor: Actor | null },
): Effect.Effect<string, EmDashWriteError | EmDashTransportError, EmDashContentApi> {
	return Effect.gen(function* () {
		const api = yield* EmDashContentApi;
		const existing = yield* api.read(request, "exclusions", input.slug);
		if (!existing) return `exclusion ${input.slug} was not recorded`;
		const before = str(existing.data.state) ?? "active";
		if (!exclusionIsActive(before)) return `${input.slug} was already lifted`;
		yield* writeAndPublish(
			request,
			"exclusions",
			input.slug,
			{
				...existing.data,
				state: "lifted",
				lifted_at: new Date().toISOString(),
				lifted_by: input.actor?.id ?? null,
				lift_reason: input.reason,
			},
			existing.rev,
		);
		yield* recordAudit(request, {
			action: "exclusion-lifted",
			subjectType: "example",
			subjectSlug: str(existing.data.match) ?? input.slug,
			field: "state",
			before,
			after: "lifted",
			detail: input.reason,
			actor: input.actor,
		});
		return `${str(existing.data.match) ?? input.slug} may be ingested again`;
	});
}

/* -------------------------------------------------------------------------- */
/* Republishing a possibility                                                   */
/* -------------------------------------------------------------------------- */

export interface RepublishResult {
	outcomes: string[];
	/** True when the entry's own rights status weakened as a result. */
	weakened: boolean;
}

const RIGHTS_STRENGTH = ["cleared", "attribution", "review", "reference"];

/** Whether a status is weaker than another. An unrecognised value counts as weakest. */
function isWeaker(before: string | null, after: string | null): boolean {
	const a = RIGHTS_STRENGTH.indexOf(String(before ?? "reference"));
	const b = RIGHTS_STRENGTH.indexOf(String(after ?? "reference"));
	return a === -1 || b === -1 ? b !== a : b > a;
}

/**
 * Recomputes a possibility after one of its examples went away.
 *
 * The claim being implemented is in `docs/ARCHITECTURE.md`: *a possibility concept
 * does not necessarily need deletion merely because one example must be removed.*
 * So this does three things and refuses two:
 *
 * - sets `example_count` and `distinct_sources` to what is actually there;
 * - re-floors `rights_status` across the examples that remain, so an entry cannot
 *   keep the strongest claim its examples ever made;
 * - moves the representative to another example and says which, because a wall that
 *   silently swapped its picture is unexplainable;
 * - **does not delete the entry**, and **does not touch `machine_synced_at`** — that
 *   is the engine's field, and a curator recomputing a count is not a crawl.
 *
 * `distinct_sources` counts only examples whose licence was read. Counting the ones
 * it could not read is how "0 verified sources" becomes a plausible-looking number,
 * which is the fabricated evidence the architecture document exists to prevent.
 */
export function republishPossibility(
	request: EmDashRequest,
	input: {
		possibilitySlug: string;
		/** The examples still standing, as read from the CMS. */
		examples: ExampleFacts[];
		/** The full set before the removal. Used only to explain the change. */
		before?: ExampleFacts[];
		actor: Actor | null;
	},
): Effect.Effect<RepublishResult, TakedownWrite | CatalogueDecodeError, EmDashContentApi | EmDashContent> {
	return Effect.gen(function* () {
		const api = yield* EmDashContentApi;
		const emdash = yield* EmDashContent;
		const recomputed = recomputePossibility(input.before ?? input.examples, input.examples);
		const outcomes: string[] = [];

		const entry = yield* emdash.entry("possibilities", input.possibilitySlug);
		const record = (entry.entry?.data ?? {}) as Record<string, unknown>;
		const found = yield* api.read(request, "possibilities", input.possibilitySlug);
		if (!found) {
			return {
				outcomes: [`entry ${input.possibilitySlug} is not in the catalogue`],
				weakened: false,
			};
		}

		const next: Record<string, unknown> = {
			...record,
			example_count: recomputed.exampleCount,
			distinct_sources: recomputed.distinctSources,
			rights_status: recomputed.rightsStatus,
		};
		yield* writeAndPublish(request, "possibilities", input.possibilitySlug, next, found.rev);

		for (const field of ["example_count", "distinct_sources", "rights_status"]) {
			const from = fieldValue(record, field);
			const to = fieldValue(next, field);
			if (from === to) continue;
			outcomes.push(`${field}: ${from ?? "unset"} → ${to ?? "unset"}`);
			yield* recordAudit(request, {
				action: "possibility-republished",
				subjectType: "possibility",
				subjectSlug: input.possibilitySlug,
				field,
				before: from,
				after: to,
				detail: recomputed.notes.join("; ") || "recomputed from the examples that remain",
				actor: input.actor,
			});
		}

		return {
			outcomes,
			weakened: isWeaker(fieldValue(record, "rights_status"), recomputed.rightsStatus),
		} satisfies RepublishResult;
	});
}

/* -------------------------------------------------------------------------- */
/* The reporter path                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether a report should trigger the immediate withdrawal path.
 *
 * A narrow gate rather than "always". A broken preview must not withdraw a
 * download, and treating every report as a takedown would make the ordinary
 * reports meaningless and would bury the rights ones among them.
 */
export function shouldWithdrawOnFiling(reason: ReportReason): boolean {
	return isRightsSensitive(reason);
}

/**
 * What a filed rights report did, in one line, for the reader who filed it.
 *
 * Composed here rather than in the route so the note and the effect that produced it
 * cannot disagree. Two ways that could happen, and both are real:
 *
 * - the write failed, and a note claiming the asset was withdrawn would be a lie
 *   told to the person who most needs the truth;
 * - the write succeeded but *withheld nothing* — the subject had been deleted, or was
 *   a possibility whose reason does not withdraw the entry — and "your work is no
 *   longer being served" would be just as untrue.
 *
 * So the note is a function of the outcomes, not of the fact that a call returned.
 */
export function filedNoteFromOutcomes(
	reason: ReportReason,
	subjectType: SubjectType,
	outcomes: readonly string[],
	failed: boolean,
): string {
	/*
	 * "Withheld" means a *subject* changed, not that a case was opened — and the
	 * distinction is the whole point. `openDispute` always says it opened a dispute
	 * "as quarantined", including for a subject that is not in the catalogue at all,
	 * so matching the word "quarantined" claims a withdrawal that never happened.
	 * Match the two outcomes that are a change to the subject: an example's
	 * `dispute_state` moving to quarantined, or an entry's `visibility` moving to
	 * hidden. "Already quarantined" counts, because then it is withheld.
	 */
	const withheld = outcomes.some(
		(outcome) =>
			/dispute_state .*→ *quarantined/.test(outcome) ||
			/visibility .*→ *hidden/.test(outcome) ||
			/already quarantined/.test(outcome),
	);
	if (failed || !withheld) {
		return "Filed, but nothing was withheld automatically — it is at the top of the queue and an editor has to do it";
	}
	return filedNote(reason, subjectType);
}

/* -------------------------------------------------------------------------- */
/* What the cockpit needs                                                       */
/* -------------------------------------------------------------------------- */

export interface RightsQueue {
	/** Live cases. */
	live: Dispute[];
	/** Closed cases, so "what did we do about this" is answerable. */
	resolved: Dispute[];
	/** Standing exclusions, active first. */
	exclusions: Exclusion[];
}

/**
 * The cockpit's rights queue, in the order a curator should work it.
 *
 * Pure from three lists so the ordering is testable without a CMS, and so the page
 * cannot accidentally sort a takedown below a typo.
 */
export function buildRightsQueue(input: {
	disputes: Dispute[];
	exclusions: Exclusion[];
}): RightsQueue {
	return {
		live: [...input.disputes.filter(isLive)].sort(
			(a, b) =>
				a.subjectType.localeCompare(b.subjectType) || a.subjectSlug.localeCompare(b.subjectSlug),
		),
		resolved: input.disputes.filter((dispute) => !isLive(dispute)),
		exclusions: [...input.exclusions].sort(
			(a, b) =>
				Number(b.active) - Number(a.active) ||
				a.scope.localeCompare(b.scope) ||
				a.match.localeCompare(b.match),
		),
	};
}

/**
 * A one-line summary of a dispute, for a queue row.
 *
 * Uses the vocabulary's labels rather than the stored slugs, so a case reads as
 * "Quarantined · Alleged rights infringement" rather than "quarantined ·
 * rights-infringement". A term is chosen once, in `docs/VOCABULARY.md`, and looked
 * up everywhere else.
 */
export function disputeSummary(dispute: Dispute): string {
	const state = dispute.state ? DISPUTE_STATE_LABEL[dispute.state] : dispute.rawState;
	return `${state} · ${REPORTS[dispute.reason].label}`;
}

/** The examples a possibility may still represent, as the recompute sees them. */
export { representable as usableExamples };