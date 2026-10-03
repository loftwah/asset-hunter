/**
 * A plate's size follows the row it is in (#73).
 *
 * `/collections` capped its cover at `max-width: 7rem`, so it rendered 112px at
 * every viewport from 360 to 1920 — 34% of the row on a phone and **9%** at 1280,
 * where the row is 1,206px wide. `/search` had the same shape at 4.5rem. The row's
 * width did nothing at all in either case, which is the real defect: a fixed `rem`
 * cap is not a size decision, it is the absence of one.
 *
 * The issue's acceptance asks for one decision covering three routes with a number
 * in it, and that number now lives in `DESIGN.md` §6a. This asserts the routes
 * agree with it — which is the part that can rot, because nothing at runtime
 * compares a stylesheet against a design document.
 *
 * ## Why it measures rather than reads the stylesheet
 *
 * Reading the source proves the rule is written down; it cannot prove the browser
 * applied it. `clamp()` and `vw` are resolved by layout, and a grid column narrower
 * than its own `max-width` silently caps the result — which is exactly what would
 * happen if someone changed the column without changing the cover. So the rendered
 * width is measured, and the *growth* is what is asserted rather than the value:
 * a plate that stops growing with the viewport is the failure, whatever the number.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

/** Wide enough to show the cap engaging and the `vw` term growing. */
const WIDTHS = [360, 768, 1280, 1920];

interface Rendered {
	width: number;
	rowWidth: number;
}

let chromium: typeof import("playwright").chromium | null = null;
let server = false;

before(async () => {
	try {
		const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
		server = res.ok;
	} catch {
		server = false;
	}
	if (!server) return;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		chromium = null;
	}
});

const ROUTES = [
	{ path: "/collections", selector: ".collection__cover", label: "collections cover" },
	{ path: "/search?q=loop", selector: ".found__thumb", label: "search thumbnail" },
];

async function measure(): Promise<Map<string, Map<number, Rendered>>> {
	const out = new Map<string, Map<number, Rendered>>();
	const browser = await chromium!.launch();
	try {
		for (const route of ROUTES) {
			const byWidth = new Map<number, Rendered>();
			for (const width of WIDTHS) {
				const page = await browser.newPage({ viewport: { width, height: 900 } });
				await page.goto(`${baseUrl}${route.path}`, { waitUntil: "networkidle" });
				const result = (await page.evaluate((selector) => {
					// The row is the link, because on both routes the plate is a child
					// of the anchor and the anchor is the row.
					const plate = document.querySelector(selector);
					const row = plate?.closest("a") ?? plate?.parentElement;
					if (!plate || !row) return null;
					return {
						width: Math.round(plate.getBoundingClientRect().width),
						rowWidth: Math.round(row.getBoundingClientRect().width),
					};
				}, route.selector)) as Rendered | null;
				if (result) byWidth.set(width, result);
				await page.close();
			}
			out.set(route.label, byWidth);
		}
	} finally {
		await browser.close();
	}
	return out;
}

describe("a plate grows with the row it is in", () => {
	test("neither route holds a fixed rem cap", async (t) => {
		if (!server) {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		if (!chromium) {
			t.skip("playwright is not available");
			return;
		}
		const measured = await measure();

		for (const route of ROUTES) {
			const byWidth = measured.get(route.label)!;
			assert.equal(
				byWidth.size,
				WIDTHS.length,
				`${route.label}: only ${byWidth.size} of ${WIDTHS.length} widths measured`,
			);

			const smallest = byWidth.get(WIDTHS[0])!;
			const largest = byWidth.get(WIDTHS[WIDTHS.length - 1])!;
			assert.ok(
				largest.width > smallest.width,
				`${route.label} renders ${smallest.width}px at ${WIDTHS[0]}px and ` +
					`${largest.width}px at ${WIDTHS[WIDTHS.length - 1]}px — it is a fixed cap`,
			);
		}
	});

	test("the collections cover is a real share of its row, not 9%", async (t) => {
		if (!server) {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		if (!chromium) {
			t.skip("playwright is not available");
			return;
		}
		const byWidth = (await measure()).get("collections cover")!;

		for (const width of WIDTHS) {
			const m = byWidth.get(width)!;
			const share = (m.width / m.rowWidth) * 100;
			// The issue's own complaint was 9% of the row at 1280. A cover that is
			// the *subject* of the row should be a meaningful share of it at every
			// width, and 15% is a low floor that still fails the old 7rem rule at
			// every desktop width.
			assert.ok(
				share >= 15,
				`collections cover is ${share.toFixed(1)}% of its ${m.rowWidth}px row at ${width}px ` +
					`(DESIGN.md §6a wants clamp(9rem, 26vw, 22rem))`,
			);
		}
	});

	test("the search thumbnail stays an identifier, not an illustration", async (t) => {
		if (!server) {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		if (!chromium) {
			t.skip("playwright is not available");
			return;
		}
		const byWidth = (await measure()).get("search thumbnail")!;

		for (const width of WIDTHS) {
			const m = byWidth.get(width)!;
			// `DESIGN.md` §6a's floor for this surface is a floor on the *share*, not
			// on absolute size: 26vw at 1920 gives 10%, and the cap takes it to 144px.
			// Too small and the row stops being identifiable; too large and the title
			// loses the row it belongs to.
			const share = (m.width / m.rowWidth) * 100;
			assert.ok(
				share >= 8,
				`search thumbnail is ${share.toFixed(1)}% of its row at ${width}px — too small to identify the row`,
			);
			assert.ok(
				m.width <= 200,
				`search thumbnail is ${m.width}px at ${width}px; §6a caps it at 9rem so the title keeps the row`,
			);
		}
	});
});

describe("the design authority records the decision", () => {
	const design = () =>
		readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8");

	test("§6a exists and names all three surfaces", () => {
		const text = design();
		assert.match(text, /### 6a\. Plate size is one decision/);
		for (const surface of ["/use/<slug>", "/collections", "/search"]) {
			assert.ok(
				text.includes(surface),
				`§6a does not mention ${surface}, so a route can drift without the authority noticing`,
			);
		}
	});

	test("the numbers in §6a are the ones the CSS uses", () => {
		// The authority and the stylesheet are two files that must agree, and
		// nothing at runtime compares them. This is that comparison.
		const text = design();
		const collections = readFileSync(
			new URL("../src/pages/collections/index.astro", import.meta.url),
			"utf8",
		);
		const search = readFileSync(
			new URL("../src/pages/search.astro", import.meta.url),
			"utf8",
		);

		assert.ok(
			collections.includes("clamp(9rem, 26vw, 22rem)"),
			"the collections cover no longer uses the value §6a records",
		);
		assert.ok(
			search.includes("clamp(5.5rem, 12vw, 9rem)"),
			"the search thumbnail no longer uses the value §6a records",
		);
		assert.ok(text.includes("clamp(9rem, 26vw, 22rem)"), "§6a lost the collections value");
		assert.ok(text.includes("clamp(5.5rem, 12vw, 9rem)"), "§6a lost the search value");

		/*
		 * And no fixed cap came back on either surface.
		 *
		 * Comments are stripped before the search, because these files *quote* the value
		 * they replaced — the collections comment explaining #73 says "`max-width:
		 * 7rem`" in prose. Matching the raw source therefore reported the fix as the
		 * defect it removed, which is the same class of mistake this file exists to
		 * prevent: reading a string that looks like the thing being looked for when it
		 * is not the thing.
		 */
		const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");
		assert.doesNotMatch(
			code(collections),
			/max-width:\s*7rem/,
			"the fixed 7rem cap is back",
		);
		assert.doesNotMatch(
			code(search),
			/grid-template-columns:\s*4\.5rem/,
			"the fixed 4.5rem column is back",
		);
	});

	test("the narrow-viewport override reuses the thumbnail width", () => {
		/*
		 * The last piece of #73, and the one that rots.
		 *
		 * Below 560px the thumbnail steps down to 3.25rem and the snippet's indent
		 * was a *second* literal of the same number. Two copies of one measurement
		 * is how an excerpt ends up indented to a plate that has since changed — and
		 * the misalignment is invisible until somebody measures it, which is what
		 * this file exists to make routine.
		 */
		const search = readFileSync(
			new URL("../src/pages/search.astro", import.meta.url),
			"utf8",
		);
		assert.ok(
			search.includes("--row-thumb: 3.25rem"),
			"the narrow-viewport override should set the token rather than the column",
		);
		assert.ok(
			search.includes("calc(var(--row-thumb, 3.25rem) + var(--sp-3))"),
			"the snippet's indent should read the token, not repeat the number",
		);
		assert.doesNotMatch(
			search,
			/padding-left:\s*calc\(3\.25rem/,
			"the snippet's indent is a literal again, so it can drift from the plate",
		);
	});
});