/**
 * The search field says what the design authority says, and it fits (#80).
 *
 * #80 is a layout defect dressed as a copy one: the placeholder was wider than its
 * field at three of the four phone widths in the matrix, and cut mid-word with no
 * ellipsis and no way to see the rest. Two things were wrong and only one was
 * visible.
 *
 * The visible one was the box. The invisible one was that three pages each had
 * their own phrasing for the same question — `/search` said "Technique, treatment,
 * problem, tool", `/404` said "Try a technique, a treatment, a problem", and the
 * masthead said "Search". Two of them independently invented variants of a sentence
 * `DESIGN.md` §9.1 already specifies, so a reader who learned the phrasing on one
 * page did not recognise it on another.
 *
 * ## Why this measures the browser
 *
 * Every other assertion about this could have been made from the source, and would
 * have been worthless. The defect was arithmetic: a `flex` basis, a container width
 * and a string's width in one particular font at one particular size. Reading the
 * stylesheet tells you what was *asked for*; only rendering tells you what the
 * browser *gave*.
 *
 * So the placeholder is measured by laying out a probe span in the field's own
 * computed font — not an estimate, not a `scrollWidth` comparison, which a field
 * with `text-overflow` would defeat — and compared against the field's actual
 * content box. The probe is removed afterwards, so it cannot affect the layout it
 * measured.
 *
 * `tests/routes.test.ts` has the live-server harness; this file skips cleanly when
 * no server is running rather than reporting a pass it did not earn.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_PLACEHOLDER, SEARCH_PLACEHOLDER_SHORT } from "../src/lib/vocabulary.ts";
import { readFileSync } from "node:fs";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

/**
 * The widths `#80` names, plus one wider phone.
 *
 * 360 is the smallest supported width and the one where the overflow was worst;
 * 390 and 430 are the two common Android sizes; 768 is the tablet breakpoint where
 * the field first has room to breathe.
 */
const WIDTHS = [360, 390, 430, 768];

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

/**
 * One measurement: the label of the route, the viewport, and the two numbers.
 *
 * `route`/`width` are added by the loop and `placeholder`/`need`/`avail` come back
 * from the page, so they are declared once here and filled in two places rather
 * than spread as a cast that hides which half is which.
 */
interface Measurement {
	route: string;
	width: number;
	placeholder: string;
	need: number;
	avail: number;
}

/** What the in-page evaluation returns — no route or width, it cannot know them. */
interface FieldMeasurement {
	placeholder: string;
	need: number;
	avail: number;
}

const measured: Measurement[] = [];

/**
 * Measures every field at every width, in one browser.
 *
 * One browser for the whole matrix rather than one per width: each launch is ~200ms
 * of overhead and the measurement itself is sub-millisecond, so a per-width browser
 * would be almost entirely launch time — and it would make the eight measurements
 * harder to read as a set, which is the only way to see that 360 is the outlier.
 */
describe("the search placeholder fits its field", () => {
	test("no visible placeholder is wider than its field", async (t) => {
		if (!server) {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		if (!chromium) {
			t.skip("playwright is not available");
			return;
		}
		const browser = await chromium!.launch();
		try {
			// `?vertical=` because #80's defect was on the filtered wall, and the
			// field must fit everywhere it appears rather than only on the routes
			// somebody happened to look at.
			const routes: Array<{ path: string; selector: string; label: string }> = [
				{ path: "/search", selector: ".finder input", label: "/search" },
				{ path: "/nope-does-not-exist", selector: ".finder input", label: "/404" },
				{ path: "/", selector: ".search input", label: "masthead" },
				{ path: "/?vertical=logos", selector: ".search input", label: "masthead (filtered)" },
			];

			for (const width of WIDTHS) {
				const page = await browser.newPage({ viewport: { width, height: 800 } });
				for (const route of routes) {
					await page.goto(`${baseUrl}${route.path}`, { waitUntil: "networkidle" });
					const result = (await page.evaluate((selector) => {
						const el = document.querySelector(selector);
						if (!el) return null;
						const cs = getComputedStyle(el);
						const placeholder = el.getAttribute("placeholder") ?? "";
						if (!placeholder.trim()) return null;

						/*
						 * Lay the string out in the field's own font, off-screen.
						 *
						 * `scrollWidth` on the input would be simpler and wrong: an input
						 * clips its own overflow, so `scrollWidth` frequently equals
						 * `clientWidth` and the defect reads as absent. A sibling span is the
						 * only way to ask how wide the text actually wants to be.
						 */
						const probe = document.createElement("span");
						probe.style.cssText =
							"position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0";
						probe.style.font = cs.font;
						probe.style.letterSpacing = cs.letterSpacing;
						probe.textContent = placeholder;
						document.body.appendChild(probe);
						const need = probe.getBoundingClientRect().width;
						document.body.removeChild(probe);

						const avail =
							el.clientWidth -
							parseFloat(cs.paddingLeft || "0") -
							parseFloat(cs.paddingRight || "0");

						return {
							placeholder,
							need: Math.round(need),
							avail: Math.round(avail),
						};
					}, route.selector)) as Measurement | null;

					if (!result) continue;
					measured.push({
						route: route.label,
						width,
						placeholder: result.placeholder,
						need: result.need,
						avail: result.avail,
					});
				}
				await page.close();
			}
		} finally {
			await browser.close();
		}

		const overflowing = measured.filter((m) => m.need > m.avail);
		const report = measured
			.map((m) => `${String(m.width).padStart(4)} ${m.route.padEnd(20)} need ${String(m.need).padStart(4)} avail ${String(m.avail).padStart(4)}`)
			.join("\n");
		assert.deepEqual(
			overflowing.map((m) => `${m.width}px ${m.route}: "${m.placeholder}" needs ${m.need}px in ${m.avail}px`),
			[],
			`a placeholder is wider than its field:\n${report}`,
		);

		// Nothing measured means nothing proven, which is the failure mode #47 exists
		// to prevent — so it is a failure here too rather than a vacuous pass.
		assert.ok(
			measured.length >= WIDTHS.length * 4,
			`only ${measured.length} field(s) measured across ${WIDTHS.length} widths; the matrix did not run`,
		);
	});
});

describe("the placeholder is one sentence, not three", () => {
	test("`/search` and `/404` share the wording", () => {
		// The criterion #80 sets: the two pages must not both invent their own
		// phrasing. `SEARCH_PLACEHOLDER_SHORT` is the masthead's deliberate
		// exception — an 8.5rem field beside a wordmark — and it is a *different*
		// constant with the reason next to it, not a fourth guess at this sentence.
		assert.equal(SEARCH_PLACEHOLDER, "Technique, treatment, tool");
		assert.equal(SEARCH_PLACEHOLDER_SHORT, "Search");
	});

	test("the rendered pages use the constant rather than a literal", () => {
		const root = new URL("../", import.meta.url).pathname;
		for (const file of ["src/pages/search.astro", "src/pages/404.astro"]) {
			const source = readFileSync(`${root}${file}`, "utf8");
			assert.match(
				source,
				/placeholder=\{SEARCH_PLACEHOLDER\}/,
				`${file} should render the constant, not a literal`,
			);
			// And no second phrasing crept in beside it.
			assert.doesNotMatch(
				source,
				/placeholder="(?!")/,
				`${file} still has a hard-coded placeholder`,
			);
		}
	});

	test("the design authority says what the product says", () => {
		// `DESIGN.md` named four nouns; the field says three, because four do not
		// fit at 360px and §3's mono floor rules out shrinking the type to make
		// them fit. An authority that reads "four" beside a product that says
		// three is worse than either being wrong alone, so the document is asserted
		// against the constant rather than trusted to stay in step.
		//
		// Compared case-insensitively: the document quotes the sentence in lower
		// case as prose, and the field renders it capitalised as a placeholder.
		// Requiring an exact match would be asserting a capitalisation convention
		// the design authority has no reason to follow, which is how an assertion
		// about the *words* turns into a failing test about capitalisation.
		const design = readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8").toLowerCase();
		const said = SEARCH_PLACEHOLDER.toLowerCase();

		assert.ok(
			design.includes(said),
			`DESIGN.md does not name "${SEARCH_PLACEHOLDER}", which is what the field says`,
		);
		assert.ok(
			!design.includes("technique, treatment, problem, tool"),
			"DESIGN.md still names four nouns; the field says three and they must agree",
		);
	});
});