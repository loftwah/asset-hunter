/**
 * Search result text (#63).
 *
 * Both rules here were found by looking at a screenshot and reading the DOM,
 * and both read as a rendering fault rather than as a design choice — which is
 * why they are worth a test rather than a code review comment.
 *
 * `excerpt` is the one that matters most: a character index from `indexOf`
 * sliced back by a fixed window lands mid-word, and a reason line that opens
 * `…aking` makes the *reason* for a match harder to read than the title above it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { excerpt, facetLabels, markTerms, snapEnd, snapStart } from "../src/lib/search-text.ts";

/** True when `s` opens on a real word, ignoring any leading ellipsis. */
const opensOnWord = (s: string | null): boolean => {
	assert.ok(s, "no excerpt produced");
	const body = s.replace(/^…/, "").replace(/&[a-z]+;/g, "x");
	assert.ok(body.length > 0, `excerpt is only ellipsis: ${JSON.stringify(s)}`);
	return /^[^\s]/.test(body);
};

describe("facetLabels: one fact, one label", () => {
	test("a media label already inside the vertical label is dropped", () => {
		// The reported defect: `Motion / Video  Motion`, `Audio / Music  Audio`.
		assert.deepEqual(facetLabels("motion-video", "motion"), ["Motion / Video"]);
		assert.deepEqual(facetLabels("audio-music", "audio"), ["Audio / Music"]);
	});

	test("an identical label is printed once", () => {
		// What `/lab` showed at every viewport: `Typography  Typography`, `3D  3D`.
		assert.deepEqual(facetLabels("typography", "type"), ["Typography"]);
		assert.deepEqual(facetLabels("3d", "3d"), ["3D"]);
		assert.deepEqual(facetLabels("shaders", "shader"), ["Shaders"]);
	});

	test("genuinely different labels are both kept, in a fixed order", () => {
		// A reader cannot tell "Motion / Video" from "Motion" — but they can
		// tell a vertical from a media kind. So both survive, vertical first,
		// and the order is fixed so two runs render identically.
		assert.deepEqual(facetLabels("games", "code"), ["Games", "Code"]);
		assert.deepEqual(facetLabels("branding", "image"), ["Branding", "Image"]);
	});

	test("one facet without the other still prints", () => {
		assert.deepEqual(facetLabels("games", null), ["Games"]);
		assert.deepEqual(facetLabels(null, "shader"), ["Shader"]);
		assert.deepEqual(facetLabels(null, null), []);
	});

	test("an unknown media kind falls back to its slug rather than vanishing", () => {
		// A media kind with no label is still a fact about the entry. Dropping
		// it silently would make an unclassified row look like an unlabelled one.
		assert.deepEqual(facetLabels("games", "hologram"), ["Games", "hologram"]);
	});

	test("the comparison is case-insensitive", () => {
		assert.deepEqual(facetLabels("shaders", "Shader"), ["Shaders"]);
	});
});

describe("excerpt starts and ends on word boundaries", () => {
	const summary =
		"Solve the cycle instead of hiding the seam: making the state at t equal the state at the " +
		"period removes the seam entirely, but it constrains the motion you can design, which is a " +
		"design decision rather than a post-process.";

	test("a match in the middle opens on a whole word", () => {
		// The reported defect. `at - window/3` is a character offset, so this used
		// to open `…aking` or `…sult`.
		const out = excerpt(summary, { terms: ["seam"] });
		assert.ok(opensOnWord(out), `opened mid-word: ${JSON.stringify(out)}`);
		assert.doesNotMatch(out!, /^…[a-z]*(aking|sult|n-space)/);
	});

	test("a match at the very start has no leading ellipsis", () => {
		const out = excerpt("Seams live at every boundary between two colours.", { terms: ["seam"] });
		assert.ok(out);
		assert.equal(out!.startsWith("…"), false, "leading ellipsis on a match at index 0");
		// The mark wraps the matched *term*, not the whole word — `seam` inside
		// `Seams` is a match, and leaving the trailing `s` outside the mark is what
		// lets a reader see the word was matched on a prefix.
		assert.match(out!, /^<mark>Seam<\/mark>s live/);
	});

	test("a match a few characters in does not manufacture one either", () => {
		// The window is generous enough to cover the whole sentence, so a match at
		// index 7 opens on the first word and says nothing was cut off.
		const out = excerpt("A seam runs through it.", { terms: ["seam"] })!;
		assert.equal(out.startsWith("…"), false);
		assert.match(out, /^A <mark>seam<\/mark>/);
	});

	test("a match near the end still opens on a word", () => {
		const out = excerpt(summary, { terms: ["post-process"] });
		assert.ok(opensOnWord(out));
	});

	test("a match with no context before it opens on the match", () => {
		const out = excerpt("Seam.", { terms: ["seam"] });
		assert.equal(out, "<mark>Seam</mark>.");
	});

	test("the tail does not end mid-word", () => {
		const out = excerpt(summary, { terms: ["seam"] })!;
		const withoutTail = out.replace(/…$/, "").replace(/<[^>]+>/g, "").trimEnd();
		const lastWord = withoutTail.split(/\s+/).pop() ?? "";
		assert.ok(lastWord.length > 0);
		// The last word must be a whole word *of the source*: either the excerpt
		// runs to the end of the text, or the character after it is whitespace or
		// punctuation. `…design decis` would fail this and read as corruption.
		const at = summary.lastIndexOf(lastWord);
		const after = summary[at + lastWord.length] ?? " ";
		assert.ok(
			/[\s.,;:!?)]/.test(after) || summary.endsWith(lastWord),
			`excerpt ends on a fragment: ${JSON.stringify(lastWord)} followed by ${JSON.stringify(after)}`,
		);
	});

	test("no match takes the opening and marks nothing", () => {
		const out = excerpt(summary, { terms: ["xylophone"] });
		assert.ok(out);
		assert.equal(/<mark>/.test(out!), false, "marked a term that does not appear");
		assert.ok(opensOnWord(out));
	});

	test("empty and absent text produce no excerpt", () => {
		// Nothing to excerpt is not the same as an empty excerpt: a caller
		// rendering `set:html` with `""` would emit an empty paragraph rather
		// than omitting the line.
		assert.equal(excerpt("", { terms: ["seam"] }), null);
		assert.equal(excerpt(null), null);
		assert.equal(excerpt(undefined), null);
	});

	test("the earliest match wins when a field matches several terms", () => {
		// Not whichever term the query happened to list first. Both orders must
		// produce the same excerpt, because the reader wants the passage that
		// matched rather than the query's own ordering.
		const first = excerpt(summary, { terms: ["post-process", "seam"] });
		const second = excerpt(summary, { terms: ["seam", "post-process"] });
		assert.equal(first, second, "term order changed the excerpt");

		// `seam` is at 38 and `post-process` at 209, so a window opened on the
		// later one would show neither the earlier match nor an opening ellipsis.
		assert.ok(first!.startsWith("Solve the cycle"), `opened elsewhere: ${first}`);
		assert.match(first!, /<mark>seam<\/mark>/);
	});

	test("a match near the end does open on it, with a leading ellipsis", () => {
		// The complementary case, so the test above is not passing by accident
		// because the window is simply always the beginning.
		const out = excerpt(summary, { terms: ["post-process"] })!;
		assert.ok(out.startsWith("…"), `expected a leading ellipsis: ${out}`);
		assert.match(out, /<mark>post-process<\/mark>\.$/);
	});

	test("terms under three characters match nothing", () => {
		// A two-letter query word matches most of a sentence, so marking it
		// produces noise rather than a reason.
		const out = excerpt(summary, { terms: ["th"] });
		assert.equal(/<mark>/.test(out!), false);
	});
});

describe("snapStart and snapEnd", () => {
	const text = "one two three four five";

	/** What a window opened at `index` actually reads. */
	const opens = (index: number) => text.slice(snapStart(text, index));

	test("snapStart walks back to the beginning of the current word", () => {
		// 4–6 are inside "two"; 8–12 inside "three".
		assert.equal(opens(4), "two three four five");
		assert.equal(opens(6), "two three four five");
		assert.equal(opens(9), "three four five");
	});

	test("snapStart steps off whitespace rather than snapping to the word before it", () => {
		// Index 7 is the space after "two". Walking *back* from it lands on 4, so
		// the window would open on "two" and lose the word that follows. Stepping
		// forward to 8 opens on "three", which is what a reader expects.
		assert.equal(opens(7), "three four five");
	});

	test("snapStart is bounded so a match in the first characters does not walk back", () => {
		// Index 3 is the space after "one". Stepping off it lands on 4, which is
		// the start of "two" — and the bound stops it going further, so a window
		// opened at index 3 reads "two three four five" rather than being dragged
		// back through the whole string.
		assert.equal(snapStart(text, 3), 4);
		assert.equal(opens(3), "two three four five");
		// Index 2 is inside "one", so the walk back reaches the very start.
		assert.equal(snapStart(text, 2), 0);
		assert.equal(opens(2), "one two three four five");
	});

	test("snapEnd walks forward to the end of the current word", () => {
		// 4 is the `t` of "two", so it snaps to 7 — the space after "two". A
		// window closed at 4 would end `…one tw`.
		assert.equal(text.slice(0, snapEnd(text, 4)), "one two");
		assert.equal(text.slice(0, snapEnd(text, 6)), "one two");
		assert.equal(text.slice(0, snapEnd(text, 8)), "one two three");
	});

	test("snapEnd is bounded too", () => {
		assert.equal(snapEnd(text, text.length), text.length);
	});

	test("both clamp rather than throwing or returning nonsense", () => {
		// Out-of-range indices come from arithmetic on an unknown string, so the
		// helpers are called with negatives and past-the-end values in practice.
		// The requirement is only that they return an index inside the string.
		for (const index of [-5, -1, 0, text.length, text.length + 10]) {
			for (const fn of [snapStart, snapEnd]) {
				const at = fn(text, index);
				assert.ok(Number.isInteger(at), `${fn.name}(${index}) → ${at}`);
				assert.ok(at >= 0 && at <= text.length, `${fn.name}(${index}) → ${at}`);
			}
		}
	});

	test("an index past the end clamps rather than walking off it", () => {
		// `snapStart` past the end legitimately walks *back* to the start of the
		// last word, so 19 is correct here, not a bug — the requirement is only
		// that it stays inside the string.
		assert.equal(snapEnd(text, 99), text.length);
		assert.equal(snapStart(text, 99), text.indexOf("five"));
	});
});

describe("markTerms cannot inject markup", () => {
	test("the text is escaped before any mark is added", () => {
		const out = markTerms("a <script>alert(1)</script> seam", ["seam"]);
		assert.equal(/<script>/.test(out), false, "raw script tag survived");
		assert.match(out, /&lt;script&gt;/);
	});

	test("a query term containing markup is escaped too", () => {
		// The split/restore approach means the pattern matches against the escaped
		// string, so the *only* markup in the output is the `<mark>` we added.
		const out = markTerms("text here", ["<img src=x onerror=1>"]);
		assert.equal(/<img/.test(out), false);
	});

	test("an ampersand does not break the match", () => {
		// `markTerms` escapes first and splits after, so matching across the
		// `&amp;` it just introduced is impossible.
		const out = markTerms("rock & roll", ["roll"]);
		assert.match(out, /^rock &amp; <mark>roll<\/mark>$/);
	});

	test("a term with regex metacharacters matches literally", () => {
		assert.match(markTerms("a.b and axb", ["a.b"]), /<mark>a\.b<\/mark>/);
		assert.equal(/<mark>axb/.test(markTerms("a.b and axb", ["a.b"])), false);
	});

	test("the longest term wins, so 'seams' is not split into 'seam' + s", () => {
		assert.match(markTerms("seams and seam", ["seam", "seams"]), /<mark>seams<\/mark>/);
	});

	test("no terms means escaped text and no markup", () => {
		assert.equal(markTerms("a < b", []), "a &lt; b");
	});
});
