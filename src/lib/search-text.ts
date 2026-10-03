/**
 * Search result text (#63).
 *
 * Two rules that both used to be violated on every result row, and both of
 * which read as a rendering fault rather than as a design choice:
 *
 * 1. **The vertical and the media kind are not the same fact.** `Motion / Video`
 *    and `Motion` are, so the row says the same word twice. `facetLabels`
 *    drops the second when the first subsumes it, and distinguishes them when
 *    it does not.
 * 2. **A windowed excerpt starts on a word boundary.** `indexOf` returns a
 *    character index, so slicing a fixed window back from a match lands
 *    mid-word whenever the match is not near a sentence boundary — `…aking`,
 *    `…sult`, `…n-space`. `excerpt` snaps to the start of the word instead,
 *    because a label that opens mid-word makes the *reason* for a match harder
 *    to read than the title it sits under.
 *
 * Pure, and therefore testable without a running catalogue.
 */

import { MEDIA_LABEL, verticalLabel } from "./vocabulary.ts";

/**
 * The labels a result row shows, with duplicates removed.
 *
 * Three cases, and the third is why this is not a `Set`:
 *
 * - identical → one label. `Typography` twice is noise.
 * - the media label is a substring of the vertical → one label.
 *   `Motion / Video` + `Motion` and `Audio / Music` + `Audio` both stutter.
 * - otherwise → both, in vertical-then-media order, because a reader
 *   genuinely cannot tell "Motion / Video" from "Motion" without seeing both.
 *
 * The order is fixed so two runs produce the same row.
 */
export function facetLabels(
	vertical: string | null | undefined,
	mediaKind: string | null | undefined,
): string[] {
	const out: string[] = [];
	const push = (label: string | null | undefined) => {
		const value = label?.trim();
		if (!value) return;
		out.push(value);
	};

	const v = vertical ? verticalLabel(vertical) : null;
	const m = mediaKind ? (MEDIA_LABEL[mediaKind] ?? mediaKind) : null;

	if (v) push(v);
	if (m) {
		const already = out.some(
			(existing) => existing === m || existing.toLowerCase().includes(m.toLowerCase()),
		);
		if (!already) push(m);
	}
	return out;
}

export interface ExcerptOptions {
	/** Characters of context either side of the match. */
	window?: number;
	/** The terms worth marking. Shorter than these matches nothing worth showing. */
	terms?: readonly string[];
}

/**
 * A window of `text` around the first match, starting and ending on word
 * boundaries and with the query terms marked.
 *
 * The text is escaped before any markup is added and only whole matched groups
 * are wrapped, so query text can never reach the page as markup.
 */
export function excerpt(
	text: string | null | undefined,
	options: ExcerptOptions = {},
): string | null {
	if (!text) return null;
	const window = options.window ?? 190;
	const terms = (options.terms ?? []).filter((t) => t.length > 2);
	const lower = text.toLowerCase();

	// The earliest match wins, so a summary matching two terms opens on the
	// first one rather than on whichever the query happened to list first.
	let at = -1;
	for (const term of terms) {
		const found = lower.indexOf(term.toLowerCase());
		if (found !== -1 && (at === -1 || found < at)) at = found;
	}

	if (at === -1) {
		// No match in this field. Take the opening, snapped forward to the end of
		// a whole word so a truncated summary does not end mid-syllable.
		const head = text.slice(0, window).trimStart();
		const end = snapEnd(head, head.length);
		const cut = end < head.length ? `${head.slice(0, end).trimEnd()}…` : head;
		return markTerms(cut, terms);
	}

	const rawStart = Math.max(0, at - Math.floor(window / 3));
	const start = snapStart(text, rawStart);
	const end = snapEnd(text, Math.min(text.length, start + window));

	return `${start > 0 ? "…" : ""}${markTerms(text.slice(start, end).trim(), terms)}${
		end < text.length ? "…" : ""
	}`;
}

/**
 * Moves `index` back to the start of the word it lands in.
 *
 * The minimum is to advance past whitespace; snapping to the word start is
 * better, because `…aking` and `…sult` both read as corruption. Bounded so a
 * match in the first characters does not walk back through the whole string,
 * and so the leading ellipsis is not spent on a word fragment.
 */
export function snapStart(text: string, index: number, limit = 40): number {
	let at = Math.max(0, Math.min(index, text.length));
	// A window that opens on whitespace opens on nothing, so step off it first.
	// Otherwise the backward walk below would land on the *previous* word and the
	// window would silently lose it.
	while (at < text.length && /\s/.test(text[at] ?? " ")) at += 1;
	const floor = Math.max(0, at - limit);
	while (at > floor && !/\s/.test(text[at - 1] ?? " ")) at -= 1;
	return at;
}

/**
 * Moves `index` forward to the end of the word it lands in, so a truncated
 * excerpt does not end `…sour` where the sentence continues.
 */
export function snapEnd(text: string, index: number, limit = 40): number {
	let at = Math.max(0, Math.min(index, text.length));
	const ceiling = Math.min(text.length, at + limit);
	while (at < ceiling && !/\s/.test(text[at] ?? " ")) at += 1;
	return at;
}

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

/**
 * Wraps matched terms in `<mark>`.
 *
 * Split/restore rather than a replacer, so only whole matched groups are ever
 * wrapped — a replacer that operates on the escaped string can match across the
 * `&amp;` it just introduced.
 */
export function markTerms(value: string, terms: readonly string[]): string {
	const escaped = escapeHtml(value);
	if (!terms.length) return escaped;
	const pattern = [...new Set(terms)]
		.sort((a, b) => b.length - a.length)
		.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	const re = new RegExp(`(${pattern})`, "gi");
	return escaped
		.split(re)
		.map((part, i) => (i % 2 === 1 ? `<mark>${part}</mark>` : part))
		.join("");
}

/**
 * A search snippet, escaped here rather than trusted from the CMS (#53).
 *
 * `src/pages/search.astro` renders `snippet` with `set:html`, and that string
 * comes out of SQLite's `snippet()` over whatever text EmDash indexed. EmDash
 * does sanitise it — `sanitizeSnippet` in `emdash/src/search/query.ts` escapes
 * the metacharacters and restores the `<mark>` markers it spliced in — so today
 * this is not a hole.
 *
 * It is still worth a function, for one reason: **this** is the only place in the
 * public app that asks for untrusted CMS text to be interpreted as HTML, and
 * saying so at the sink is what stops the safety from depending on a sanitiser
 * three packages away that a dependency bump could change. The cost is one
 * function and one test.
 *
 * EmDash's contract is that the only tags in a snippet are `<mark>` and
 * `</mark>`, so those two — and nothing else — are re-admitted after escaping.
 * Everything else stays text. That holds even if the CMS one day hands back
 * `<img src=x onerror=…>`: it renders as the characters it is.
 */
export function safeSnippet(snippet: string | null | undefined): string | null {
	if (!snippet) return null;
	return escapeHtml(snippet)
		.replaceAll("&lt;mark&gt;", "<mark>")
		.replaceAll("&lt;/mark&gt;", "</mark>");
}
