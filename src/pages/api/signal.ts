/**
 * The rating and report endpoint (#37).
 *
 * Both are form POSTs, like the board: a star and a report reason are choices,
 * not documents, and a control that needs a script is a control that breaks.
 *
 * Both require an EmDash session, for different reasons. A rating without an
 * identity is a vote rather than an opinion: it cannot be revised or withdrawn.
 * A report without an identity is a queue entry nothing can answer.
 *
 * Requiring sign-in for a licence correction is uncomfortable, and the first
 * version of this endpoint refused anonymous reports with a raw 401 from the CMS
 * — which is worse than uncomfortable, because it looks like a bug. The UI now
 * says so before the reader tries, and the licensing page carries the contact
 * route for someone with no account at all.
 *
 * ## What #62 changed here
 *
 * This handler used to be the sharpest edge in the repository. It called
 * `saveRating` / `createReport`, caught a thrown `Error`, and pasted
 * `err.message` into a redirect note:
 *
 * ```ts
 * } catch (err) {
 *   return finish(`Could not save the rating: ${err instanceof Error ? err.message : "unknown error"}`, false)
 * }
 * ```
 *
 * and the thrown message was `create rating → HTTP 409 <EmDash's body>`. So an
 * HTTP status and a slice of a CMS error page were on their way to a public URL.
 *
 * Now the write returns a typed `EmDashWriteError` (with the status) or a typed
 * `EmDashTransportError` (no status at all), and `describeError` turns either
 * into a sentence that says what happened without quoting the CMS at a reader.
 * The status is still logged, and it is still exactly as diagnosable.
 *
 * The runner lives in `../../lib/effect/root.ts` and nowhere else, so this
 * handler is an adapter: it owns HTTP, the session cookie and the redirect, and
 * nothing about how the Effect application is built or run.
 */
import type { APIRoute } from "astro";
import { Cause, Exit, Option } from "effect";
import { parseReason, parseStars, parseSubjectType } from "../../lib/rating.ts";
import { actorFrom, createReport, saveRating } from "../../lib/signals.ts";
import {
	filedNoteFromOutcomes,
	openDispute,
	shouldWithdrawOnFiling,
} from "../../lib/takedown.ts";
import {
	describeDetail,
	describeError,
	type EmDashTransportError,
	type EmDashWriteError,
} from "../../lib/effect/errors.ts";
import { runAppExit, type EmDashRequest } from "../../lib/effect/root.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const POST: APIRoute = async ({ request, redirect, locals, url }) => {
	const form = await request.formData();
	const intent = String(form.get("intent") ?? "");
	const subjectSlug = String(form.get("subject_slug") ?? "").slice(0, 120);
	const subjectType = parseSubjectType(form.get("subject_type"));
	const back = String(form.get("back") ?? url.pathname);
	const returnTo = back.startsWith("/") && !back.startsWith("//") ? back : "/";

	// EmDash puts the authenticated user here; it is the only identity this app
	// has, and it did not invent one.
	const actor = actorFrom(locals?.user);
	// The public session cookie is what the CMS API needs; the reader's browser
	// already has it, so it is forwarded rather than re-issued. `X-EmDash-Request`
	// is EmDash's same-origin CSRF proof — without it every state-changing
	// request is rejected.
	const emdash: EmDashRequest = {
		endpoint: new URL("/", request.url).origin,
		headers: {
			"X-EmDash-Request": "1",
			"content-type": "application/json",
			cookie: request.headers.get("cookie") ?? "",
		},
	};

	const finish = (note: string, ok: boolean) => {
		const target = new URL(returnTo, request.url);
		target.searchParams.set("note", note);
		if (!ok) target.searchParams.set("problem", "1");
		return redirect(target.pathname + target.search, 303);
	};

	if (!subjectType || !subjectSlug) return finish("Nothing to rate", false);

	if (intent === "rate") {
		const stars = parseStars(form.get("stars"));
		if (stars === null) {
			// `stars=` in a form arrives as an empty string, which parses to 0.
			// Refusing is better than storing 0, which would drag every average
			// towards zero and be invisible afterwards.
			return finish("A rating has to be 1 to 5 stars", false);
		}
		if (!actor) {
			return finish("Sign in to rate — an unattributed rating cannot be revised or withdrawn", false);
		}
		const saved = await runAppExit(
			saveRating(emdash, { subjectType, subjectSlug, stars, actor }),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(saved)) {
			// The detail goes to the log; the reader gets the sentence. This split is
			// the whole point of the typed failure: before #62 both went to the reader.
			console.error("signal: rating write failed", reportCause(saved.cause));
			return finish(`Could not save the rating: ${describeCause(saved.cause)}`, false);
		}
		return finish(
			stars === 1 ? "Recorded — 1 star, which is a rating, not a report" : "Rating recorded",
			true,
		);
	}

	if (intent === "report") {
		const reason = parseReason(form.get("reason"));
		const detail = String(form.get("detail") ?? "")
			.trim()
			.slice(0, 2000);
		if (!reason) return finish("Pick what is wrong", false);
		// A report with no detail and no account is anonymous and unactionable,
		// so it asks for one line rather than accepting an empty queue entry.
		if (!actor) {
			// EmDash's content API is RBAC-protected, so a report has nowhere to live
			// without a session. That is the constraint, and it is stated plainly
			// rather than hidden behind a 401: the alternative — an anonymous store
			// beside the CMS — is the parallel-store thing this project's architecture
			// forbids.
			return finish("Sign in to file a report, so it can be answered and closed", false);
		}
		if (!detail) return finish("Add a line about what is wrong", false);
		// A detail that looks like markup is stored as text and never rendered as HTML
		// anywhere, but it is stripped here so it cannot be copied into a future email
		// notification verbatim.
		const safeDetail = detail.replace(/[<>]/g, "").slice(0, 2000) || null;
		const filed = await runAppExit(
			createReport(emdash, { subjectType, subjectSlug, reason, detail: safeDetail, actor }),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(filed)) {
			console.error("signal: report write failed", reportCause(filed.cause));
			return finish(`Could not file the report: ${describeCause(filed.cause)}`, false);
		}

		// A rights report is not a queue entry that waits to be read (#54). Somebody
		// saying "this is my work, take it down" or "you have my licence wrong" has
		// told us something material, and the honest response is to withdraw the
		// direct-use path now and let a curator decide the rest.
		//
		// A *quality* report deliberately does not come through here. Treating every
		// report as a takedown would make the ordinary ones meaningless and would hide
		// the rights ones among them.
		if (!shouldWithdrawOnFiling(reason)) {
			return finish(
				reason === "licence-changed"
					? "Filed — a licence concern is read before anything else"
					: "Filed for an editor",
				true,
			);
		}

		const dispute = await runAppExit(
			openDispute(emdash, {
				subjectType,
				subjectSlug,
				reason,
				detail: safeDetail,
				actor,
			}),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(dispute)) {
			// The report is filed and the withdrawal is not. Saying "filed" alone
			// would leave somebody believing their file is no longer being served when
			// it is — so the note says what did not happen, and the log has why.
			console.error("signal: withdrawal after rights report failed", reportCause(dispute.cause));
			return finish(
				filedNoteFromOutcomes(reason, subjectType, [], true),
				false,
			);
		}
		// The outcomes are logged rather than shown: a reader filing a takedown needs
		// to know their work is no longer being served, not which CMS collections were
		// written. The cockpit has the full text for anyone who is deciding.
		console.info("signal: rights report withdrew the direct-use path", dispute.value.outcomes);
		return finish(filedNoteFromOutcomes(reason, subjectType, dispute.value.outcomes, false), true);
	}

	return finish("Unknown request", false);
};

/** The typed write failure inside a `Cause`, if there is one. */
const writeFailure = (cause: Cause.Cause<unknown>) => {
	const found = Cause.findErrorOption(cause);
	if (Option.isNone(found)) return null;
	const value: unknown = found.value;
	if (value === null || typeof value !== "object" || !("_tag" in value)) return null;
	const tag = (value as { _tag: unknown })._tag;
	return tag === "EmDashWriteError" || tag === "EmDashTransportError"
		? (value as EmDashWriteError | EmDashTransportError)
		: null;
};

/**
 * A reader-facing sentence for a failed write.
 *
 * `describeError` covers the two typed write failures. Anything else here is a
 * defect, and a defect has no business being described to a reader as though it
 * were a CMS refusal — so it gets a flat sentence and the log gets the cause.
 */
function describeCause(cause: Cause.Cause<unknown>): string {
	const failure = writeFailure(cause);
	return failure ? describeError(failure) : "EmDash could not be reached";
}

/** The same cause, with the truncated detail, for the log. */
function reportCause(cause: Cause.Cause<unknown>): unknown {
	const failure = writeFailure(cause);
	if (!failure) return Cause.pretty(cause);
	return { summary: describeError(failure), detail: describeDetail(failure) };
}

export { EMAIL };
