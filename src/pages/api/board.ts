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
 */
import type { APIRoute } from "astro";
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
	const { possibilities } = await loadPossibilities();
	const known = new Set(possibilities.map((p) => p.slug));

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
	if (slug && action !== "rename") url.searchParams.set("saved", slug);
	return redirect(url.pathname + url.search, 303);
};