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
	for (const [name, value] of Object.entries(decoded as Record<string, unknown>)) {
		if (!name || name.length > MAX_BOARD_NAME) continue;
		if (!Array.isArray(value)) continue;
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