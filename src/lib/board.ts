/**
 * Shortlist boards (#36).
 *
 * A board is a list of possibilities a reader is considering, and the only
 * thing it needs to be is *their* list. So it lives in a cookie rather than in a
 * table: no account, no server state, no new collection in the CMS, and clearing
 * your cookies clears it, which is the behaviour you expect from a shopping
 * list.
 *
 * Two consequences worth stating plainly rather than hiding:
 *
 * - **It is per browser.** A board is not shareable and does not follow you to
 *   another machine. That is the trade for it existing at all; a shareable board
 *   needs a server record and an identity, which is a different feature with a
 *   different cost.
 * - **It is not signed.** A reader who edits the cookie can change which public
 *   pages appear on their own board, and nothing else. Every slug is validated
 *   against the catalogue before it is rendered, so a tampered cookie can at
 *   worst produce an empty board — it cannot inject markup, a redirect, or an
 *   entry that does not exist. Signing it would protect nothing that the
 *   validation does not already protect.
 *
 * Boards store **slugs**, not representative example ids, so a board keeps
 * working when a better representative is found later. That is the acceptance
 * criterion in #36 about stable ids, and it is why this is a list of strings
 * rather than a frozen copy of tiles.
 */

export const COOKIE_NAME = "ah_board";
/** A cookie is 4KB. Eight boards of twenty slugs would not fit. */
export const MAX_BOARDS = 6;
export const MAX_PER_BOARD = 24;
export const DEFAULT_BOARD = "default";
export const MAX_BOARD_NAME = 40;

/** What the cookie holds, after validation. */
export type Boards = Record<string, string[]>;

const emptyBoards = (): Boards => ({ [DEFAULT_BOARD]: [] });

/**
 * Parses the cookie. Anything unrecognisable becomes an empty board rather than
 * an error: a corrupted cookie should cost you your board, not the page.
 *
 * ## Names go through `normaliseBoardName` here too (#53)
 *
 * The write path sanitised board names and the read path did not, which meant a
 * hand-edited cookie could carry a name `applyAction` would never have produced
 * — up to 40 characters of anything. The values are rendered through Astro's
 * escaping, so it was never markup; it was a name the app had agreed never to
 * accept, being rendered because nobody re-checked it on the way out.
 *
 * The fix is one call, and it makes the cookie's own parser the place where the
 * invariant lives rather than the place that happens to enforce it.
 */
export function parseBoards(raw: string | null | undefined): Boards {
	if (!raw) return emptyBoards();
	let decoded: unknown;
	try {
		decoded = JSON.parse(decodeURIComponent(raw));
	} catch {
		return emptyBoards();
	}
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
		return emptyBoards();
	}
	const boards: Boards = {};
	for (const [rawName, value] of Object.entries(decoded as Record<string, unknown>)) {
		if (!Array.isArray(value)) continue;
		const name = normaliseBoardName(rawName);
		if (!name || name.length > MAX_BOARD_NAME) continue;
		const slugs = [...new Set(value.filter((s): s is string => typeof s === "string"))].slice(
			0,
			MAX_PER_BOARD,
		);
		if (slugs.length) boards[name] = slugs;
	}
	// The default board always exists so the UI has somewhere to save to.
	if (!boards[DEFAULT_BOARD]) boards[DEFAULT_BOARD] = [];
	const limited = Object.fromEntries(
		Object.entries(boards).slice(0, Math.max(0, MAX_BOARDS - 1)),
	) as Boards;
	return { ...limited, [DEFAULT_BOARD]: boards[DEFAULT_BOARD] ?? [] };
}

/**
 * The cookie value: the encoded board map and nothing else.
 *
 * Not a `Set-Cookie` string. Astro's `cookies.set(name, value, options)` takes
 * the value and the attributes separately, and passing a full header there
 * produces a cookie whose value is literally `ah_board=%7B%22…` — which parses
 * to nothing, so every save appeared to work and vanished on the next request.
 */
export function serialiseBoards(boards: Boards): string {
	const compact: Boards = {};
	for (const [name, slugs] of Object.entries(boards)) {
		if (slugs.length) compact[name] = [...new Set(slugs)].slice(0, MAX_PER_BOARD);
	}
	// A final backstop on the count, ordered so the default board always survives.
	const names = Object.keys(compact);
	const limited = names.slice(0, MAX_BOARDS - 1);
	if (names.includes(DEFAULT_BOARD)) {
		limited[Math.max(0, limited.length - (limited.includes(DEFAULT_BOARD) ? 0 : 1))] =
			DEFAULT_BOARD;
	}
	const bounded: Boards = {};
	for (const name of new Set(limited)) bounded[name] = compact[name];
	return encodeURIComponent(JSON.stringify(bounded));
}

/** Attributes for the cookie. Kept here so the endpoint and the tests agree. */
export const COOKIE_OPTIONS = {
	path: "/",
	maxAge: 60 * 60 * 24 * 90,
	sameSite: "lax",
	httpOnly: true,
	/**
	 * `secure` is **not** set here, and that is deliberate.
	 *
	 * `/api/board` adds it per request, because a cookie written `Secure` over
	 * plain HTTP is dropped by the browser rather than stored insecurely — so
	 * hard-coding it would silently lose a reader's shortlist on any
	 * non-localhost HTTP origin, and Safari drops it on `http://localhost` too.
	 * Setting it exactly when the request is HTTPS gives the flag where it
	 * protects and nowhere it breaks.
	 */
} as const;

/** A board name a person can read, derived from what they typed. */
export function normaliseBoardName(input: string | null | undefined): string {
	const trimmed = (input ?? "").trim().slice(0, MAX_BOARD_NAME);
	if (!trimmed) return DEFAULT_BOARD;
	return trimmed.replace(/\s+/g, " ").replace(/[^\p{L}\p{N} _-]/gu, "");
}

export type BoardAction = "save" | "unsave" | "remove" | "clear" | "rename";

/**
 * Applies one action. Pure, so the endpoint stays a thin shell and the rules
 * are testable without a browser or a server.
 */
export function applyAction(
	boards: Boards,
	action: BoardAction,
	options: { slug?: string; board?: string; to?: string; known?: Set<string> },
): Boards {
	const board = normaliseBoardName(options.board);
	const next: Boards = structuredClone(boards);

	if (action === "clear") {
		next[board] = [];
		return next;
	}

	const slug = options.slug ?? "";
	// Only slugs that exist in the catalogue are ever stored. A cookie that
	// names something else loses that entry, which is the whole of the "not
	// signed" story.
	const valid = !options.known || options.known.has(slug);

	if (action === "save") {
		if (!valid || !slug) return next;
		const current = next[board] ?? [];
		if (current.includes(slug)) return next;
		if (current.length >= MAX_PER_BOARD) return next;
		// The board cap is enforced here as well as on parse, because a cookie
		// that grows without bound is a request that eventually gets rejected by
		// the browser, and the reader's board disappears with it.
		if (!next[board] && Object.keys(next).length >= MAX_BOARDS) return next;
		next[board] = [...current, slug];
		return next;
	}

	if (action === "unsave") {
		next[board] = (next[board] ?? []).filter((s) => s !== slug);
		return next;
	}

	if (action === "remove") {
		// Remove from every board. A possibility can sit in several boards
		// without being duplicated within one, so "remove" has to mean the
		// thing a person means by it.
		for (const name of Object.keys(next)) {
			next[name] = next[name].filter((s) => s !== slug);
		}
		return next;
	}

	if (action === "rename") {
		const from = board;
		const to = normaliseBoardName(options.to);
		if (from === to || !to) return next;
		const moved = next[from] ?? [];
		next[to] = [...new Set([...(next[to] ?? []), ...moved])].slice(0, MAX_PER_BOARD);
		next[from] = [];
		return next;
	}

	return next;
}

/** Total entries across every board, for the summary line. */
export function boardTotals(boards: Boards) {
	const counts = Object.fromEntries(
		Object.entries(boards)
			.filter(([, slugs]) => slugs.length > 0)
			.map(([name, slugs]) => [name, slugs.length]),
	);
	return {
		boards: Object.keys(counts).length,
		items: Object.values(counts).reduce((n, c) => n + c, 0),
		counts,
	};
}

/** A display name for a board that is not the default one. */
export const boardLabel = (name: string) =>
	name === DEFAULT_BOARD ? "Shortlist" : name;

/**
 * Whether the controls that act on a board's entries may be offered at all
 * (#65).
 *
 * Copy, clear and export all act on entries. With none on the board, every one
 * of them is a control that looks live and produces nothing — which `DESIGN.md`
 * §9.6 calls worse than no control ("a control that looks live and is not is
 * worse than no control"), and §1.5 forbids in stronger terms: nothing on
 * screen should be a claim the record does not support.
 *
 * It is a named function rather than an `if` in the template because the page
 * and the endpoint have to agree. A form posted from a tab that was rendered
 * before the board was cleared is a real request, and it must get the same
 * answer as the page that offered the control.
 *
 * `entries` is a count because the two callers count different things on
 * purpose: the page counts what it actually rendered, so a board whose every
 * slug the catalogue rejected is correctly empty here, and the endpoint counts
 * what the cookie holds, which is the only thing it can copy.
 */
export function boardCanManage(entries: number): boolean {
	return entries > 0;
}

/**
 * The boards a reader can switch between, or `null` when there is only one.
 *
 * #65 found the hole this closes: the switcher used to list only boards with
 * entries on them, so after copying a board — which empties the one you copied
 * *from* — the reader landed on an empty board, was told the entries were on
 * `Pirates`, and had no control anywhere on the page that could take them
 * there. The honest zero is the fix, not hiding the board: a board with `0` on
 * it is a real board the reader can go to, which is exactly what they need when
 * the other one is empty.
 *
 * Only ever `null` for a reader with a single board, where a switcher with one
 * entry is a control that does nothing.
 */
export function boardSwitcher(boards: Boards): { name: string; label: string; count: number }[] | null {
	const entries = Object.entries(boards);
	if (entries.length < 2) return null;
	return entries.map(([name, slugs]) => ({ name, label: boardLabel(name), count: slugs.length }));
}

/**
 * What a board POST did, read back out of the query string the endpoint
 * redirects to.
 *
 * The endpoint is a form POST, so its answer arrives as a new page load. Without
 * this, every board action was silent: the tile's own `+`/`✓` told you the
 * result, but clearing a board told you nothing at all, and the only page that
 * said anything inferred "you saved this" from the entry still being present —
 * which is exactly why unsaving said nothing.
 *
 * `titleFor` is supplied by the caller so the message can name the entry in the
 * reader's words and stay pure: the slugs stay strings here.
 *
 * `keptElsewhere` is how many entries survive on the reader's *other* boards,
 * and it exists because the cleared sentence used to be a lie (#65): clearing
 * one board empties that board only, and telling someone whose entries just
 * vanished from the screen that "nothing was kept anywhere else" is a claim
 * about the record that the record does not support. A caller that does not
 * know the count keeps the old wording, which is the honest reading of a
 * request that carried none.
 */
export function boardOutcome(
	params: URLSearchParams,
	titleFor: (slug: string) => string | undefined,
	context: { keptElsewhere?: number } = {},
): { tone: "ok" | "problem"; message: string } | null {
	const saved = params.get("saved");
	if (saved) {
		const name = titleFor(saved);
		return { tone: "ok", message: `Kept on your shortlist: ${name ?? saved}.` };
	}
	const unsaved = params.get("unsaved");
	if (unsaved) {
		const name = titleFor(unsaved);
		return { tone: "ok", message: `Removed from your shortlist: ${name ?? unsaved}.` };
	}
	if (params.get("cleared")) {
		// Clearing empties one board and leaves the others alone, so the second
		// sentence is built from the count rather than assumed. The reader is
		// looking at a board that has just gone empty, which is the worst moment
		// to tell them something false about where their work went.
		const kept = context.keptElsewhere ?? 0;
		return {
			tone: "ok",
			message: kept
				? `This board is empty. ${kept} ${kept === 1 ? "entry is" : "entries are"} kept on your other ${kept === 1 ? "board" : "boards"}.`
				: "This board is empty. Nothing was kept anywhere else.",
		};
	}
	/*
	 * `moved` carries the destination board's name, because the control that sets
	 * it is called **Move** and the code behind it moves.
	 *
	 * It used to be `copied`, behind a button labelled "Copy board" and a
	 * placeholder reading "Copy this board to a new name", over `applyAction`
	 * doing `next[from] = []`. A reader who pressed *Copy* and found their
	 * shortlist gone had to read the confirmation to discover that "copy" meant
	 * "move" (#68) — and `DESIGN.md` §9.5 has always called this thing a
	 * rename. One verb, and the verb is what the code does.
	 *
	 * The sentence also states what is true of the board the reader is looking at,
	 * which is now empty: they have watched their entries leave the screen, and
	 * the endpoint sends them to the destination rather than leaving them to work
	 * that out.
	 */
	const moved = params.get("moved");
	if (moved) {
		return {
			tone: "ok",
			message: `Moved to ${moved}, which now holds them. This board is empty.`,
		};
	}
	/*
	 * Two refusals, not one, because they are different failures with different
	 * fixes (#68).
	 *
	 * `nocopy` is "there was nothing on this board" — a form posted from a tab
	 * rendered before the board was emptied. What the reader needs is entries.
	 *
	 * `nomove` is "that name is not a name" — empty, whitespace, punctuation
	 * only, or the board's own name. The reader has entries; what they lack is a
	 * name that survives `normaliseBoardName`. `DESIGN.md` §8: an error says what
	 * failed and what to try, and the single sentence that used to cover both
	 * told a reader with a full board that their board was empty.
	 */
	if (params.get("nocopy")) {
		return { tone: "problem", message: "Nothing to move: this board is empty." };
	}
	if (params.get("nomove")) {
		return {
			tone: "problem",
			message:
				"That name was not usable, so nothing moved. Use letters, numbers or spaces — and not this board’s own name.",
		};
	}
	return null;
}
