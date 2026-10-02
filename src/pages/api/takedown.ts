/**
 * The rights-correction actions an editor takes (#54).
 *
 * A form POST, like `/api/signal` and `/api/board`: these are choices a person
 * makes, not a JSON API, and a control that needs a script is a control that
 * breaks. Every action answers with a redirect and a note, so the cockpit's page
 * reloads with what happened written in it — the same `OutcomeFlash` contract the
 * rest of the app uses.
 *
 * ## Why this is an endpoint and not a CMS form
 *
 * EmDash owns the *record*, and a curator corrects `rights_status` and
 * `licence_evidence` in the admin, where EmDash keeps its revisions. What lives
 * here is the workflow around that: opening and closing a case, withholding and
 * releasing a download, recording a source exclusion, and recomputing a
 * possibility after one of its examples went away.
 *
 * Each of those writes EmDash content, and each of them writes its own audit row
 * saying which field moved and why. So this is not "an admin action outside the
 * revision history" — the entry write still goes through EmDash's own content API
 * and lands in its revisions. What is added is the *why*, which a CMS field
 * cannot carry on its own.
 *
 * ## The gate
 *
 * `role >= editor`, checked against EmDash's session exactly as `/curate` does.
 * Anything less is a 404 rather than a 403, for the same reason: a queue of
 * unfinished rights cases is information about the catalogue, and a 403 confirms
 * that the queue exists.
 *
 * The runner lives in `../../lib/effect/root.ts` and nowhere else, so this handler
 * is an adapter: it owns HTTP, the session cookie and the redirect, and nothing
 * about how the Effect application is built or run.
 */
import type { APIRoute } from "astro";
import { Cause, Exit, Option } from "effect";
import { actorFrom } from "../../lib/signals.ts";
import { parseExclusionScope } from "../../lib/disputes.ts";
import { parseReason } from "../../lib/rating.ts";
import {
	excludeSource,
	liftExclusion,
	releaseQuarantine,
	resolveDispute,
	republishPossibility,
	type Resolution,
} from "../../lib/takedown.ts";
import { describeError } from "../../lib/effect/errors.ts";
import type { ExampleFacts } from "../../lib/disputes.ts";
import { runAppExit, type EmDashRequest } from "../../lib/effect/root.ts";

/** EmDash's roles, by level. Editor is the threshold, as on `/curate`. */
const EDITOR = 40;

const MAX_NOTE = 400;

export const POST: APIRoute = async ({ request, redirect, locals }) => {
	const form = await request.formData();
	const intent = String(form.get("intent") ?? "");
	const back = String(form.get("back") ?? "/curate");
	// Same guard as `/api/signal`: a `back` that is not a local path is not a path
	// we are willing to send a reader to.
	const returnTo = back.startsWith("/") && !back.startsWith("//") ? back : "/curate";

	const note = (value: unknown) => String(value ?? "").trim().slice(0, MAX_NOTE) || null;

	const viewer = actorFrom(locals?.user);
	const level = Number((locals?.user as { role?: unknown } | undefined)?.role ?? 0);
	if (!viewer || level < EDITOR) {
		// 404, not 403: this endpoint is not a thing that exists for you.
		return new Response("Not found", { status: 404 });
	}

	const emdash: EmDashRequest = {
		endpoint: new URL("/", request.url).origin,
		headers: {
			"X-EmDash-Request": "1",
			"content-type": "application/json",
			cookie: request.headers.get("cookie") ?? "",
		},
	};

	const finish = (message: string, ok: boolean) => {
		const target = new URL(returnTo, request.url);
		target.searchParams.set("note", message);
		if (!ok) target.searchParams.set("problem", "1");
		return redirect(target.pathname + target.search, 303);
	};

	// ── Release a quarantine applied in error ────────────────────────────────
	if (intent === "release") {
		const exampleSlug = String(form.get("example") ?? "").slice(0, 80);
		if (!exampleSlug) return finish("Which example?", false);
		const released = await runAppExit(
			releaseQuarantine(emdash, { exampleSlug, note: note(form.get("note")), actor: viewer }),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(released)) {
			console.error("takedown: release failed", reportCause(released.cause));
			return finish(`Could not release it: ${describeCause(released.cause)}`, false);
		}
		return finish(released.value.join("; "), true);
	}

	// ── Close a case ─────────────────────────────────────────────────────────
	if (intent === "resolve") {
		const dispute = String(form.get("dispute") ?? "").slice(0, 80);
		const subjectSlug = String(form.get("subject") ?? "").slice(0, 120);
		const subjectType = String(form.get("subject_type") ?? "") === "possibility"
			? ("possibility" as const)
			: ("example" as const);
		const outcome = String(form.get("outcome") ?? "");
		const resolution = note(form.get("resolution"));
		if (!dispute || !subjectSlug) return finish("Which case?", false);
		if (outcome !== "corrected" && outcome !== "dismissed") {
			return finish("Say whether it was corrected or did not hold", false);
		}
		// A resolution with no sentence is not a resolution. "Fixed" leaves the next
		// reader — and the next curator — with no idea what was decided or why, which
		// is the state the audit trail exists to prevent.
		if (!resolution) return finish("Say what was decided, in a line", false);

		const resolved = await runAppExit(
			resolveDispute(emdash, {
				disputeSlug: dispute,
				subjectSlug,
				subjectType,
				outcome: outcome as Resolution,
				resolution,
				actor: viewer,
			}),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(resolved)) {
			console.error("takedown: resolve failed", reportCause(resolved.cause));
			return finish(`Could not close the case: ${describeCause(resolved.cause)}`, false);
		}
		return finish(resolved.value.join("; "), true);
	}

	// ── Exclude a source from future ingestion ───────────────────────────────
	if (intent === "exclude") {
		const scope = parseExclusionScope(form.get("scope"));
		const match = String(form.get("match") ?? "").trim().slice(0, 200);
		const reason = parseReason(form.get("reason"));
		if (!scope) return finish("Pick what the exclusion covers", false);
		if (!match) return finish("Say what is excluded, exactly", false);
		const excluded = await runAppExit(
			excludeSource(emdash, {
				scope,
				match,
				reason,
				detail: note(form.get("detail")),
				disputeSlug: String(form.get("dispute") ?? "").slice(0, 80) || null,
				actor: viewer,
			}),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(excluded)) {
			// A refusal is the common case here and it is the editor's own typo, not a
			// CMS failure: `owner/repo` for a repository, a path with a slash in it,
			// 64 hex characters for a hash. Say which rule was not met, because the
			// alternative is an exclusion that looks recorded and matches nothing.
			const refusal = findExclusionRefusal(excluded.cause);
			if (refusal) return finish(refusal.detail, false);
			console.error("takedown: exclude failed", reportCause(excluded.cause));
			return finish(`Could not record the exclusion: ${describeCause(excluded.cause)}`, false);
		}
		return finish(excluded.value.message, true);
	}

	// ── Lift an exclusion ────────────────────────────────────────────────────
	if (intent === "lift") {
		const slug = String(form.get("exclusion") ?? "").slice(0, 80);
		const why = note(form.get("reason"));
		if (!slug) return finish("Which exclusion?", false);
		if (!why) return finish("Say why it is being lifted", false);
		const lifted = await runAppExit(
			liftExclusion(emdash, { slug, reason: why, actor: viewer }),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(lifted)) {
			console.error("takedown: lift failed", reportCause(lifted.cause));
			return finish(`Could not lift it: ${describeCause(lifted.cause)}`, false);
		}
		return finish(lifted.value, true);
	}

	// ── Recompute a possibility after an example went away ───────────────────
	if (intent === "republish") {
		const possibilitySlug = String(form.get("possibility") ?? "").slice(0, 120);
		const before = parseExampleFacts(form.get("before"));
		const after = parseExampleFacts(form.get("after"));
		if (!possibilitySlug) return finish("Which entry?", false);
		if (!after) return finish("Nothing to recompute from", false);
		const republished = await runAppExit(
			republishPossibility(emdash, {
				possibilitySlug,
				examples: after,
				before: before ?? after,
				actor: viewer,
			}),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(republished)) {
			console.error("takedown: republish failed", reportCause(republished.cause));
			return finish(`Could not recompute it: ${describeCause(republished.cause)}`, false);
		}
		const outcome = republished.value;
		const lines = outcome.outcomes.length ? outcome.outcomes : ["nothing changed"];
		// A weakened status is said out loud rather than left in the audit trail,
		// because it is the one case where the entry a reader is looking at just
		// became less reusable than it appeared a minute ago.
		return finish(
			`${possibilitySlug}: ${lines.join("; ")}${outcome.weakened ? " — its rights status weakened, which readers will see" : ""}`,
			true,
		);
	}

	return finish(`Unknown action "${intent.slice(0, 40)}"`, false);
};

/**
 * The example facts a recompute is computed from.
 *
 * Passed as JSON by the cockpit's form because the decision is *derived from the
 * examples*, and the page has already read them — asking the server to re-read
 * every example of every possibility on every click would be a request per
 * possibility for a calculation that is pure.
 *
 * Narrowed here rather than trusted: the page is ours, but a form field is a form
 * field, and the alternative to narrowing it is writing whatever arrived into the
 * public catalogue's aggregate fields.
 */
function parseExampleFacts(value: FormDataEntryValue | null): ExampleFacts[] | null {
	if (typeof value !== "string" || !value.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const facts: ExampleFacts[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		const slug = typeof row.slug === "string" ? row.slug.slice(0, 120) : "";
		if (!slug) continue;
		facts.push({
			slug,
			rightsStatus: typeof row.rightsStatus === "string" ? row.rightsStatus : null,
			origin: typeof row.origin === "string" ? row.origin : null,
			sourcePath: typeof row.sourcePath === "string" ? row.sourcePath : null,
			contentHash: typeof row.contentHash === "string" ? row.contentHash : null,
			disputeState: typeof row.disputeState === "string" ? row.disputeState : null,
		});
	}
	return facts;
}

/* -------------------------------------------------------------------------- */
/* Typed failures into sentences                                                */
/* -------------------------------------------------------------------------- */

/**
 * The write failure inside a `Cause`, if there is one.
 *
 * The same shape `/api/signal.ts` uses. A defect — anything without a `_tag` we
 * recognise — is not described to a curator as though it were a CMS refusal; the
 * log gets the cause and the curator gets a flat sentence.
 */
const writeFailure = (cause: Cause.Cause<unknown>) => {
	const found = Cause.findErrorOption(cause);
	if (Option.isNone(found)) return null;
	const value: unknown = found.value;
	if (value === null || typeof value !== "object" || !("_tag" in value)) return null;
	const tag = (value as { _tag: unknown })._tag;
	return tag === "EmDashWriteError" || tag === "EmDashTransportError"
		? (value as { _tag: string } & Record<string, unknown>)
		: null;
};

/**
 * The refusal inside a `Cause`, when the failure was a refusal rather than a
 * transport problem.
 *
 * Narrowed by its own `_tag` rather than by an `instanceof`, because the value has
 * crossed a module boundary and a `Schema.TaggedError` is identified by the tag
 * that is written down — which is the same reason `writeFailure` below matches on
 * tags.
 */
function findExclusionRefusal(cause: Cause.Cause<unknown>): { detail: string } | null {
	const found = Cause.findErrorOption(cause);
	if (Option.isNone(found)) return null;
	const value: unknown = found.value;
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	return record._tag === "ExclusionRefused" && typeof record.detail === "string"
		? { detail: record.detail }
		: null;
}

function describeCause(cause: Cause.Cause<unknown>): string {
	const failure = writeFailure(cause);
	if (!failure) return "EmDash could not be reached";
	return failure._tag === "EmDashWriteError"
		? `refused with HTTP ${failure.status}`
		: describeError(failure as never);
}

function reportCause(cause: Cause.Cause<unknown>): unknown {
	const failure = writeFailure(cause);
	if (!failure) return Cause.pretty(cause);
	return { summary: describeError(failure as never), detail: String(failure.detail ?? "").slice(0, 160) };
}