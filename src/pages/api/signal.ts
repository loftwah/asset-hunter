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
 */
import type { APIRoute } from "astro";
import { parseReason, parseStars, parseSubjectType } from "../../lib/rating.ts";
import { actorFrom, createReport, saveRating } from "../../lib/signals.ts";

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
	const headers: Record<string, string> = {
		"X-EmDash-Request": "1",
		"content-type": "application/json",
	};

	const finish = (note: string, ok: boolean) => {
		const target = new URL(returnTo, request.url);
		target.searchParams.set(note === "" ? "note" : "note", note);
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
		try {
			const endpoint = new URL("/", request.url).origin;
			// The public session cookie is what the CMS API needs; the reader's
			// browser already has it, so it is forwarded rather than re-issued.
			const cookie = request.headers.get("cookie") ?? "";
			await saveRating(endpoint, { ...headers, cookie }, {
				subjectType,
				subjectSlug,
				stars,
				actor,
			});
		} catch (err) {
			return finish(
				`Could not save the rating: ${err instanceof Error ? err.message : "unknown error"}`,
				false,
			);
		}
		return finish(stars === 1 ? "Recorded — 1 star, which is a rating, not a report" : "Rating recorded", true);
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
			// EmDash's content API is RBAC-protected, so a report has nowhere to
			// live without a session. That is the constraint, and it is stated
			// plainly rather than hidden behind a 401: the alternative — an
			// anonymous store beside the CMS — is the parallel-store thing this
			// project's architecture forbids.
			return finish("Sign in to file a report, so it can be answered and closed", false);
		}
		if (!detail) return finish("Add a line about what is wrong", false);
		// A detail that looks like markup is stored as text and never rendered as
		// HTML anywhere, but it is stripped here so it cannot be copied into a
		// future email notification verbatim.
		const safeDetail = detail.replace(/[<>]/g, "").slice(0, 2000) || null;
		try {
			const endpoint = new URL("/", request.url).origin;
			const cookie = request.headers.get("cookie") ?? "";
			await createReport(endpoint, { ...headers, cookie }, {
				subjectType,
				subjectSlug,
				reason,
				detail: safeDetail,
				actor,
			});
		} catch (err) {
			return finish(
				`Could not file the report: ${err instanceof Error ? err.message : "unknown error"}`,
				false,
			);
		}
		return finish(
			reason === "licence-changed"
				? "Filed — a licence concern is read before anything else"
				: "Filed for an editor",
			true,
		);
	}

	return finish("Unknown request", false);
};

export { EMAIL };