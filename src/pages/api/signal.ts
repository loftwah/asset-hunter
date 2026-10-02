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
 *
 * ## What #53 added here
 *
 * Three controls, in the order a request meets them.
 *
 * 1. **Same-origin, asserted here rather than inherited.**
 *    `security.checkOrigin` is now pinned to `true` in `astro.config.mjs`, and
 *    this handler checks {@link sameOrigin} itself anyway. Two reasons: a
 *    defence one config line away from being switched off is a defence waiting
 *    to be switched off, and the check belongs next to the write it protects,
 *    where a reader can see it. Note what is *not* accepted as proof — the
 *    `X-EmDash-Request` header this handler sets on the request it makes into
 *    EmDash proves nothing about the browser that arrived here.
 * 2. **A subject that exists.** `subject_slug` used to be any string at all, so
 *    one signed-in account could fill the moderation queue with reports and
 *    ratings about entries that were never published. It is now checked against
 *    the catalogue before anything is written.
 * 3. **A window, and a deterministic slug.** {@link RateLimits} blunts the rate;
 *    `reportSlug` in `../../lib/signals.ts` is what actually bounds storage,
 *    because a derived slug makes the duplicate collide with itself rather than
 *    rely on a timer.
 */
import type { APIRoute } from "astro";
import { Cause, Effect, Exit, Option } from "effect";
import { parseReason, parseStars, parseSubjectType } from "../../lib/rating.ts";
import { actorFrom, createReport, saveRating } from "../../lib/signals.ts";
import { loadPossibilities } from "../../lib/catalogue.ts";
import {
	describeDetail,
	describeError,
	type EmDashTransportError,
	type EmDashWriteError,
} from "../../lib/effect/errors.ts";
import { RateLimits, REPORT_LIMIT, RATING_LIMIT } from "../../lib/effect/limits.ts";
import { runAppExit, type EmDashRequest } from "../../lib/effect/root.ts";
import {
	crossOriginResponse,
	isSubjectSlug,
	safeReturnPath,
	sameOrigin,
} from "../../lib/security.ts";

/**
 * Identity for the abuse window.
 *
 * The session user when there is one, otherwise the client address. Cloudflare
 * puts the real client in `CF-Connecting-IP` and proxies do not get to forge
 * it, which is why that is preferred over `X-Forwarded-For` — a header any
 * caller can set would make the limit free to bypass by rotating it.
 */
const clientKey = (request: Request, userId: string | null): string =>
	userId ? `user:${userId}` : `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;

export const POST: APIRoute = async ({ request, locals, url }) => {
	const origin = new URL("/", request.url).origin;

	// Before the body is even parsed: a cross-origin post is refused whatever it
	// contains, and reading a multi-megabyte form first would be free work for
	// whoever is sending it.
	const verdict = sameOrigin({ headers: request.headers, origin });
	if (!verdict.sameOrigin) {
		console.warn(`signal: refused a cross-origin write (${verdict.why})`);
		return crossOriginResponse();
	}

	const form = await request.formData();
	const intent = String(form.get("intent") ?? "");
	const subjectSlug = String(form.get("subject_slug") ?? "").slice(0, 120);
	const subjectType = parseSubjectType(form.get("subject_type"));
	const back = String(form.get("back") ?? url.pathname);
	// Same-origin paths only, proved by resolving rather than by a prefix test —
	// see `safeReturnPath` for the `/\evil.com` form the prefix test misses.
	const returnTo = safeReturnPath(back, origin, "/");

	// EmDash puts the authenticated user here; it is the only identity this app
	// has, and it did not invent one.
	const actor = actorFrom(locals?.user);
	// The public session cookie is what the CMS API needs; the reader's browser
	// already has it, so it is forwarded rather than re-issued.
	const emdash: EmDashRequest = {
		endpoint: origin,
		headers: {
			"X-EmDash-Request": "1",
			"content-type": "application/json",
			cookie: request.headers.get("cookie") ?? "",
		},
	};

	/**
	 * The redirect a form POST answers with, plus the `Retry-After` a refusal
	 * carries.
	 *
	 * **Built rather than delegated to `redirect`, on purpose (#53).** Astro's
	 * helper is `redirect(path, status)` where the second argument is a *status
	 * code*, not a `ResponseInit`:
	 *
	 * ```js
	 * redirect(path, status) {
	 *   return new Response(null, { status: status || 302, headers: { Location: path } })
	 * }
	 * ```
	 *
	 * So `redirect(target, { status: 303, headers })` puts that *object* into
	 * `status`, the `Response` constructor coerces it to `0`, and it throws — for
	 * every POST to this endpoint. That is not a visible failure, it is a
	 * self-amplifying one: the throw becomes a 500, and Astro treats a 500 as
	 * reroutable (`REROUTABLE_STATUS_CODES = [404, 500]`), so it runs the route a
	 * second time with the same `Request`. The second run then fails earlier
	 * still, on `await request.formData()` against a body that is already used —
	 * so the endpoint answered every request, including a valid same-origin one,
	 * with `500 Body has already been used`, and the same-origin check below never
	 * got to answer.
	 *
	 * `new Response(null, { status: 303, headers })` is the same redirect with the
	 * header this needs, and it keeps `Retry-After` — which `redirect()` has no way
	 * to express at all.
	 */
	const finish = (note: string, ok: boolean, retryAfterSeconds = 0) => {
		const target = new URL(returnTo, request.url);
		target.searchParams.set("note", note);
		if (!ok) target.searchParams.set("problem", "1");
		const headers = new Headers({
			location: `${target.pathname}${target.search}`,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		if (retryAfterSeconds > 0) headers.set("retry-after", String(retryAfterSeconds));
		return new Response(null, { status: 303, headers });
	};

	/** The abuse window, as a reader-facing refusal rather than an exception. */
	const limited = async (limit: number, windowMs: number, subject: string) => {
		const decision = await runAppExit(
			Effect.flatMap(
				RateLimits,
				(limits) =>
					limits.take({
						identity: clientKey(request, actor?.id ?? null),
						limit,
						windowMs,
						subject,
					}),
			),
			{ signal: request.signal },
		);
		return Exit.isSuccess(decision) ? decision.value : null;
	};

	if (!subjectType || !isSubjectSlug(subjectSlug)) return finish("Nothing to rate", false);

	// A rating or a report about an entry that is not in the catalogue is a row
	// an editor cannot act on, so it is refused before it exists. Possibilities
	// are the ones readers rate; examples are reached through them, but the JSON
	// contract carries both and an editor may file against either.
	const known = await runAppExit(loadPossibilities(), { signal: request.signal });
	if (!Exit.isSuccess(known)) return finish("The catalogue is unavailable, so nothing was recorded", false);
	const subjects = new Set(known.value.possibilities.map((p) => p.slug));
	if (subjectType === "possibility" && !subjects.has(subjectSlug)) {
		return finish("That entry is not in the catalogue", false);
	}

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
		const gate = await limited(RATING_LIMIT.limit, RATING_LIMIT.windowMs, "rating");
		if (gate && !gate.allowed) return finish(gate.reason, false, gate.retryAfterSeconds);
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
		// notification verbatim. Control characters go too: a detail that can rewrite
		// the terminal line it is later printed on is a detail that can lie to a person.
		const safeDetail = detail.replace(/[<>\u0000-\u001f\u007f]/g, "").slice(0, 2000) || null;
		const gate = await limited(REPORT_LIMIT.limit, REPORT_LIMIT.windowMs, "report");
		if (gate && !gate.allowed) return finish(gate.reason, false, gate.retryAfterSeconds);
		const filed = await runAppExit(
			createReport(emdash, { subjectType, subjectSlug, reason, detail: safeDetail, actor }),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(filed)) {
			console.error("signal: report write failed", reportCause(filed.cause));
			// A collision on the derived slug means this reader has already filed this
			// concern for this entry in this window. That is not an error to apologise
			// for — it is the report already being in the queue.
			const failure = writeFailure(filed.cause);
			if (failure?._tag === "EmDashWriteError" && failure.status === 409) {
				return finish("Already filed — an editor has that report for this entry", true);
			}
			return finish(`Could not file the report: ${describeCause(filed.cause)}`, false);
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
