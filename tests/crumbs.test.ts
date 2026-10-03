/**
 * The breadcrumb trail, and the fact that there is exactly one of it (#66).
 *
 * #66 was found by reading a screenshot, which is the strongest argument this
 * repository has for having screenshots: the separators were their own flex items,
 * so a wrapped trail left a line containing nothing but `/`. Every automated check
 * passed — the elements are not clipped, not too small, not overlapping — and the
 * page was visibly wrong at 768, 1280, 1680 and 1920px, on the drill-in, the use
 * page, collections and content pages.
 *
 * The fix was grouping: each step and the separator in front of it are one flex
 * item, so a break can only happen *between* steps. That is a property of the box,
 * not of the text, so there is no `white-space` value or width that would do it.
 *
 * ## The structural test, which is the part that matters
 *
 * Grouping cannot be asserted from rendered output alone — a future change could
 * reintroduce a separator as its own flex item and every width would have to be
 * re-captured to notice. So this asserts the *structure*: every page that renders a
 * trail uses `<Crumbs>`, and nothing outside the component hand-rolls the markup.
 *
 * That is the criterion #66 asks for — `rg 'class="crumbs"' src/` returns only the
 * component — turned into a build failure instead of a thing to remember.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;

/** Every `.astro` and `.ts` file under `src/`, for a whole-tree assertion. */
function sources(dir = join(root, "src"), out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) sources(full, out);
		else if (/\.(astro|ts)$/.test(entry.name)) out.push(full);
	}
	return out;
}

const all = sources().map((f) => ({ path: f.slice(root.length), text: readFileSync(f, "utf8") }));

describe("there is one breadcrumb, and it is the component", () => {
	test("only the component carries the trail markup", () => {
		const private_ = all.filter(
			(f) => f.path.includes("Crumbs.astro") === false && /class="crumbs"/.test(f.text),
		);
		assert.deepEqual(
			private_.map((f) => f.path),
			[],
			"a page is hand-rolling the breadcrumb again; use <Crumbs> so the separator cannot break onto its own line",
		);
	});

	test("every page that renders a trail uses the component", () => {
		// The converse direction, because either half alone is satisfiable by luck.
		const using = all.filter((f) => /<Crumbs\b/.test(f.text));
		const expected = [
			"src/pages/possibilities/[slug].astro",
			"src/pages/use/[slug].astro",
			"src/pages/collections/[slug].astro",
			"src/pages/pages/[slug].astro",
			// #66 listed these four; the curation case page had a fifth copy, made
			// before the component existed and missed by the original audit.
			"src/pages/curate/disputes/[slug].astro",
		];
		for (const path of expected) {
			assert.ok(
				using.some((f) => f.path === path),
				`${path} should render its trail with <Crumbs>`,
			);
		}
	});

	test("the separator lives inside the step it introduces", () => {
		const crumbs = readFileSync(join(root, "src/components/Crumbs.astro"), "utf8");
		// The grouping is the fix, so it is asserted directly rather than inferred
		// from a capture. A separator rendered outside `crumbs__step` is a flex item
		// of its own, and a flex item can start a line.
		assert.match(
			crumbs,
			/<span class="crumbs__step">[\s\S]{0,200}?crumbs__sep/,
			"the separator must be inside the step's own flex item, or it can wrap onto a line alone",
		);
		assert.doesNotMatch(
			crumbs,
			/<nav class="crumbs"[\s\S]*?<\/nav>[\s\S]{0,40}<span class="crumbs__sep"/,
			"a separator rendered after the nav is outside every step",
		);
	});

	test("the trail names the current page in the landmark", () => {
		const crumbs = readFileSync(join(root, "src/components/Crumbs.astro"), "utf8");
		// The masthead already claims the section, so two landmarks both saying
		// "you are here" is what `aria-current` exists to disambiguate.
		assert.match(crumbs, /aria-current="page"/);
		assert.match(crumbs, /aria-hidden="true"/, "the separator must be hidden from assistive tech");
	});

	test("the separators are decorative and the steps are not", () => {
		const crumbs = readFileSync(join(root, "src/components/Crumbs.astro"), "utf8");
		// A screen reader announcing "slash" between three crumbs is noise; the
		// landmark and the `aria-current` step carry the structure.
		assert.match(crumbs, /class="crumbs__sep"[^>]*aria-hidden="true"/);
	});
});