/**
 * The board endpoint.
 *
 * A plain form POST that sets a cookie and redirects back. No JavaScript: the
 * save control has to work with the same fingers that scroll the wall, and a
 * feature that needs a script to record a list is a feature that breaks.
 *
 * `Cache-Control: no-store` matters more than it looks: a redirect carrying a
 * Set-Cookie is exactly the kind of response a cache will helpfully serve to the
 * next person.
 *
 * ## The Effect boundary (#62)
 *
 * This handler is a framework edge, and it is one of the few places allowed to
 * call a runner. `runAppExit` lives in `../../lib/effect/root.ts` and is not
 * called from anywhere else in `src/`, so every route gets the same layer graph,
 * the same timeouts and the same cancellation wiring.
 *
 * `runAppExit` rather than `runApp` so a CMS failure answers 503 instead of
 * throwing out of the handler. A board cannot be written without validating its
 * slugs against the catalogue, and silently writing an unvalidated cookie is the
 * one thing this endpoint must not do.
 *
 * The board *rules* are untouched and still pure: `parseBoards`,
 * `normaliseBoardName`, `applyAction` and `serialiseBoards` are synchronous
 * functions over strings, and `tests/board.test.ts` exercises them with no server
 * and no Effect runtime. Only the catalogue read is effectful.
 *
 * ## What #53 added here
 *
 * A board cookie is `httpOnly` and per-browser, so the worst a cross-origin
 * write can do is overwrite one reader's own shortlist. It is still a
 * state-changing endpoint backed by a CMS read per request, so it now makes the
 * three checks the signal endpoint makes — {@link sameOrigin}, a resolved
 * {@link safeReturnPath}, and the {@link RateLimits} window — rather than being
 * the one write path that has none of them. The board's window is deliberately
 * much looser than a rating's: it writes a cookie and no row.
 */
import type { APIRoute } from "astro";
import { Effect, Exit } from "effect";
import {
	COOKIE_NAME,
	COOKIE_OPTIONS,
	applyAction,
	boardCanManage,
	normaliseBoardName,
	parseBoards,
	serialiseBoards,
	type BoardAction,
} from "../../lib/board";
import { loadPossibilities } from "../../lib/catalogue";
import { BOARD_LIMIT, RateLimits } from "../../lib/effect/limits.ts";
import { runAppExit } from "../../lib/effect/root.ts";
import { crossOriginResponse, safeReturnPath, sameOrigin } from "../../lib/security.ts";

const ACTIONS: BoardAction[] = ["save", "unsave", "remove", "clear", "rename"];

export const POST: APIRoute = async ({ request, redirect, cookies }) => {
	const origin = new URL("/", request.url).origin;
	const verdict = sameOrigin({ headers: request.headers, origin });
	if (!verdict.sameOrigin) {
		console.warn(`board: refused a cross-origin write (${verdict.why})`);
		return crossOriginResponse();
	}

	const form = await request.formData();
	const action = String(form.get("action") ?? "") as BoardAction;
	const slug = String(form.get("slug") ?? "");
	const board = normaliseBoardName(String(form.get("board") ?? ""));
	const to = String(form.get("to") ?? "");
	// Where to return to. Only same-origin paths, proved by resolving rather than
	// by a prefix test — see `safeReturnPath` for the `/\evil.com` form that a
	// `startsWith("/")` check waves through.
	const back = String(form.get("back") ?? "/board");
	const returnTo = safeReturnPath(back, origin, "/board");

	if (!ACTIONS.includes(action)) {
		return new Response("Unknown action", { status: 400 });
	}

	// A short window over the reader (or their address), because every board POST
	// costs a catalogue read below. See `src/lib/effect/limits.ts` for why this is
	// the second layer under a Cloudflare rate-limiting rule rather than the only one.
	const limited = await runAppExit(
		Effect.flatMap(RateLimits, (limits) =>
			limits.take({
				identity: `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
				limit: BOARD_LIMIT.limit,
				windowMs: BOARD_LIMIT.windowMs,
				subject: "shortlist",
			}),
		),
		{ signal: request.signal },
	);
	if (Exit.isSuccess(limited) && !limited.value.allowed) {
		return new Response(limited.value.reason, {
			status: 429,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"retry-after": String(limited.value.retryAfterSeconds),
			},
		});
	}

	// Every slug is checked against the catalogue. This is what makes an
	// unsigned cookie safe: a value that names nothing simply disappears.
	const loaded = await runAppExit(loadPossibilities(), { signal: request.signal });
	if (!Exit.isSuccess(loaded)) {
		return new Response("Catalogue unavailable", { status: 503 });
	}
	const known = new Set(loaded.value.possibilities.map((p) => p.slug));

	const current = parseBoards(cookies.get(COOKIE_NAME)?.value);
	/*
	 * Whether there is anything on the board being acted on, decided by the same
	 * rule the page uses to decide whether to offer the control (#65). The form is
	 * not rendered on an empty board, but a request can still arrive from a tab
	 * that was rendered before the board was emptied — and a copy of nothing has
	 * to be answered as the refusal it is rather than as a copy.
	 */
	const sourceEntries = (current[board] ?? []).filter((s) => known.has(s)).length;
	const manageable = boardCanManage(sourceEntries);
	const next = applyAction(current, action, { slug, board, to, known });

	// Clearing the last entry removes the cookie rather than leaving an empty one
	// behind in the reader's browser.
	const hasAnything = Object.values(next).some((slugs) => slugs.length > 0);
	cookies.set(COOKIE_NAME, serialiseBoards(next), {
		...COOKIE_OPTIONS,
		// `Secure` only where the request itself is secure. Set unconditionally it
		// would be silently dropped over plain HTTP — including on localhost in
		// Safari, which is a confusing way to lose a reader's shortlist.
		secure: new URL(request.url).protocol === "https:",
		maxAge: hasAnything ? COOKIE_OPTIONS.maxAge : 0,
	});

	const url = new URL(returnTo, request.url);
	/*
	 * Say what actually happened, in the vocabulary `boardOutcome` reads back.
	 *
	 * One `?saved=` for every action was not a simplification: unsaving and
	 * removing set it too, so the one page that rendered it had to guess from
	 * whether the entry was still on the board — which meant unsaving produced no
	 * message at all, and clearing produced none either. One parameter per
	 * outcome, each read back by `boardOutcome`, so the answer cannot disagree
	 * between the wall, the board and the use page.
	 */
	if (slug && (action === "save" || action === "unsave" || action === "remove")) {
		url.searchParams.set(action === "save" ? "saved" : "unsaved", slug);
	}
	if (action === "clear") url.searchParams.set("cleared", "1");
	/*
	 * A copy names the board it copied into, because the reader is sent back to
	 * the board they copied *from* — which is now empty — and "copied to a new
	 * board" left them with no idea where their entries went. A copy of an empty
	 * board says it did nothing instead.
	 */
	if (action === "rename") {
		const destination = normaliseBoardName(to);
		// A name that normalises to the board itself, or to nothing, changes
		// nothing — so it is answered as the refusal it is too.
		if (manageable && destination && destination !== board) {
			url.searchParams.set("copied", destination);
		} else {
			url.searchParams.set("nocopy", "1");
		}
	}
	return redirect(url.pathname + url.search, 303);
};