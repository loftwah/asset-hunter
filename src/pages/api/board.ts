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
 */
import type { APIRoute } from "astro";
import { Exit } from "effect";
import {
	COOKIE_NAME,
	COOKIE_OPTIONS,
	applyAction,
	normaliseBoardName,
	parseBoards,
	serialiseBoards,
	type BoardAction,
} from "../../lib/board";
import { loadPossibilities } from "../../lib/catalogue";
import { runAppExit } from "../../lib/effect/root.ts";

const ACTIONS: BoardAction[] = ["save", "unsave", "remove", "clear", "rename"];

export const POST: APIRoute = async ({ request, redirect, cookies }) => {
	const form = await request.formData();
	const action = String(form.get("action") ?? "") as BoardAction;
	const slug = String(form.get("slug") ?? "");
	const board = normaliseBoardName(String(form.get("board") ?? ""));
	const to = String(form.get("to") ?? "");
	// Where to return to. Only same-origin paths, so the endpoint cannot be used
	// as an open redirect.
	const back = String(form.get("back") ?? "/board");
	const returnTo = back.startsWith("/") && !back.startsWith("//") ? back : "/board";

	if (!ACTIONS.includes(action)) {
		return new Response("Unknown action", { status: 400 });
	}

	// Every slug is checked against the catalogue. This is what makes an
	// unsigned cookie safe: a value that names nothing simply disappears.
	const loaded = await runAppExit(loadPossibilities(), { signal: request.signal });
	if (!Exit.isSuccess(loaded)) {
		return new Response("Catalogue unavailable", { status: 503 });
	}
	const known = new Set(loaded.value.possibilities.map((p) => p.slug));

	const current = parseBoards(cookies.get(COOKIE_NAME)?.value);
	const next = applyAction(current, action, { slug, board, to, known });

	// Clearing the last entry removes the cookie rather than leaving an empty one
	// behind in the reader's browser.
	const hasAnything = Object.values(next).some((slugs) => slugs.length > 0);
	cookies.set(COOKIE_NAME, serialiseBoards(next), {
		...COOKIE_OPTIONS,
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
	if (action === "rename") url.searchParams.set("copied", "1");
	return redirect(url.pathname + url.search, 303);
};