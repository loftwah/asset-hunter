#!/usr/bin/env node
/**
 * Deterministic visual QA.
 *
 * Captures every public route at a fixed viewport matrix so a change to layout,
 * typography or state handling is reviewable as pixels rather than inferred
 * from source. Also runs the checks that are cheap to automate and expensive to
 * eyeball: horizontal overflow, tap-target size, contrast of body text, and
 * whether every image resolved.
 *
 * Usage:
 *   node scripts/visual-qa.mjs                 # capture + audit
 *   node scripts/visual-qa.mjs --audit-only    # assertions, no new captures
 *   node scripts/visual-qa.mjs --url http://…  # audit a different origin
 */
import {
	mkdirSync,
	rmSync,
	existsSync,
	readFileSync,
	writeFileSync,
	readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium, devices } from "playwright";

const args = process.argv.slice(2);
const baseUrl = valueOf("--url") ?? "http://localhost:4321";
const auditOnly = args.includes("--audit-only");
const outDir = new URL("../screenshots/", import.meta.url).pathname;

/**
 * Whether this origin can serve the development-only routes.
 *
 * `/lab` and the fixture selections behind `/use/fixture-use-page-*` are refused
 * in a production build, so a matrix that expected them there would fail every
 * production audit. The run *prints* which routes it skipped and why rather than
 * dropping them silently — a matrix that quietly covers less on the deployed site
 * than on a laptop is the sort of thing that has to be stated, not assumed.
 */
const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseUrl);

/**
 * A shortlist with two boards in it, as the `ah_board` cookie holds it.
 *
 * Encoded exactly as `src/lib/board.ts`'s `serialiseBoards` encodes it, because
 * the route validates every slug against the catalogue and drops the rest: a
 * cookie written any other way produces an empty board and a green run that
 * checked nothing. The slugs are real entries, which is the other half of why
 * this works.
 */
const BOARD_COOKIE = encodeURIComponent(
	JSON.stringify({
		default: ["density-gradient", "crowd-fluid", "seamless-loop", "match-cut"],
		"Autumn picks": ["kinetic-type", "negative-space-mark"],
	}),
);

function valueOf(flag) {
	const i = args.indexOf(flag);
	return i === -1 ? undefined : args[i + 1];
}

/**
 * The matrix. Widths are chosen at the breakpoints where this layout actually
 * changes rather than at round device numbers, so a capture either shows a
 * working state or the specific state that broke.
 *
 * Six of these exist because of #46, and each is a size the layout was previously
 * unaudited at and *was* broken at — a matrix of portrait phones plus two desktop
 * sizes cannot find any of them:
 *
 * - `landscape-844` / `landscape-932` — a phone on its side. The drill-in's plate
 *   was `position: sticky` at `top: 4.5rem` with no height condition, so with
 *   390px of viewport height it parked its top and hid 129–133px of its own bottom
 *   at every scroll offset. Below 860px the sticky rule never applied, so 844 is
 *   the one width where the old rule happened to be right and 932 the one where it
 *   was not; both are needed to keep it that way.
 * - `phone-430` — a large phone, between two of the breakpoints that matter here.
 * - `landscape-tablet-1024` — a tablet on its side: two-column drill-in, sticky
 *   rail, desktop nav, at 768px of height.
 * - `wide-1920` — where `--maxw` stops being the constraint and the gutter is.
 * - `text-200` — 200% of the reader's default font size at 1280px. This is
 *   Firefox's "Zoom text only" and Chromium's minimum-font-size setting, and it is
 *   what found the masthead: a `1fr` grid item's default `min-width: auto`
 *   refused to shrink, so every route gained 114px of horizontal scroll instead
 *   of the nav scrolling inside itself.
 *
 * `textScale` goes through CDP rather than a smaller viewport on purpose:
 * shrinking the viewport tests *zoom*, which reflows at 320px, and this matrix
 * needs the other half — type at twice the size, at full width.
 */
const VIEWPORTS = [
	{ name: "mobile-360", width: 360, height: 780, dsf: 2 },
	{ name: "mobile-390", width: 390, height: 844, dsf: 2 },
	{ name: "phone-430", width: 430, height: 932, dsf: 2 },
	{ name: "landscape-844", width: 844, height: 390, dsf: 2, touch: true },
	{ name: "landscape-932", width: 932, height: 430, dsf: 2, touch: true },
	{ name: "tablet-768", width: 768, height: 1024, dsf: 2 },
	{ name: "landscape-tablet-1024", width: 1024, height: 768, dsf: 2, touch: true },
	{ name: "laptop-1280", width: 1280, height: 800, dsf: 1 },
	{ name: "desktop-1680", width: 1680, height: 1050, dsf: 1 },
	{ name: "wide-1920", width: 1920, height: 1080, dsf: 1 },
	{ name: "text-200", width: 1280, height: 800, dsf: 1, textScale: 2 },
];

/**
 * The shortest viewport the fold gate applies to, in CSS pixels.
 *
 * 46rem is not chosen here — it is the same threshold the sticky-plate rule uses,
 * and it is the height below which a 4:5 specimen plate cannot be shown without
 * being cut off: at 800px authored, the largest plate the stylesheet renders is
 * 640×800. Below 46rem of height, "the media starts inside the first viewport"
 * is a statement about the window, not about the composition, so those viewports
 * are measured and printed instead. Two of the eleven are affected, and both are
 * phones in landscape.
 */
const MIN_GATE_HEIGHT = 46 * 16;

/**
 * Routes that exist only in `astro dev`.
 *
 * `/lab` is refused in a production build with a hard 404, and the fixture
 * selections behind `/use/fixture-use-page-*` resolve through the same `DEV`
 * guard. They are listed here with `devOnly` rather than filtered inline, so the
 * coverage check can tell "somebody deleted this route" (a failure) from "this
 * origin is production, where the route is refused by design" (reported, not
 * failed) — the difference between an honest matrix and one that quietly covers
 * less on the deployed site than on a laptop.
 */
const DEV_ROUTES = [
	{ path: "/lab", name: "lab", covers: "lab", devOnly: true, expect: { ".case": 30, "#vocabulary": 1, ".signal-case": 7 }, media: true },
	{
		path: "/lab#signals",
		name: "lab-signals",
		covers: "signals",
		devOnly: true,
		anchor: "#signals",
		// Seven panels. The two authentication states differ in a *control*, not
		// only in a caption — the rate button is enabled signed in and disabled
		// signed out, and the report fieldset follows it — so `auditSignalStates`
		// asserts the difference and a count here would not: counting cannot tell
		// an enabled button from a disabled one.
		expect: { ".signal-case": 7, ".dist__row": 25 },
		audit: "signals",
	},
	{
		path: "/lab#asset-use",
		name: "lab-use",
		covers: "use",
		devOnly: true,
		anchor: "#asset-use",
		// All four use states plus the two handoff outcomes that are not about
		// rights. `data-use-state` is the component's own word for the state, so
		// this asserts the vocabulary rather than the styling.
		expect: {
			'.use[data-use-state="reference-only"]': 1,
			'.use[data-use-state="review-required"]': 1,
			'.use[data-use-state="reusable-with-attribution"]': 1,
			'.use[data-use-state="reusable"]': 2,
			".use-case": 6,
		},
	},
	/*
	 * `/use/<slug>` in every use state, on the real page.
	 *
	 * The catalogue is 24 of 24 `reference` with nothing retained, so the real
	 * route can only ever render one of the four states and always with a payload
	 * count of zero. The other three — and every page with anything to download —
	 * had no pixels anywhere, which meant the summary line, the download accent,
	 * the selection credit block and the "N retained originals" copy had never
	 * been rendered by anybody.
	 *
	 * Each `expect` names the honest count for that state, including the downloads
	 * that must *not* be there, so a change that quietly turns a cleared page back
	 * into a reference page fails here rather than passing as "still fine".
	 */
	{
		path: "/use/fixture-use-page-reference",
		name: "use-reference",
		covers: "use",
		devOnly: true,
		expect: { '.use[data-use-state="reference-only"]': 1, ".use__control--primary": 0, '[data-payload-count="0"]': 1 },
	},
	{
		path: "/use/fixture-use-page-review",
		name: "use-review",
		covers: "use",
		devOnly: true,
		expect: { '.use[data-use-state="review-required"]': 1, ".use__quote": 1, ".use__rows": 1, ".use__control--primary": 0 },
	},
	{
		path: "/use/fixture-use-page-attribution",
		name: "use-attribution",
		covers: "use",
		devOnly: true,
		expect: { '.use[data-use-state="reusable-with-attribution"]': 1, ".use__credit": 1, "#selection-credit": 1, ".use__control--primary": 0 },
	},
	{
		path: "/use/fixture-use-page-reusable",
		name: "use-reusable",
		covers: "use",
		devOnly: true,
		// The only page in the product where a download control exists, so it is
		// the one page where `DESIGN.md` §9.6's "at most one download" rule can
		// actually be checked rather than assumed.
		expect: { '.use[data-use-state="reusable"]': 1, ".use__control--primary": 1, '.use[data-handoff="payload"]': 1, '[data-payload-count="1"]': 1 },
	},
	{
		path: "/use/fixture-use-page-not-retained",
		name: "use-not-retained",
		covers: "use",
		devOnly: true,
		// Permitted, credited, and nothing retained: the state that separates "0
		// because nothing is permitted" from "0 because the file is not held here",
		// and the one the catalogue cannot reach.
		expect: { '.use[data-use-state="reusable"]': 1, ".use__control--primary": 0, ".use__credit": 1 },
	},
	/*
	 * The scale wall (#49), at the largest size in the matrix rather than a
	 * sample of it.
	 *
	 * Audited at every viewport like a real route because it is the real route
	 * with a bigger catalogue: the same component, grid, filter and lazy strategy
	 * with `?scale=5000`. A matrix of one 24-entry wall cannot find the failure
	 * modes that only exist when there are enough tiles for the grid to wrap
	 * oddly, for the sticky rail to have a long document to sit over, or for
	 * tap-target checking to hit its own time budget — and each of those is a
	 * real reader on a real phone.
	 *
	 * `?scale=` is refused outside `astro dev`, so it is dev-only rather than
	 * reported against a production origin, exactly like `/lab`.
	 *
	 * No `media: true`. The blank-frame and layout-shift checks assume a page's
	 * imagery is its content; at 5,000 lazy plates the audit window legitimately
	 * finds most of them unfetched, and calling that a failure would be the
	 * harness disagreeing with the lazy strategy that is the thing working.
	 * `npm run check:perf` is where media loading at scale is measured, and it
	 * measures it properly.
	 *
	 * `capture: false` — a `fullPage` capture of a 5,000-tile wall is 1.1 million
	 * pixels tall and Chromium silently clamps it, which produces a file that
	 * looks like a capture and is not one. A matrix that accumulates
	 * confidently-wrong screenshots is worse than one with fewer of them.
	 */
	{
		path: "/?scale=5000",
		name: "wall-scale-5000",
		covers: "wall",
		devOnly: true,
		expect: { ".tile": 5000 },
		fold: ".tile__plate",
		scroll: 1400,
		stickyFits: true,
		capture: false,
	},
];

/**
 * Routes under audit. `expect` is the minimum number of elements that must be
 * present for the page to count as working — it is what distinguishes a real
 * render from an empty state or an error page. `fold` names the selector whose
 * top edge must land inside the first viewport: on a media-first catalogue, a
 * wall whose plates start below the fold is a layout bug even though every
 * other check passes.
 *
 * Optional flags carry the checks that need more than a fresh page:
 *
 * - `scroll` scrolls before auditing, because **a full-page screenshot does not
 *   simulate sticky positioning.** Chromium lays sticky and fixed elements out
 *   at their unscrolled position, so a rail that slides under the masthead
 *   renders perfectly in a `fullPage` capture and is broken in the browser.
 *   Anything sticky is only checked on a scrolled frame.
 * - `media` marks a route whose imagery is content rather than decoration, which
 *   is what earns it the blank-frame and layout-shift checks.
 * - `anchor` gives a URL with a fragment, so the "an in-page target must land
 *   below the masthead, not under it" rule is measured rather than assumed.
 * - `measureFold` names a media-first element whose distance from the top is
 *   *recorded* rather than asserted. See `MEASURED_FOLDS` — there is a rule for
 *   the wall and for the use page and none for the drill-in, and a script is not
 *   where a design authority gets invented.
 * - `capture: false` audits a route without writing a screenshot. It exists for
 *   documents too tall to photograph honestly: a `fullPage` capture of a 5,000-tile
 *   wall is 1.1 million pixels tall, and Chromium silently clamps it — which
 *   produces a file that looks like a capture and is not one. A matrix that
 *   accumulates confidently-wrong screenshots is worse than one with fewer of them.
 * - `plateMin` asserts a plate's rendered **width**, not its position. The floor
 *   is `DESIGN.md` §9.6's number, so this script reports it rather than choosing
 *   it, and every viewport it does not cover is still printed.
 * - `cookie` seeds a cookie before the request, because some states live in one.
 *   A board is a cookie by design (`src/lib/board.ts`), so without this the
 *   populated board — the only version of `/board` anybody actually uses — was
 *   never captured or audited, and its compare grid, per-entry disclosure,
 *   export block and clear form had never been seen at any viewport.
 * - `covers` names the entry in `COVERAGE` this route is the evidence for, so
 *   the end-of-run table cannot claim a state is covered by a route that no
 *   longer checks it.
 */
const ROUTES = [
	// `stickyFits` marks the two routes that hold sticky chrome — the wall's
	// filter rail and the drill-in's plate — so both are checked at every size in
	// the matrix rather than only where a screenshot happens to look right.
	{ path: "/", name: "wall", covers: "wall", expect: { ".tile": 20 }, fold: ".tile__plate", plateAspect: ".tile--featured .tile__plate", media: true, scroll: 1400, stickyFits: true },
	{ path: "/?vertical=games", name: "wall-filtered", covers: "search", expect: { ".tile": 2 }, fold: ".tile__plate", media: true },
	{ path: "/possibilities/density-gradient", name: "detail", covers: "detail", expect: { ".section__title": 3 }, media: true, scroll: 1200, stickyFits: true },
	/*
	 * The drill-in's own fold. `DESIGN.md` §5b states the rule for the wall and
	 * says nothing about the drill-in, so this is **measured, not gated** — see
	 * `MEASURED_FOLDS` below. Gating it would mean inventing a threshold the
	 * design authority has not agreed to, which is a different decision from the
	 * one this script is for. The number is printed so the gap is arguable rather
	 * than anecdotal; the observation itself is filed against #25.
	 */
	{
		path: "/possibilities/density-gradient",
		name: "detail-fold",
		expect: { ".plate img": 1 },
		measureFold: ".plate img",
	},
	// The rating and report interactions (#37) **signed out** — the state the
	// catalogue is actually in, so it is a real route and not a fixture. Audited
	// on an anchored frame because that block is 2,000px down the drill-in and a
	// `fullPage` capture of the top of the page says nothing about it.
	{
		path: "/possibilities/density-gradient#signals",
		name: "detail-signals",
		covers: "signals",
		expect: { ".rate__star": 5, ".rate button": 1, ".report__form select": 1, ".report__form button": 1 },
		anchor: "#signals",
	},
	// The asset-use flow (#42), recomposed to be media-first in #64. Two gates,
	// because this is the one route whose whole subject is a plate:
	//
	// - `fold` — `DESIGN.md` §9.6 now states that the representative plate starts
	//   inside the first viewport, so it is gated at the same 75% the wall uses
	//   rather than measured. (It used to start at 124–149% of the fold, with the
	//   page's only image at 104px.)
	// - `plateMin` — the size rule itself. Under 0.7 of the 800px the plate is
	//   authored at, its own 13px annotations land under 9px, which is the defect
	//   #64 reports as "a texture rather than an illustration".
	//
	// No `stickyFits`: this page's plate does not stick, because the decision
	// column beside it is shorter than the plate and a sticky element is bounded by
	// its own grid area — there is nothing for it to travel alongside.
	{
		path: "/use/density-gradient",
		name: "asset-use",
		covers: "use",
		expect: { ".use": 1, ".summary__payload": 1, ".states__row": 4 },
		media: true,
		fold: ".plate img",
		plateMin: { selector: ".plate img", px: 560, fromWidth: 1280 },
	},
	{ path: "/verticals", name: "verticals", expect: { ".row": 10 }, media: true },
	// An in-page anchor. `/verticals#games` and `/pages/licensing#the-statuses` are
	// linked from the masthead, the breadcrumbs and the footer, so a target that
	// lands under the sticky masthead is a link that looks broken.
	{ path: "/verticals#games", name: "verticals-anchor", expect: { ".row": 10 }, anchor: "#games" },
	{ path: "/collections", name: "collections", expect: { ".collection": 4 } },
	{ path: "/collections/seams", name: "collection", covers: "detail", expect: { ".tile": 4 }, fold: ".tile__plate", media: true },
	// The gallery (#17). Deliberately **not** `media: true`: that flag asks the
	// harness to assert that media renders at its container's declared aspect
	// ratio, which is the specimen-plate rule. A gallery image is a screenshot
	// of a whole page, and cropping one to a fixed ratio is the exact thing the
	// page exists to avoid. That each capture loads and is a PNG is asserted
	// over HTTP in `tests/routes.test.ts` instead.
	{ path: "/gallery", name: "gallery", expect: { ".shot": 4, ".phone__link img": 1 }, scroll: 900 },
	{ path: "/pages/about", name: "page-about", expect: { ".prose p": 5 } },
	{ path: "/pages/licensing", name: "page-licensing", expect: { ".prose h2": 3 }, anchor: "#the-statuses" },
	// `/lab` and the fixture selections, and the 5,000-entry wall, are
	// development-only and live in `DEV_ROUTES` above rather than being spliced
	// in here behind an origin test: the coverage table can then see what a
	// production run is *not* looking at and print it.
	// Search in the three states it can be in. The blank page and the zero-result
	// page are two of the states `DESIGN.md` §8 requires to be as good as the
	// loaded one, and neither had ever been captured: a matrix holding only
	// `/search?q=seam` cannot see whether "nothing found" offers a way forward.
	{ path: "/search", name: "search-blank", covers: "search", expect: { "#q-page": 1, ".suggest .tile": 8 }, media: true },
	{ path: "/search?q=seam", name: "search", covers: "search", expect: { ".count": 1, ".found__row": 3 }, media: true },
	{
		path: "/search?q=zzqqxxwwnothing",
		name: "search-none",
		covers: "search",
		// The empty state has to *offer* something, not just say no: two ways out
		// and three concrete suggestions are the whole acceptance criterion.
		expect: { ".none__title": 1, ".none__links a": 2, ".tries li": 3 },
	},
	// The shortlist, empty and full. The full one is the state a reader is in
	// every time they use the product, and it is the only place the compare grid,
	// the per-entry disclosure, the export block and the clear form appear.
	{ path: "/board", name: "board", covers: "compare", expect: { ".empty__title": 1 } },
	{
		path: "/board",
		name: "board-full",
		covers: "compare",
		cookie: { ah_board: BOARD_COOKIE },
		expect: { ".entry": 4, ".entry__more": 4, ".clear details": 1, ".export": 1, ".empty__title": 0, ".chip": 2 },
		media: true,
	},
	{
		path: "/board?board=Autumn%20picks",
		name: "board-second",
		covers: "compare",
		cookie: { ah_board: BOARD_COOKIE },
		// The second board, at a different count, so the "N to choose between"
		// headline and the per-entry columns are read with two entries as well.
		expect: { ".entry": 2, ".chip": 2, ".chip--on": 1 },
		media: true,
	},
	// 404: not a dead end. A search field and eight ways in are the acceptance
	// criterion in `DESIGN.md` §8, so they are counted rather than hoped for.
	{ path: "/nope-does-not-exist", name: "404", expect: { ".finder input": 1, ".starts a": 8 }, allow404: true },
	// Non-HTML: checked for content type and well-formedness, not pixels.
	{ path: "/rss.xml", name: "feed", expect: {}, nonHtml: true },
	// `/lab` and the fixture selections: development only, listed in `DEV_ROUTES`
	// above. The two anchors are separate routes because they are separate claims —
	// the lab is 36,000px tall on a phone, so a `fullPage` capture of `/lab` is a
	// thumbnail of a header with the states too small to judge.
	...DEV_ROUTES,
];

/**
 * The routes this origin can actually serve.
 *
 * `ROUTES` stays whole so the coverage check can see what a production run is
 * *not* looking at, and `AUDITED` is what gets visited. The difference is
 * reported rather than hidden — see the note printed under the coverage table.
 */
const AUDITED = isLocal ? ROUTES : ROUTES.filter((route) => !route.devOnly);

/**
 * What the issue names, and what answers it.
 *
 * The point is not the table, it is that a route can be deleted, renamed or have
 * its `expect` emptied without anybody noticing that a state stopped being
 * checked — which is exactly how `/board` stayed empty-only and `/use/<slug>`
 * stayed single-state through a whole review cycle. A coverage claim nobody can
 * falsify is a claim rather than a check, so each row names the routes that carry
 * it and the run **fails** if a row is left with nothing behind it.
 */
const COVERAGE = {
	wall: { issue: "wall/home", routes: ["wall", "wall-filtered", "wall-scale-5000"] },
	search: { issue: "search/filter results", routes: ["search", "search-blank", "search-none", "wall-filtered"] },
	detail: { issue: "possibility detail", routes: ["detail", "detail-fold", "collection"] },
	compare: { issue: "compare/shortlist", routes: ["board", "board-full", "board-second"] },
	signals: {
		issue: "rating/report interactions",
		routes: ["detail-signals", "lab-signals"],
		// More than a route: the signed-in and signed-out states have to be
		// *distinguished*, which is `auditSignalStates`.
		extra: "auditSignalStates",
	},
	use: {
		issue: "asset-use/licence drill-in",
		routes: ["asset-use", "lab-use", "use-reference", "use-review", "use-attribution", "use-reusable", "use-not-retained"],
	},
	cms: { issue: "EmDash-managed content reflected publicly", routes: [], extra: "auditCmsReflection" },
	viewports: { issue: "key mobile/tablet/desktop viewports", routes: [], extra: "VIEWPORTS" },
	theme: { issue: "light/dark if both are supported", routes: [], extra: "auditDarkOnly" },
	lab: { issue: "/lab fixture states", routes: ["lab", "lab-signals", "lab-use"] },
};

const audit = [];
const failures = [];
const warnings = [];
/** Observed minimum distinct colours per media route — printed, never assumed. */
const blankMedia = [];
/** route@viewport → number of controls under the documented 44px floor. */
const tapUnder44 = new Map();
/** class key → one example, so the advisory can name real controls. */
const tapExamples = new Map();
/** Where each gated route's first plate starts. Printed; the gate is above. */
const folds = [];
/**
 * How wide each plate rendered, and whether the size floor applied. The floor is
 * a design-authority number for the use page (`plateMin`); this list exists so the
 * viewports the floor does not cover are printed rather than absent.
 */
const plateSizes = [];
/**
 * Folds that are **measured, not gated**.
 *
 * `DESIGN.md` §5b sets a rule for the wall — the catalogue is above the fold,
 * and `npm run check:visual` enforces it at 75% of the viewport. It says
 * nothing about the drill-in, the use page or search. Inventing a threshold for
 * those here would be a design decision made by a test script, so instead they
 * are measured and printed: the number is what turns "the mobile drill-in feels
 * type-heavy" into an observation somebody can argue with.
 */
const measuredFolds = [];
/** route → how many always-on accent-coloured elements it paints. */
const accents = [];
/** Placeholders wider than the field they sit in. Reported, not gated — see check 15. */
const placeholders = [];

function record(group, route, issues) {
	audit.push({ viewport: group, route: route.name, issues });
	for (const issue of issues) failures.push(`${group} ${route.name}: ${issue}`);
}

/**
 * In-page audit. Runs inside the browser so it measures what is rendered
 * rather than what the stylesheet intended.
 *
 * Returns the issues plus a count of the aspect-ratio containers it found, so a
 * page where that check had nothing to measure cannot report a pass that looks
 * like a clean bill of health.
 */
function pageAuditScript() {
	const issues = [];
	/**
	 * How an element is named in a message. Two classes, never an index or a
	 * path: the point is that somebody can find the thing, not that the report is
	 * machine-parseable.
	 */
	const describe = (el) =>
		`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${
			el.className && typeof el.className === "string" && el.className.trim()
				? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
				: ""
		}`;

	// 1. Horizontal overflow. Any element wider than the viewport is a layout
	//    bug; the most common cause on this site is a long unbroken token.
	const docWidth = document.documentElement.clientWidth;
	if (document.documentElement.scrollWidth > docWidth + 1) {
		const wide = [];
		for (const el of document.querySelectorAll("body *")) {
			const r = el.getBoundingClientRect();
			if (r.width > docWidth + 1 || r.right > docWidth + 1) {
				wide.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}`);
				if (wide.length > 4) break;
			}
		}
		issues.push(`horizontal overflow: ${document.documentElement.scrollWidth}px > ${docWidth}px (${wide.join(", ")})`);
	}

	// 2. The shell gutter. `.shell` is what keeps content off the viewport edge,
	//    and a `padding` shorthand in a component silently replaces its inline
	//    padding. The result looks like a deliberate full-bleed row until you
	//    notice a heading touching the screen edge, so it is measured here.
	for (const el of document.querySelectorAll(".shell")) {
		const cs = getComputedStyle(el);
		const left = Number.parseFloat(cs.paddingLeft);
		const right = Number.parseFloat(cs.paddingRight);
		if (left < 12 || right < 12) {
			issues.push(
				`shell gutter lost: ${(el.className || "").toString().split(" ")[0]} has ${left}px/${right}px inline padding`,
			);
		}
	}

	// 3. Tap targets. 44px is the accepted minimum; the whole tile is the
	//    target here, so this only fires when a link is genuinely too small.
	for (const el of document.querySelectorAll("a, button, input, [role='tab']")) {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		if (getComputedStyle(el).visibility === "hidden") continue;
		if (r.height < 24 || r.width < 24) {
			issues.push(
				`tap target ${Math.round(r.width)}x${Math.round(r.height)} below 24px: ${(el.textContent || "").trim().slice(0, 30) || el.tagName}`,
			);
			if (issues.length > 12) break;
		}
	}

	// 4. Body text contrast against the actual painted background.
	//    These helpers live inside the page script: `page.evaluate` serialises
	//    the function body, so it cannot close over module scope.
	const lum = (rgb) => {
		const [r, g, b] = rgb.map((v) => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const ratio = (a, b) => {
		const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
		return (l1 + 0.05) / (l2 + 0.05);
	};
	const parseRgb = (value) => {
		const m = value.match(/rgba?\\(([^)]+)\\)/);
		if (!m) return null;
		const parts = m[1].split(",").map((n) => Number.parseFloat(n.trim()));
		return parts.slice(0, 3).every(Number.isFinite) ? parts : null;
	};
	const bgOf = (el) => {
		let node = el;
		while (node && node !== document.documentElement) {
			const bg = getComputedStyle(node).backgroundColor;
			const rgb = bg.match(/rgba?\(([^)]+)\)/);
			if (rgb) {
				const alpha = rgb[1].split(",")[3];
				if (alpha === undefined || Number.parseFloat(alpha) > 0.9) return bg;
			}
			node = node.parentElement;
		}
		return "rgb(8, 9, 10)";
	};
	const samples = [
		...document.querySelectorAll("p, li, dd, dt, a, h1, h2, h3"),
	].slice(0, 40);
	for (const el of samples) {
		if (!el.textContent?.trim()) continue;
		const cs = getComputedStyle(el);
		const fg = cs.color;
		const bg = bgOf(el);
		const cr = ratio(parseRgb(fg) ?? [244, 242, 238], parseRgb(bg) ?? [8, 9, 10]);
		const size = Number.parseFloat(cs.fontSize);
		const weight = Number(cs.fontWeight) || 400;
		const large = size >= 24 || (size >= 18.66 && weight >= 700);
		const min = large ? 3 : 4.5;
		if (cr < min) {
			issues.push(
				`contrast ${cr.toFixed(2)} < ${min} (${Math.round(size)}px ${cs.color} on ${bg}): ${el.textContent.trim().slice(0, 28)}`,
			);
			if (issues.length > 12) break;
		}
	}

	// 5. Images that did not resolve. A broken specimen is a broken tile.
	const broken = [...document.images].filter(
		(img) => img.complete && img.naturalWidth === 0 && img.getAttribute("src"),
	);
	if (broken.length) {
		issues.push(`${broken.length} broken image(s): ${broken.map((i) => i.getAttribute("src")).slice(0, 3).join(", ")}`);
	}

	// 6. Alt text on content images.
	const noAlt = [...document.images].filter((img) => !img.hasAttribute("alt"));
	if (noAlt.length) issues.push(`${noAlt.length} image(s) missing alt attribute`);

	// 7. Exactly one h1, and a document language.
	if (document.querySelectorAll("h1").length !== 1) {
		issues.push(`${document.querySelectorAll("h1").length} h1 elements (expected 1)`);
	}
	if (!document.documentElement.getAttribute("lang")) issues.push("no lang on <html>");

	// 8. Headings in order — a skipped level breaks screen-reader navigation.
	const levels = [...document.querySelectorAll("h1,h2,h3,h4")].map((h) =>
		Number(h.tagName[1]),
	);
	for (let i = 1; i < levels.length; i++) {
		if (levels[i] - levels[i - 1] > 1) {
			issues.push(`heading jump h${levels[i - 1]} → h${levels[i]}`);
			break;
		}
	}

	// 9. Content clipped inside a box that cannot scroll. Check 1 only sees the
	//    root scroller, so a heading or a button cropped by an ancestor's
	//    `overflow: hidden` reads as perfectly fine to it. Boxes holding media are
	//    skipped: a plate deliberately scales 1.028 on hover and is *meant* to be
	//    cropped by its frame — what must never happen is text disappearing.
	const clipped = [];
	for (const el of document.querySelectorAll("body *")) {
		const cs = getComputedStyle(el);
		if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
		if (el.clientWidth < 24 || el.clientHeight < 8) continue;
		if (el.querySelector("img, svg, video, canvas, .tile__absent")) continue;
		if (el.scrollWidth > el.clientWidth + 4) {
			clipped.push(`${describe(el)} clips ${el.scrollWidth - el.clientWidth}px`);
			if (clipped.length > 3) break;
		}
	}
	for (const c of clipped) issues.push(`clipped content: ${c}`);

	// 10. Interactive elements that have collapsed to nothing. Check 3 skips
	//     zero-size boxes, which is exactly the case worth catching: a control
	//     with no area is a control nobody can find, and it is invisible to a
	//     size check that only complains about small boxes.
	const collapsed = [];
	for (const el of document.querySelectorAll(
		"a,button,input,select,textarea,summary,[tabindex]",
	)) {
		const cs = getComputedStyle(el);
		if (cs.display === "none" || cs.visibility === "hidden") continue;
		if (el.closest("[hidden]")) continue;
		// A control inside a closed <details> has not been laid out yet, which is
		// correct. Its <summary> has, and is visible, so that one is kept.
		if (el.tagName !== "SUMMARY" && el.closest("details:not([open])")) continue;
		const r = el.getBoundingClientRect();
		if (r.width >= 1 && r.height >= 1) continue;
		collapsed.push(`${describe(el)} has no area (${Math.round(r.width)}×${Math.round(r.height)})`);
		if (collapsed.length > 3) break;
	}
	for (const c of collapsed) issues.push(`collapsed control: ${c}`);

	// 11. Aspect-ratio containers that are not the ratio they declare. Every
	//     specimen plate is 4:5 and its meaning often sits in an annotation near
	//     an edge, so a container rendering wider is cutting content off rather
	//     than framing it. This is the general form of the `plateAspect` check on
	//     the wall: it also covers search thumbnails and the use-page previews,
	//     which nothing was asserting before.
	let ratioContainers = 0;
	for (const el of document.querySelectorAll("body *")) {
		const declared = getComputedStyle(el).aspectRatio;
		if (!declared || declared === "auto") continue;
		const parts = declared.split("/").map((n) => Number.parseFloat(n));
		if (parts.length !== 2 || !parts.every(Number.isFinite) || parts[1] === 0) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 8 || r.height < 8) continue;
		ratioContainers++;
		const want = parts[0] / parts[1];
		const got = r.width / r.height;
		if (Math.abs(got - want) > 0.03) {
			issues.push(
				`aspect-ratio: ${describe(el)} declares ${want.toFixed(2)}:1 and renders ${got.toFixed(2)}:1`,
			);
			if (issues.length > 14) break;
		}
	}

	// 12. Element ids that are used twice.
	//
	//     `<label for>` resolves to the *first* element with that id, so a second
	//     one is not merely untidy: the label names the wrong control and the
	//     fragment link lands on the wrong element. This is how `/search` ended up
	//     with two `id="q"` — the masthead's search field and the page's own — and
	//     how `/lab`, which renders all seven rating states at once, ended up with
	//     `signals` eight times and `reason-<slug>` seven times.
	//
	//     Nothing else in this script could see it: the accessibility tree reports a
	//     label as present whether or not it points at the intended control, and
	//     `document.querySelector("#q")` happily returns the first match.
	//
	//     The count is reported rather than just the first offender, because "this
	//     page has 30 duplicate ids" and "this page has one" are different problems
	//     with different fixes.
	const idCounts = new Map();
	for (const el of document.querySelectorAll("[id]")) {
		idCounts.set(el.id, (idCounts.get(el.id) ?? 0) + 1);
	}
	const duplicated = [...idCounts.entries()].filter(([, n]) => n > 1);
	if (duplicated.length) {
		issues.push(
			`${duplicated.length} duplicated id(s): ${duplicated
				.slice(0, 6)
				.map(([id, n]) => `${id} x${n}`)
				.join(", ")} — every <label for> and every #fragment resolves to the first one`,
		);
	}

	// 13. A label that points at nothing.
	//
	//     The other half of check 12, and the one that survives an id being
	//     *renamed* rather than duplicated: a control with a `for` that resolves to
	//     zero elements has no accessible name at all, however good the visible
	//     text beside it is. Check 12 cannot see that case at all.
	const dangling = [];
	for (const label of document.querySelectorAll("label[for]")) {
		const target = label.getAttribute("for");
		if (!target || document.getElementById(target)) continue;
		dangling.push(`${describe(label)} → #${target}`);
		if (dangling.length > 4) break;
	}
	if (dangling.length) {
		issues.push(
			`${dangling.length} label(s) point at an id that does not exist: ${dangling.slice(0, 4).join(", ")}`,
		);
	}

	// 14. A status line that opens with a separator.
	//
	//     These lines are built by joining counted parts with a middle dot, and the
	//     join is where a rendering fault hides: `/search` with no results rendered
	//     its `role="status"` count as `· for zzqqxxwwnothing` — a leading separator
	//     with nothing before it. It only happened on the emptiest state, which is
	//     the state a page is least likely to be reviewed in, and no other check
	//     here can see it: the text is present, correctly sized, correctly contrasted
	//     and not clipped.
	//
	//     Scoped to live regions and the site's count/tally lines rather than to all
	//     text, because a paragraph legitimately starting with an em dash is not a
	//     fault. A separator is a *join*, so it only looks wrong where a join is
	//     possible.
	const ledWithSeparator = [];
	for (const el of document.querySelectorAll(
		"[role='status'], [role='alert'], .count, .tally, .summary__line, .signal__value",
	)) {
		const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (!/^[·|—–/,;:]/.test(text)) continue;
		ledWithSeparator.push(`${describe(el)} reads "${text.slice(0, 40)}"`);
		if (ledWithSeparator.length > 3) break;
	}
	if (ledWithSeparator.length) {
		issues.push(
			`${ledWithSeparator.length} status/count line(s) begin with a separator, which reads as a join with nothing before it: ${ledWithSeparator.join(", ")}`,
		);
	}

	// 15. A placeholder that does not fit its own field.
	//
	//     A placeholder is painted *inside* the control and scrolls with it, so
	//     check 9 cannot see this: the input's `scrollWidth` is the **value's**
	//     width, not the placeholder's, and an empty input has no overflow at all.
	//     The result is a truncated sentence with no ellipsis and no scrollbar —
	//     `screenshots/404--mobile-390.png` shows "Try a technique, a treatmen",
	//     cut mid-word, which reads as a rendering fault rather than as a short
	//     hint.
	//
	//     Measured with a canvas at the element's own computed font, because the
	//     placeholder is drawn in the input's font and nothing else knows how wide
	//     it will be. A visible placeholder is the field explaining itself; a
	//     clipped one is the field failing to.
	//
	//     **Single-line inputs only.** A `<textarea>` placeholder *wraps* — it is
	//     painted over as many lines as it needs and the box scrolls — so a long
	//     hint in a textarea is a hint that is fully visible, and treating it as
	//     clipped reported the report form's 59-character placeholder as a defect on
	//     every viewport. A check that cries wolf on correct markup is a check
	//     people learn to ignore.
	//
	//     `type` is narrowed to the text-like inputs for the same reason: a
	//     `date` or `number` field paints its own format hint in its own glyphs.
	//     `datetime-local`, `month` and `time` keep their native picker.
	//
	//     The only inputs whose hint is a sentence are the search fields, and those
	//     are the two this found.
		// The input types whose `placeholder` is painted as text this script can
	// measure. `search` is here because both finders are `type="search"`.
	const TEXT_INPUTS = new Set([
		"text",
		"search",
		"url",
		"email",
		"tel",
		"password",
	]);
	const clippedPlaceholders = [];
	for (const el of document.querySelectorAll("input[placeholder]")) {
		if (!TEXT_INPUTS.has(el.type)) continue;
		const text = el.getAttribute("placeholder")?.trim() ?? "";
		// Only a placeholder that is actually on screen: a filled field is showing
		// its value, and a hidden one is showing nothing.
		if (!text || el.value) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 8 || r.height < 8) continue;
		if (Number.parseFloat(getComputedStyle(el).opacity) === 0) continue;
		const cs = getComputedStyle(el);
		const measure = document.createElement("canvas").getContext("2d");
		if (!measure) break;
		measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
		const needed = measure.measureText(text).width;
		const available =
			el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
		if (needed <= available + 1) continue;
		clippedPlaceholders.push(
			`${describe(el)} needs ${Math.round(needed)}px for "${text}" and has ${Math.round(available)}px — ${Math.round(needed - available)}px of it is cut`,
		);
		if (clippedPlaceholders.length > 3) break;
	}
	/*
	 * **Reported, not gated**, and the distinction is the point.
	 *
	 * A clipped placeholder is a real defect — the field is failing to explain
	 * itself — and the fix is usually mechanical (give the field the line instead of
	 * the button). But when the field already has the whole line and the sentence is
	 * still too long, the only remaining move is to change the words, and the words
	 * are the design authority's: `DESIGN.md` §9.1 gives the search placeholder as
	 * "technique, treatment, problem, tool" and §3 sets 10–13px mono as the floor for
	 * the label voice. Failing the run over that would be a script making a copy
	 * decision, which is the same mistake as gating a fold the authority has not
	 * written a rule for.
	 *
	 * So the number is printed with the offenders named, the detector is proved by
	 * the self-check, and the decision stays where it belongs.
	 */
	return { issues, ratioContainers, clippedPlaceholders };
}

/**
 * One page interaction, retried once.
 *
 * `astro dev` full-reloads on any file change, which destroys the execution
 * context mid-`evaluate`. That is an artefact of auditing against a live dev
 * server rather than a layout fault, so it is retried once after the reload
 * settles and only then reported. Without this a single unrelated edit in
 * another checkout aborts the whole matrix, which is how a check gets skipped.
 */
async function attempt(fn, page) {
	for (let i = 0; i < 2; i++) {
		try {
			return await fn();
		} catch (err) {
			const message = String(err);
			const transient =
				/Execution context was destroyed|Target closed|navigation|frame was detached/i.test(message);
			if (!transient || i === 1) throw err;
			await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
			await page.waitForTimeout(250);
		}
	}
	return undefined;
}

/**
 * Sticky and fixed chrome, measured on a **scrolled** frame.
 *
 * This is the check the matrix could not do before, and it is the one that found
 * a real bug: Chromium lays sticky elements out at their unscrolled position in
 * a `fullPage` screenshot, so a filter rail sliding under the masthead captured
 * perfectly. It only exists in the browser once you have scrolled.
 *
 * What is asserted is the user-facing version: one sticky element painted over
 * another, and how many pixels of it are hidden. Naming both elements matters,
 * because "overlapping fixed/sticky UI" without a name is a warning nobody can
 * act on.
 */
async function auditStickyOverlap(page) {
	/*
	 * Wait for the sticky geometry to settle before measuring it.
	 *
	 * `--masthead-h` is a *measured* value published by script after first paint
	 * (`Base.astro` explains why: the nav wraps at enlarged text, so the height
	 * cannot be a stylesheet constant). Between `goto` and that publication the
	 * rail sticks at the CSS default and genuinely does sit under the masthead —
	 * a real but transient state. Measuring it reported a 43px overlap on four
	 * viewports of a page that is correct a moment later, which is the worst kind
	 * of finding: true, and useless.
	 *
	 * So this polls the boxes themselves until two consecutive samples agree.
	 * Nothing about the assertion is softened; the only thing dropped is the
	 * window before the page has finished measuring itself.
	 */
	let previous = null;
	let stable = 0;
	for (let i = 0; i < 12; i++) {
		const boxes = await attempt(
			() =>
				page.evaluate(() =>
					[...document.querySelectorAll("body *")]
						.filter((el) => {
							const position = getComputedStyle(el).position;
							return position === "sticky" || position === "fixed";
						})
						.map((el) => {
							const r = el.getBoundingClientRect();
							return `${Math.round(r.top)}:${Math.round(r.bottom)}`;
						})
						.join("|"),
				),
			page,
		);
		stable = boxes === previous ? stable + 1 : 0;
		previous = boxes;
		if (stable >= 1 && i >= 1) break;
		await page.waitForTimeout(120);
	}

	const overlaps = await page.evaluate(() => {
		const describe = (el) =>
			`${el.tagName.toLowerCase()}${
				el.className && typeof el.className === "string" && el.className.trim()
					? `.${el.className.trim().split(/\s+/)[0]}`
					: ""
			}`;
		const sticky = [...document.querySelectorAll("body *")].filter((el) => {
			const position = getComputedStyle(el).position;
			return (position === "sticky" || position === "fixed") && el.getBoundingClientRect().height > 0;
		});
		const out = [];
		for (const el of sticky) {
			const a = el.getBoundingClientRect();
			const z = Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
			for (const other of sticky) {
				if (other === el || el.contains(other) || other.contains(el)) continue;
				const b = other.getBoundingClientRect();
				const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
				const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
				if (overlapX <= 1 || overlapY <= 1) continue;
				const otherZ = Number.parseInt(getComputedStyle(other).zIndex, 10) || 0;
				// `el` is the element being overlapped and `other` is the one doing
				// it, so the naming follows the *painter*: when `other` has the
				// higher layer, `el` is what is behind it. Getting this backwards
				// blames the masthead for the rail covering it, which is worse than
				// saying nothing.
				out.push({
					behind: describe(el),
					inFront: describe(other),
					px: Math.round(overlapY),
					// Only a *higher* layer hides anything; two sticky blocks that
					// merely overlap and neither paints over the other is a
					// different, much lesser problem.
					occludes: otherZ > z,
				});
			}
		}
		return out;
	});
	return overlaps.map((o) =>
		o.occludes
			? `sticky ${o.behind} is ${o.px}px behind ${o.inFront}`
			: `sticky ${o.behind} and ${o.inFront} overlap by ${o.px}px with neither on top`,
	);
}

/**
 * In-page anchor targets must land below the sticky masthead.
 *
 * `/verticals#games`, `/pages/licensing#the-statuses` and every breadcrumb link
 * into a page section are ordinary links on this site, so an anchor that scrolls
 * its target underneath the masthead is a link that arrives looking broken. The
 * stylesheet has `scroll-padding` and `scroll-margin` for exactly this; this
 * asserts the result rather than the intent.
 *
 * The measurement polls until it stops moving. `scroll-behavior: smooth` makes
 * the arrival a ~600ms animation, and a single sample during it reports a
 * position no reader ever saw — which is how a false positive gets filed as a
 * bug. Three consecutive identical readings is the arrived-at state; the loop
 * is capped so a page that genuinely never settles still produces a number.
 */
async function auditAnchor(page, hash) {
	let previous = null;
	let stable = 0;
	let issues = [];
	let sample = null;
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(120);
		const reading = await attempt(
			() =>
				page.evaluate((selector) => {
					const target = document.querySelector(selector);
					if (!target) return { missing: true };
					const chrome = [...document.querySelectorAll("body *")].filter((el) => {
						const position = getComputedStyle(el).position;
						return (
							(position === "sticky" || position === "fixed") &&
							el.getBoundingClientRect().height > 0
						);
					});
					let coverTop = 0;
					for (const el of chrome) {
						const r = el.getBoundingClientRect();
						if (r.top <= 1 && r.bottom > 1) coverTop = Math.max(coverTop, r.bottom);
					}
					const top = target.getBoundingClientRect().top;
					return {
						missing: false,
						top: Math.round(top),
						coverTop: Math.round(coverTop),
						hidden: Math.round(top - coverTop),
					};
				}, hash),
			page,
		);
		if (reading.missing) return [`anchor: ${hash} not found in the document`];
		stable = reading.top === previous ? stable + 1 : 0;
		previous = reading.top;
		sample = reading;
		if (stable >= 3 && i >= 3) break;
		issues = [];
	}
	if (!sample) return [];
	if (sample.hidden < -1) {
		/*
		 * Confirm before failing.
		 *
		 * `--masthead-h` is published by script *after* first paint, and the
		 * fragment scroll has already happened by then, so there is a real window
		 * in which the target sits under a masthead that is about to grow. A
		 * single sample inside that window reports a state the reader never sees
		 * — and a false positive filed as a bug costs more than a missed one.
		 * Re-measuring after a pause separates "the page settles wrong" from "the
		 * page was still settling".
		 */
		await page.waitForTimeout(600);
		const confirm = await attempt(
			() => page.evaluate((selector) => {
				const target = document.querySelector(selector);
				if (!target) return null;
				const masthead = document.querySelector(".masthead");
				const cover = masthead ? masthead.getBoundingClientRect().bottom : 0;
				return {
					top: Math.round(target.getBoundingClientRect().top),
					coverTop: Math.round(cover),
					hidden: Math.round(target.getBoundingClientRect().top - cover),
				};
			}, hash),
			page,
		);
		if (confirm && confirm.hidden >= -1) return [];
		issues.push(
			`anchor ${hash} lands ${Math.round(-(confirm ?? sample).hidden)}px under the sticky masthead (target top ${(confirm ?? sample).top}px, chrome ends ${(confirm ?? sample).coverTop}px)`,
		);
	}
	return issues;
}

/**
 * Blank or failed media.
 *
 * Check 5 catches an image whose request failed. This catches the other failure:
 * an image that *loads* and paints a flat rectangle — a transparent placeholder,
 * a 1×1 stretched to 800×1000, a plate whose content never rendered. On a
 * media-first catalogue a blank plate is indistinguishable from a real one to
 * every other check, so the pixels themselves have to be sampled.
 *
 * The image is drawn at 40×50 and its colours are bucketed to 5 bits per
 * channel: cheap, and enough that a real specimen plate lands in the dozens while
 * a blank frame lands on exactly 1. The threshold is 8 — an order of magnitude
 * below the lowest real plate on this site (49) and far above a flat frame.
 *
 * Returns the observed minimum so a pass cannot be confused with "nothing was
 * sampled".
 */
async function auditBlankMedia(page) {
	return page.evaluate(async () => {
		const images = [...document.images].filter(
			(img) => img.complete && img.naturalWidth > 0 && img.getClientRects().length > 0,
		);
		/*
		 * Images this check could **not** look at, counted rather than ignored.
		 *
		 * `loading="lazy"` images below the fold have not been requested, so
		 * `img.complete` is false and the filter above skips them. On a long page —
		 * the lab is 14,490px tall — that is most of the plates, and the check then
		 * reports a healthy minimum from the handful that happened to be in the first
		 * viewport. It passed, and it had not looked at anything below the fold.
		 *
		 * Not a failure: a lazy image that has not loaded is the page behaving
		 * correctly. But a run that says "fewest distinct colours on any plate: 49"
		 * has to say how many plates that number is drawn from, or the number reads
		 * as a claim about the whole page.
		 */
		const deferred = [...document.images].filter(
			(img) => img.getAttribute("src") && (!img.complete || img.naturalWidth === 0),
		).length;
		if (!images.length) {
			return { issues: ["blank media: no resolved image on a media route"], sampled: 0, least: 0, deferred };
		}
		const canvas = document.createElement("canvas");
		canvas.width = 40;
		canvas.height = 50;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		const issues = [];
		let least = Number.POSITIVE_INFINITY;
		let sampled = 0;
		for (const img of images.slice(0, 24)) {
			let colours = 0;
			try {
				ctx.clearRect(0, 0, 40, 50);
				ctx.drawImage(img, 0, 0, 40, 50);
				const data = ctx.getImageData(0, 0, 40, 50).data;
				const seen = new Set();
				for (let i = 0; i < data.length; i += 4) {
					seen.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`);
				}
				colours = seen.size;
			} catch (err) {
				issues.push(`blank media: could not sample ${img.getAttribute("src")} (${String(err).slice(0, 60)})`);
				continue;
			}
			sampled++;
			least = Math.min(least, colours);
			if (colours < 8) {
				issues.push(
					`blank media: ${img.getAttribute("src")} resolved ${img.naturalWidth}×${img.naturalHeight} but paints ${colours} colour(s) — a flat frame reads as a real plate`,
				);
				if (issues.length > 3) break;
			}
		}
		return { issues, sampled, least: least === Number.POSITIVE_INFINITY ? 0 : least, deferred };
	});
}

/**
 * Layout shift once the media arrives.
 *
 * The obvious version of this check — measure the page, wait for the images,
 * measure again — passes vacuously, because `waitUntil: "networkidle"` means the
 * images have *already* loaded. So the media is deliberately held back: the
 * specimen requests are delayed at the network layer, the geometry is captured
 * with the plates still missing, and only then are they released.
 *
 * Nothing moves here because every image carries intrinsic `width`/`height` and
 * every plate reserves `aspect-ratio`, which is the point — and if somebody
 * drops one of those, the numbers stop matching and this fails.
 */
async function auditLayoutShift(browser, viewport, route, url) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		locale: "en-GB",
		timezoneId: "UTC",
		colorScheme: "dark",
	});
	const page = await context.newPage();
	/*
	 * The obvious version of this check passes vacuously: `networkidle` means the
	 * images have *already* loaded, so measuring "before" and "after" compares
	 * two identical states. Holding the requests back at the network layer fixes
	 * that for real pages and does nothing for an inline `data:` image, which has
	 * no request to hold.
	 *
	 * So the media is removed from the document instead: every `src` is taken off
	 * (leaving `data-src`), the page is laid out and measured with nothing there,
	 * and then the sources are put back and the images decoded. That is the
	 * arrival the reader sees, it works identically for a file, a network image
	 * and an inline one, and it needs no interception at all.
	 */
	/*
	 * `snapshot` is retried, because the whole audit is measuring layout and a
	 * measurement that dies on a technicality reports nothing at all.
	 *
	 * The failure is `Execution context was destroyed, most likely because of a
	 * navigation` — the page navigated between `page.evaluate` and the promise
	 * resolving, so the JS context the callback was running in no longer existed.
	 * Putting the `src` attributes back triggers exactly that: an `<img>` with no
	 * `src` that then gets one is a load the page was free to react to, and on a
	 * route with a client-side redirect or a late meta refresh the navigation wins
	 * the race.
	 *
	 * Two runs of `npm run check:visual` produced this, and both times the harness
	 * exited non-zero with no report at all — which is the worst outcome available:
	 * not "the layout shifted", not "this route failed", but silence. Every route
	 * after the one that died went unchecked and nothing said so.
	 *
	 * So: retry the measurement, and on persistent failure say which route could
	 * not be measured. `assessLayoutShift` is a measurement, and a measurement that
	 * cannot complete is reported as *not measured* rather than as a pass — the same
	 * rule the aspect-ratio check already uses for `ratioContainers === 0`, and the
	 * one #47 is built on: a check that passed because it had nothing to look at is
	 * the failure mode this harness exists to prevent.
	 */
	const snapshot = async () => {
		let lastError;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await page.evaluate(() => ({
					positions: [...document.querySelectorAll("body *")].map((el) =>
						Math.round(el.getBoundingClientRect().top),
					),
					height: document.documentElement.scrollHeight,
					images: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length,
				}));
			} catch (error) {
				lastError = error;
				// The context is gone because something navigated. Settle, then try
				// again against whatever document is current now.
				await page
					.waitForLoadState("domcontentloaded", { timeout: 15000 })
					.catch(() => {});
			}
		}
		throw lastError;
	};
	try {
		await page.goto(url ?? `${baseUrl}${route.path}`, {
			waitUntil: "networkidle",
			timeout: 30000,
		});
		const stripped = await page.evaluate(async () => {
			const images = [...document.images].filter((i) => i.getAttribute("src"));
			for (const img of images) {
				img.dataset.shiftSrc = img.getAttribute("src");
				img.removeAttribute("src");
			}
			return images.length;
		});
		const before = await snapshot();
		await page.evaluate(async () => {
			const images = [...document.images].filter((i) => i.dataset.shiftSrc);
			for (const img of images) img.setAttribute("src", img.dataset.shiftSrc);
			await Promise.all(images.map((img) => img.decode?.().catch(() => {}) ?? null));
		});
		await page.waitForLoadState("networkidle", { timeout: 30000 });
		const after = await snapshot();

		if (after.images === 0) return ["layout shift: no image resolved, so nothing could shift"];
		if (stripped === 0) return ["layout shift: the page carries no image, so nothing could shift"];
		if (before.positions.length !== after.positions.length) {
			return ["layout shift: the DOM changed between the unmediated and mediated renders"];
		}
		let worst = 0;
		for (let i = 0; i < before.positions.length; i++) {
			worst = Math.max(worst, Math.abs(after.positions[i] - before.positions[i]));
		}
		const drift = Math.abs(after.height - before.height);
		const issues = [];
		// One pixel of tolerance: sub-pixel layout is arithmetic, not shift.
		if (worst > 1) issues.push(`layout shift: content moved ${worst}px when the media loaded`);
		if (drift > 1) issues.push(`layout shift: page height changed by ${drift}px when the media loaded`);
		return issues;
	} catch (error) {
		/*
		 * Unmeasurable, and reported as such rather than swallowed.
		 *
		 * This used to propagate out of the function. The harness then exited
		 * non-zero having printed nothing — no pass, no fail, no route name — and
		 * every route after the one that died went unchecked in silence. A crash is
		 * not a verdict, and the worst thing a measurement harness can do is fail in
		 * a way that reads like success-or-mystery.
		 *
		 * `auditLayoutShift` returns issue strings, so the honest answer is one that
		 * says it could not measure. It reads as a finding rather than as a pass
		 * because it is reported like every other finding, and it names the route so
		 * somebody knows exactly which measurement is missing.
		 */
		return [
			`layout shift: NOT MEASURED — ${String(error).split("\n")[0].slice(0, 120)}. ` +
				`This route's layout-shift check did not complete, so nothing is known about it.`,
		];
	} finally {
		await context.close();
	}
}

/**
 * Dark-only is a **decision**, so the check asserts the absence of a light theme
 * rather than skipping it (#47's "light/dark if both are supported").
 *
 * `DESIGN.md` §9.3 is explicit: the catalogue is a lit-vitrine archive, a light
 * theme would mean re-authoring 25 plates and re-tuning every contrast pair, and
 * "if a light mode is ever genuinely wanted, it is a separate visual system, not
 * a token flip". So there is one theme, and the useful automated question is
 * not "does light look right" but "has light crept in anyway".
 *
 * Four things are measured, and each can fail on its own:
 *
 * 1. `color-scheme` resolves to `dark` on the document, so a browser paints its
 *    own scrollbars and form controls for a dark page rather than light ones
 *    under a dark canvas.
 * 2. **The page renders identically under `prefers-color-scheme: dark` and
 *    `prefers-color-scheme: light`.** This is the real assertion: a `@media
 *    (prefers-color-scheme: light)` block anywhere in the bundle, a `light-dark()`
 *    call, or a `data-theme` flip changes something here.
 * 3. No theme control exists in the interface. A switch that flips a token and
 *    then reveals a second visual system is exactly what §9.3 refuses, and it
 *    would be invisible in a screenshot of the default state.
 * 4. The tokens that carry the whole system are the same in both contexts.
 *
 * The self-check points the same comparison at a page that *does* switch, so this
 * cannot pass vacuously — see `auditDarkOnly` in the self-check.
 */
async function auditDarkOnly(browser, url) {
	const read = async (scheme) => {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			colorScheme: scheme,
			locale: "en-GB",
			timezoneId: "UTC",
		});
		const page = await context.newPage();
		try {
			await page.goto(url ?? `${baseUrl}/`, { waitUntil: "networkidle", timeout: 30000 });
			return await page.evaluate(() => {
				const root = getComputedStyle(document.documentElement);
				const body = getComputedStyle(document.body);
				return {
					colorScheme: root.colorScheme,
					canvas: root.getPropertyValue("--canvas").trim(),
					ink: root.getPropertyValue("--ink").trim(),
					painted: body.backgroundColor,
					// A toggle, a switch, a theme picker: anything that could reach a
					// second visual system. Matched on the words rather than on a class,
					// because a class can be renamed and the control cannot.
					switches: [
						...document.querySelectorAll("button, a, input, select, [role='switch'], [role='button']"),
					]
						.map(
							(el) =>
								`${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim()} ${el.className ?? ""}`.toLowerCase(),
						)
						.filter((text) => /\b(theme|dark mode|light mode|colour scheme|color scheme)\b/.test(text))
						.slice(0, 3),
				};
			});
		} finally {
			await context.close();
		}
	};

	const issues = [];
	const dark = await read("dark");
	const light = await read("light");

	if (dark.colorScheme !== "dark") {
		issues.push(
			`theme: html resolves color-scheme "${dark.colorScheme}", not "dark" — a light page is announced to the browser`,
		);
	}
	if (light.canvas !== dark.canvas || light.ink !== dark.ink) {
		issues.push(
			`theme: prefers-color-scheme: light changes the tokens (--canvas ${dark.canvas} → ${light.canvas}, --ink ${dark.ink} → ${light.ink}); DESIGN.md §9.3 is dark only`,
		);
	}
	if (light.painted !== dark.painted) {
		issues.push(
			`theme: the page background changes under prefers-color-scheme: light (${dark.painted} → ${light.painted})`,
		);
	}
	if (dark.switches.length || light.switches.length) {
		issues.push(
			`theme: a theme control exists in the interface (${[...new Set([...dark.switches, ...light.switches])].join(" | ")}) — DESIGN.md §9.3 is dark only, so a switch reveals a second visual system that does not exist`,
		);
	}
	return issues;
}

/**
 * The rating and report states, asserted as *behaviour* rather than as counts.
 *
 * The lab renders all seven states at once, and the difference between the two
 * authentication states is not decoration: the rate button is disabled when
 * signed out and the report fieldset is disabled with it, because a rating a
 * reader cannot withdraw is a vote and a report nobody can answer is worse than
 * no report. A count of `.rate__star` cannot tell an enabled button from a
 * disabled one, so the panel's own `data-viewer` marker is checked against the
 * state of the controls it describes.
 *
 * The two states also have to differ in the *other* direction: the numbers are
 * public whether or not you are signed in. A signed-out panel with no ratings on
 * screen is indistinguishable from a broken one, so the fixture set has to
 * include a signed-out panel that still shows a distribution.
 */
async function auditSignalStates(page) {
	return page.evaluate(() => {
		const issues = [];
		const cases = [...document.querySelectorAll(".signal-case")];
		if (!cases.length) return ["signal states: no .signal-case on the page, so nothing was compared"];

		let sawDistributionWhileSignedOut = false;
		for (const [index, panel] of cases.entries()) {
			const signedIn = panel.dataset.viewer === "signed-in";
			const rate = panel.querySelector(".rate button");
			const fieldset = panel.querySelector(".report__form fieldset");
			if (!rate) {
				issues.push(`signal state ${index + 1}: no rate button`);
			} else if (rate.disabled === signedIn) {
				// `rate.disabled === signedIn` is wrong in both directions: a signed-in
				// reader must be able to rate, and a signed-out one must not be able to.
				issues.push(
					`signal state ${index + 1}: the rate button is ${rate.disabled ? "disabled" : "enabled"} but the panel is marked ${signedIn ? "signed-in" : "signed-out"}`,
				);
			}
			if (!fieldset) {
				issues.push(`signal state ${index + 1}: no report fieldset`);
			} else if (fieldset.disabled === signedIn) {
				issues.push(
					`signal state ${index + 1}: the report form is ${fieldset.disabled ? "disabled" : "enabled"} but the panel is marked ${signedIn ? "signed-in" : "signed-out"}`,
				);
			}
			// The refusal has to name the way in. A disabled control with no route is
			// the keyboard journey failing at its last step.
			if (!signedIn) {
				const signIn = [...panel.querySelectorAll("a")].some(
					(a) => (a.getAttribute("href") ?? "").includes("_emdash"),
				);
				if (!signIn) {
					issues.push(`signal state ${index + 1}: signed out, but nothing on the panel says how to sign in`);
				}
				if (panel.querySelector(".dist__row")) sawDistributionWhileSignedOut = true;
			}
		}
		if (!sawDistributionWhileSignedOut) {
			issues.push(
				"signal states: no signed-out panel shows a rating distribution, so 'the numbers are public, the control is not' is never seen",
			);
		}
		return issues;
	});
}

/**
 * How much accent each page actually paints. **Measured, not gated.**
 *
 * `DESIGN.md` §2: *One accent. Ember marks action, selection and the single
 * highest-priority element on a viewport. It is never decorative.* That is a rule
 * about a count, and a rule about a count is exactly the kind of thing to put a
 * number next to.
 *
 * It is printed rather than enforced on purpose. "How many ember elements is too
 * many" is a judgement: the wall's active filter chip and its featured tile wash
 * are both legitimate, the drill-in's eyebrow plus one action is legitimate, and
 * four decorative taglines is not. A script that failed the run on a number a
 * designer disputes would be a script people pass `--audit-only` to avoid, which
 * is how a matrix stops being read.
 *
 * Only *always-on* paint is counted — computed colour, background or border on
 * the element itself, not a `:hover` rule, which is interaction and is what the
 * token is for. `--ember-line` and `--ember-dim` are excluded: they are the
 * accent at reduced weight for borders and fills, and every focus ring on the
 * site is one.
 */
async function auditAccent(page) {
	return page.evaluate(() => {
		const root = getComputedStyle(document.documentElement);
		const ember = (root.getPropertyValue("--ember") ?? "").trim();
		const toRgba = (value) => {
			const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
			if (hex) {
				const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
				const n = Number.parseInt(h, 16);
				return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
			}
			const m = value.match(/rgba?\(([^)]+)\)/);
			if (!m) return null;
			const parts = m[1].split(/[,/]/).map((n) => Number.parseFloat(n.trim()));
			if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
			return [parts[0], parts[1], parts[2], parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1];
		};
		const accent = toRgba(ember);
		if (!accent) return { count: 0, names: [], note: `--ember is "${ember}" and was not compared` };
		const same = (value) => {
			const c = toRgba(value);
			// **Alpha matters.** `--ember-wash` is `rgb(255 90 31 / 0.12)` — the same
			// three numbers as the accent — and it is a background tint behind text,
			// not an accent block. Counting it would put every search hit's `<mark>`
			// and every focus wash into the total and make the number meaningless.
			return Boolean(c) && c[3] === 1 && c[0] === accent[0] && c[1] === accent[1] && c[2] === accent[2];
		};

		const describe = (el) =>
			`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/)[0]}` : ""}`;

		const names = [];
		for (const el of document.querySelectorAll("body *")) {
			if (el.closest(".visually-hidden")) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 1 || r.height < 1) continue;
			if (Number.parseFloat(getComputedStyle(el).opacity) === 0) continue;
			const cs = getComputedStyle(el);
			const hit =
				same(cs.color) ||
				same(cs.backgroundColor) ||
				(same(cs.borderTopColor) && Number.parseFloat(cs.borderTopWidth) >= 2);
			if (hit) names.push(describe(el));
		}
		return { count: names.length, names: names.slice(0, 8), note: null };
	});
}

/**
 * `prefers-reduced-motion` has to collapse every transition and every smooth
 * scroll (DESIGN.md §7). The stylesheet says it does; this reads the computed
 * value back, because "the rule is in the CSS" is not the same claim as "nothing
 * moves on a reader who asked for nothing to move".
 */
async function auditReducedMotion(browser) {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		reducedMotion: "reduce",
		locale: "en-GB",
		timezoneId: "UTC",
		colorScheme: "dark",
	});
	const page = await context.newPage();
	try {
		await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 30000 });
		// `return await`, not a bare `return promise`: with a `finally` present
		// the close would run before the evaluate settled.
		return await page.evaluate(() => {
			const issues = [];
			const moving = [];
			for (const el of document.querySelectorAll(
				"a,button,.tile,.tile__plate,.tile__plate img,.chip,.masthead,.nav__link,.rate__star",
			)) {
				const cs = getComputedStyle(el);
				const duration = cs.transitionDuration.split(",").map((d) => Number.parseFloat(d));
				const animating = duration.some((d) => d > 0.02);
				if (animating) moving.push(`${el.tagName.toLowerCase()}.${String(el.className || "").split(" ")[0]} ${cs.transitionDuration}`);
			}
			if (moving.length) {
				issues.push(
					`reduced motion: ${moving.length} element(s) still transition — ${moving.slice(0, 3).join(", ")}`,
				);
			}
			if (getComputedStyle(document.documentElement).scrollBehavior !== "auto") {
				issues.push("reduced motion: html scroll-behavior is not auto");
			}
			return issues;
		});
	} finally {
		await context.close();
	}
}

/**
 * EmDash-managed content has to be what the public pages actually serve (#38).
 *
 * The catalogue JSON and the public HTML come from the same loaders, so this
 * ought to be impossible to fail — which is exactly why it is worth asserting.
 * "The CMS is reachable" and "the public site reflects the CMS" are different
 * claims, and a caching bug, a stale build or a read path that silently falls
 * back to a seed would break the second while leaving every other check green.
 */
async function auditCmsReflection() {
	const issues = [];
	let checked = 0;
	try {
		const response = await fetch(`${baseUrl}/api/catalogue.json`);
		if (!response.ok) return [`CMS reflection: /api/catalogue.json answered ${response.status}`];
		const catalogue = await response.json();
		const possibilities = Array.isArray(catalogue.possibilities) ? catalogue.possibilities : [];
		if (!possibilities.length) return ["CMS reflection: the catalogue JSON carries no possibilities"];
		for (const entry of possibilities.slice(0, 5)) {
			// The JSON keys the *stable id* as `id`, which is the URL slug; there is
			// no `slug` key. Reading the wrong one produced `/possibilities/undefined`
			// for every entry on the first run, which is exactly the sort of check
			// that looks broken rather than wrong.
			const slug = entry.slug ?? entry.id;
			const page = await fetch(`${baseUrl}/possibilities/${slug}`);
			if (!page.ok) {
				issues.push(`CMS reflection: /possibilities/${slug} answered ${page.status} but the CMS lists it`);
				continue;
			}
			const html = await page.text();
			const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
			const headingText = heading ? decodeEntities(heading[1].replace(/<[^>]*>/g, " ")) : null;
			if (!headingText || headingText.trim() !== String(entry.title).trim()) {
				issues.push(
					`CMS reflection: /possibilities/${slug} shows h1 ${JSON.stringify(headingText?.trim() ?? null)}, CMS says ${JSON.stringify(entry.title)}`,
				);
				continue;
			}
			// The rights word has to reach the page too: it is the claim the whole
			// product rests on, and a CMS change that stopped rendering it would
			// otherwise only be caught by somebody reading the page.
			if (entry.rightsStatus && !html.includes(entry.rightsStatus)) {
				issues.push(
					`CMS reflection: /possibilities/${slug} does not mention its rights status "${entry.rightsStatus}"`,
				);
			}
			checked++;
		}
	} catch (err) {
		return [`CMS reflection: ${String(err).split("\n")[0].slice(0, 120)}`];
	}
	if (checked === 0 && !issues.length) issues.push("CMS reflection: nothing was compared");
	return issues;
}

/** The handful of entities a CMS title can realistically contain. */
function decodeEntities(value) {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&rsquo;|&lsquo;/g, "'")
		.replace(/&mdash;/g, "—")
		.replace(/&ndash;/g, "–")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/**
 * Touch targets: **gated**, with the WCAG inline exception.
 *
 * The rule: a control must be at least 44px in one dimension and at least 24px
 * in the other, which is `DESIGN.md` §7's 44px floor combined with WCAG 2.2
 * 2.5.8's 24px absolute minimum. One dimension is enough because the honest
 * measure of a target is its reachable area — a 42×48 "About" link has a 2016px²
 * hit box and nothing about it is hard to hit, while a 33×35 chip is 1155px²
 * and sits between two others.
 *
 * This was an advisory until #46 was fixed, and the advisory's own comment said
 * it would stop being one "the moment the numbers clear". They do: what it found
 * was the masthead nav at 37px, the filter chips at 33px, the star radios at
 * 34px, the per-tile save control at 32px, the use-page controls at 36px and the
 * footer links at 32px — a wall of controls between 24px and 44px on every page.
 *
 * **The inline exception.** A link inside a sentence is exempt, exactly as
 * WCAG 2.5.8 exempts it: padding a link in body copy to 44px would wreck the
 * line box, and the spacing between lines provides the separation the rule is
 * protecting. An exemption has to be narrow or it swallows the whole check, so it
 * requires the link's parent to carry text of its own — "How rights are
 * classified" inside a paragraph passes, a link alone in its own `<li>` does not.
 */
async function tapAdvisory(page) {
	return page.evaluate(() => {
		const counts = new Map();
		for (const el of document.querySelectorAll("a,button,input,select,textarea,summary")) {
			const cs = getComputedStyle(el);
			if (cs.display === "none" || cs.visibility === "hidden") continue;
			if (el.type === "hidden" || el.closest(".visually-hidden")) continue;
			if (el.tagName !== "SUMMARY" && el.closest("details:not([open])")) continue;

			// A radio or checkbox is measured by its label. `.rate__star` covers
			// its input with an absolutely positioned 100%-wide, 100%-tall
			// box, so the input's own rect is the *padding box* of the label —
			// 42px for a 44px label, because of the 1px border. Measuring the label
			// is what the finger actually hits.
			let target = el;
			if (el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox")) {
				target = el.closest("label") ?? el;
			}

			// The inline exception, above.
			if (target.tagName === "A" && target.parentElement) {
				const parent = target.parentElement;
				const ownText = [...parent.childNodes]
					.filter((node) => node.nodeType === 3)
					.map((node) => node.textContent?.trim() ?? "")
					.join("");
				if (ownText) continue;
			}

			const r = target.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			const short = Math.min(r.width, r.height);
			const long = Math.max(r.width, r.height);
			if (long >= 44 && short >= 24) continue;
			const key = `${target.tagName.toLowerCase()}.${String(target.className || "").split(" ")[0] || "-"}`;
			const found = counts.get(key) ?? {
				w: Math.round(r.width),
				h: Math.round(r.height),
				n: 0,
				label: (target.getAttribute("aria-label") || target.textContent || "").trim().slice(0, 24),
			};
			found.n++;
			counts.set(key, found);
		}
		return [...counts.entries()].map(([key, v]) => ({ key, ...v }));
	});
}

/**
 * A sticky element must fit in the viewport that is stuck to.
 *
 * `position: sticky` with no height condition is a trap: the element parks its
 * top edge at its `top` offset and stays there, so if it is taller than the
 * viewport its own bottom is *permanently* off screen. No scroll position shows
 * all of it, which means the bug is invisible to a full-page screenshot, to the
 * overflow check (the page does not scroll sideways) and to the eye on a tall
 * monitor.
 *
 * This is the check that would have caught the drill-in on a phone held
 * sideways: the plate is `4:5`, sticky from 860px up, and at 932×430 it measured
 * 491px tall in a 430px viewport — 133px of a specimen diagram that no amount of
 * scrolling could reach.
 *
 * It runs on every viewport rather than on a scrolled frame, because the
 * condition is about the element's height against the viewport and does not need
 * the scroll to have happened.
 */
async function auditStickyFits(browser, viewport, route) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		deviceScaleFactor: 1,
		locale: "en-GB",
		timezoneId: "UTC",
		colorScheme: "dark",
		...(viewport.touch || viewport.width < 500 ? { hasTouch: true, isMobile: true } : {}),
	});
	const page = await context.newPage();
	try {
		await page.goto(`${baseUrl}${route.path}`, { waitUntil: "networkidle", timeout: 30000 });
		return await page.evaluate(() => {
			const issues = [];
			for (const el of document.querySelectorAll("body *")) {
				if (getComputedStyle(el).position !== "sticky") continue;
				const r = el.getBoundingClientRect();
				if (r.height === 0) continue;
				const overflow = Math.round(r.height - innerHeight);
				if (overflow <= 1) continue;
				issues.push(
					`sticky ${(el.className || "").toString().split(" ")[0] || el.tagName.toLowerCase()} is ${Math.round(r.height)}px tall in a ${innerHeight}px viewport — ${overflow}px of it can never be scrolled into view`,
				);
				if (issues.length > 3) break;
			}
			return issues;
		});
	} finally {
		await context.close();
	}
}

/**
 * No moving or sounding media without a reader's say-so (#46).
 *
 * There is no video or audio on the public catalogue today, which is a decision
 * rather than an accident: a media catalogue that autoplays is hostile to browse
 * and costs bytes on a phone for nothing. The check exists because that is
 * exactly the kind of decision that gets made later by accident, inside a
 * component, without anybody deciding it.
 */
async function auditAutoplay(page) {
	return page.evaluate(() => {
		const issues = [];
		const sounding = [...document.querySelectorAll("video,audio")].filter((el) => !el.paused && !el.ended);
		if (sounding.length) {
			issues.push(`${sounding.length} media element(s) are playing without being asked to`);
		}
		const flagged = [...document.querySelectorAll("[autoplay]")];
		if (flagged.length) {
			issues.push(`${flagged.length} element(s) carry autoplay: ${flagged.map((el) => el.tagName.toLowerCase()).join(", ")}`);
		}
		return issues;
	});
}

/**
 * Proves the new detectors fire.
 *
 * A check that has never failed is indistinguishable from a check that cannot
 * fail, and this repository has two live examples of that mistake: the tap-target
 * gate at 24px could not see a 32px control, and `documentElement.scrollWidth`
 * cannot see content clipped inside a scroll container. So every detector added
 * in this pass is exercised against a deliberately broken page first, and the run
 * **fails** if one of them stays quiet.
 *
 * It runs the real `pageAuditScript` and the real layout-shift routine — not a
 * reimplementation — so what is proved is the code that ships. The broken page is
 * a `data:` URL, so nothing in the repository or the CMS is involved and there is
 * nothing to clean up.
 */
const FLAT_SVG =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#08090a"/></svg>',
	);

const BROKEN_PAGE =
	"data:text/html," +
	encodeURIComponent(
		'<!doctype html>\n' +
			'<html lang="en"><head><meta charset="utf-8"><title>deliberately broken</title></head>\n' +
			"<body>\n" +
			"<h1>Every one of these is a defect on purpose</h1>\n" +
			"<p>Enough text to make the document look like a page.</p>\n" +
			// 1. Text clipped by an ancestor that cannot scroll. The document root
			//    does not overflow, so only a check that looks inside scroll
			//    containers finds this one.
			'<div style="width:120px;overflow:hidden;white-space:nowrap"><span>a very long run of text that cannot possibly fit inside one hundred and twenty pixels</span></div>\n' +
			// 2. An interactive element with no area at all. The tap-target check
			//    skips zero-size boxes, so only a dedicated check finds this.
			'<button style="display:block;width:0;height:0;padding:0;border:0"></button>\n' +
			// 3. Two ratio containers, the second with an explicit height that beats
			//    the ratio it declares.
			'<div style="width:400px;aspect-ratio:4 / 5;background:#333"></div>\n' +
			'<div style="width:400px;height:400px;aspect-ratio:4 / 5;background:#444"></div>\n' +
			// 4. A sticky pair painted over one another, for auditStickyOverlap.
			//    They sit at the top of the document with a tall spacer below,
			//    because sticky only pins once the viewport reaches the element.
			//    Placed at the end of a long page they never engaged and the check
			//    reported "no overlap" when the truth was "no test".
			'<div style="position:sticky;top:0;z-index:10;height:60px;background:#111">chrome</div>\n' +
			'<div style="position:sticky;top:20px;z-index:5;height:60px;background:#222">rail</div>\n' +
			'<div style="height:3000px"></div>\n' +
			// 5. An image that resolves and paints nothing, for auditBlankMedia.
			'<img src="' +
			FLAT_SVG +
			'" alt="a flat frame" width="800" height="1000">\n' +
			// 6. One id used twice, and a label pointing at an id that is not there.
			//    Both are invisible to the accessibility tree, which reports a label
			//    as present whether or not it points at the control it was written
			//    for, and to `querySelector`, which returns the first match happily.
			'<label for="q">The first field</label><input id="q" type="text">\n' +
			'<label for="q">The second field, same id</label><input id="q" type="text">\n' +
			'<label for="nowhere">A label with nothing to name</label>\n' +
			// 7. A status line whose joined parts are empty, so it opens with the
			//    separator. `/search` with no results rendered exactly this.
			'<p role="status"> · for zzqqxxwwnothing</p>\n' +
			// 8. A placeholder wider than the field it sits in. A placeholder is
			//    painted inside a control that scrolls, so the clipped-content check
			//    cannot see it and an empty input has no overflow at all.
			'<input type="search" placeholder="a placeholder far too long for this narrow field" style="width:120px;font:13px monospace">\n' +
			"</body></html>",
	);

/**
 * A page that really does switch to a light theme.
 *
 * `auditDarkOnly` compares the same page under `prefers-color-scheme: dark` and
 * `light` and requires the tokens to be identical. On this product that is a
 * pass, which is exactly the shape of a check that cannot fail: the natural
 * reading of "identical under both schemes" is a tautology when the site is
 * dark-only and nobody has ever added a light theme.
 *
 * So the comparison is pointed at this fixture first. If it does not report a
 * theme change here, the detector is not looking, and the run fails rather than
 * reporting a clean bill of health for a check that never looked.
 */
const THEMED_PAGE =
	"data:text/html," +
	encodeURIComponent(
		'<!doctype html>\n' +
			'<html lang="en"><head><meta charset="utf-8"><title>themed</title>\n' +
			"<style>\n" +
			"  :root { --canvas: #08090a; --ink: #f4f2ee; color-scheme: dark light; }\n" +
			"  @media (prefers-color-scheme: light) {\n" +
			"    :root { --canvas: #fbfaf7; --ink: #14161a; }\n" +
			"    html { color-scheme: light; }\n" +
			"  }\n" +
			"  body { background: var(--canvas); color: var(--ink); margin: 0; }\n" +
			"</style></head>\n" +
			"<body><h1>A second visual system</h1>\n" +
			'<button aria-label="Switch to light mode">Light</button>\n' +
			"</body></html>",
	);

/**
 * Layout shift with no reserved space: an image with no intrinsic size pushes
 * everything below it down when it arrives.
 */
const SHIFTING_PAGE =
	"data:text/html," +
	encodeURIComponent(
		'<!doctype html>\n' +
			'<html lang="en"><head><meta charset="utf-8"><title>shifts</title></head>\n' +
			"<body>\n" +
			"<h1>Media with no reserved geometry</h1>\n" +
			'<div style="height:600px;background:#101214"></div>\n' +
			'<p id="marker">below the media</p>\n' +
			'<img src="' +
			FLAT_SVG.replace("#08090a", "#4cc2f0") +
			'" style="width:100%;height:auto" alt="an image with no intrinsic size reserved">\n' +
			"</body></html>",
	);

async function auditSelfCheck(browser) {
	const issues = [];
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		locale: "en-GB",
		timezoneId: "UTC",
		colorScheme: "dark",
	});
	const page = await context.newPage();
	try {
		await page.goto(BROKEN_PAGE, { waitUntil: "networkidle" });
		/*
		 * The sticky pair only pins once the viewport reaches it, and the scroll
		 * has to actually happen — a `data:` document that refuses to scroll would
		 * make the sticky detector look broken rather than make it broken. Scrolled
		 * explicitly and the result read back, so a self-check failure means the
		 * detector failed and not that the fixture failed to set the stage.
		 *
		 * To the *bottom*, not to a fixed offset. `position: sticky` only pins once
		 * the viewport has reached the element, and this fixture puts a 2000px
		 * spacer above the sticky pair, so they sit at ~1530px in the document:
		 * `scrollTo(0, 1500)` lands 30px short, the pair never pinned, and the
		 * detector had nothing to find. That is how the self-check came to report
		 * the sticky detector as untrustworthy while every other detector on the
		 * same fixture passed — the fixture was at fault, not the detector.
		 */
		const scrolled = await page.evaluate(() => {
			scrollTo(0, document.documentElement.scrollHeight);
			return Math.round(window.scrollY);
		});
		if (scrolled < 200) {
			issues.push(
				`self-check: the deliberately broken page did not scroll (scrollY ${scrolled}), so the sticky detector could not be exercised`,
			);
		}
		await page.waitForTimeout(120);
		const found = await page.evaluate(pageAuditScript);
		/*
		 * `clippedPlaceholders` is a *returned measurement* rather than an issue, so
		 * it has to be folded in here explicitly. It was not, and the self-check said
		 * so: `self-check: the audit does not report a placeholder clipped by its own
		 * input`. Which is the self-check doing exactly what it is for — the detector
		 * had been demoted from a finding to a printed number, and nothing had told
		 * anyone it had stopped being able to fail.
		 */
		const all = [
			...found.issues,
			...(found.clippedPlaceholders ?? []).map((entry) => `placeholder clipped: ${entry}`),
			...(await auditStickyOverlap(page)),
			...(await auditBlankMedia(page)).issues,
		];
		const expect = [
			["clipped content:", "clipped content inside a non-scrolling box"],
			["collapsed control:", "an interactive element with no area"],
			["aspect-ratio:", "a ratio container rendering the wrong shape"],
			["sticky div", "one sticky element painted over another"],
			["blank media:", "an image that resolves and paints a flat frame"],
			["duplicated id(s):", "one id used by two elements"],
			["label(s) point at an id that does not exist", "a label naming a control that is not there"],
			["begin with a separator", "a status line that opens with a join it has nothing before"],
			["of it is cut", "a placeholder clipped by its own input"],
		];
		for (const [prefix, what] of expect) {
			if (!all.some((issue) => issue.includes(prefix))) {
				issues.push(
					`self-check: the audit does not report ${what} — this check would pass vacuously, so it is not trustworthy`,
				);
			}
		}
		if (found.ratioContainers < 1) {
			issues.push("self-check: the aspect-ratio check measured nothing on a page built to be measured");
		}
		const shift = await auditLayoutShift(browser, VIEWPORTS[3], null, SHIFTING_PAGE);
		if (!shift.length) {
			issues.push(
				"self-check: the layout-shift check reports no shift on a page whose image has no reserved geometry — it cannot detect what it claims to",
			);
		}
	} finally {
		await context.close();
	}

	/*
	 * The dark-only check, pointed at a page that *does* have a light theme.
	 *
	 * `auditDarkOnly` passes on a product that is dark only, and the reason it
	 * passes is that nothing has gone wrong. That is a check whose failure mode is
	 * silence, so the same comparison runs here against `THEMED_PAGE` first and
	 * has to report the difference. `auditDarkOnly` takes an optional URL for
	 * exactly this, so the code under test is the code that ships rather than a
	 * second implementation written to prove the first one works.
	 */
	const themed = await auditDarkOnly(browser, THEMED_PAGE);
	if (!themed.length) {
		issues.push(
			"self-check: the dark-only check reports no theme change on a page that has one — it cannot detect a light theme appearing, so its pass on this site means nothing",
		);
	}

	return issues;
}

/**
 * Verifies a non-HTML endpoint: correct status, expected content type, and a
 * body that parses. Screenshots and DOM assertions do not apply.
 */
async function auditNonHtml(route) {
	const issues = [];
	const res = await fetch(`${baseUrl}${route.path}`);
	if (res.status !== 200) issues.push(`HTTP ${res.status}`);
	const type = res.headers.get("content-type") ?? "";
	if (!type.includes("xml")) issues.push(`content-type is "${type}", expected xml`);
	const body = await res.text();

	if (route.path.endsWith(".xml")) {
		if (!body.startsWith("<?xml")) issues.push("missing XML declaration");
		// Balance check with a stack, so nesting is verified rather than just
		// counted. Counting alone reports mismatches on well-formed documents
		// with CDATA and attributes containing `>`; the stack does not.
		const stack = [];
		const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
		let m;
		while ((m = tagRe.exec(body)) !== null) {
			const [, closing, name, , selfClosing] = m;
			if (selfClosing === "/" || name.startsWith("?")) continue;
			if (closing === "/") {
				const open = stack.pop();
				if (open !== name) {
					issues.push(`closing </${name}> does not match open <${open ?? "nothing"}>`);
					if (issues.length > 3) break;
				}
			} else {
				stack.push(name);
			}
		}
		if (stack.length && issues.length <= 3) {
			issues.push(`unclosed: ${stack.join(", ")}`);
		}
		const items = (body.match(/<item>/g) ?? []).length;
		if (route.path === "/rss.xml" && items === 0) issues.push("feed contains no items");
	}
	return issues;
}

/**
 * Screenshot artefacts: a manifest, and a stated retention policy.
 *
 * #47's last acceptance criterion is that artefacts are "retained intentionally
 * or cleaned up; they do not become repository debris". Both halves of that need
 * to be *enforced*, because the alternative is the status quo: a gitignored
 * directory that nobody knows what is in it, and an ignore rule that quietly
 * stops matching.
 *
 * **Retention.** `screenshots/` is wiped at the start of every capture run and
 * never committed. It is a working set, not an archive: a run is reproducible
 * from the commit, the origin and the matrix, and the matrix is in this file. The
 * manifest is what makes a run *identifiable* without keeping it.
 *
 * **The manifest** records what produced the set — origin, commit, node, browser,
 * the routes and viewports and the assertions each one was checked against — plus
 * a size and digest per file. A reviewer handed a set of PNGs can then tell
 * whether it is the set this script claims to produce, and whether two runs of
 * the same commit produced the same pixels (compare the digests) or a different
 * one (they do not, and that is the interesting case).
 *
 * **`auditManifest` fails the run** when a capture is missing, when a file on
 * disk is not in the manifest, or when `screenshots/` is no longer ignored. A
 * manifest nothing checks is a note in a file, and a note in a file is how the
 * next person decides the artefacts are "obviously fine".
 */
function writeManifest(captures) {
	const git = (args) => {
		try {
			return execFileSync("git", args, { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" }).trim();
		} catch {
			return null;
		}
	};
	const files = captures.map((capture) => {
		const full = `${outDir}${capture.file}`;
		let bytes = null;
		let sha256 = null;
		try {
			bytes = readFileSync(full).length;
			sha256 = createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16);
		} catch {
			// Left null on purpose: a file the run claims to have written but cannot
			// read is a finding, and `auditManifest` reports it as one rather than
			// this quietly producing a manifest with holes in it.
		}
		return { ...capture, bytes, sha256 };
	});

	const manifest = {
		schema: "asset-hunter.visual-qa/1",
		generated: new Date().toISOString(),
		origin: baseUrl,
		local: isLocal,
		commit: git(["rev-parse", "HEAD"]),
		branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
		dirty: git(["status", "--porcelain"]) ? true : false,
		node: process.version,
		playwright: chromium.name(),
		viewports: VIEWPORTS,
		routes: AUDITED.map((r) => ({
			name: r.name,
			path: r.path,
			expect: r.expect ?? {},
			...(r.covers ? { covers: r.covers } : {}),
			...(r.cookie ? { cookie: Object.keys(r.cookie) } : {}),
			...(r.localOnly ? { localOnly: true } : {}),
		})),
		counts: { routes: AUDITED.length, viewports: VIEWPORTS.length, files: files.length },
		files,
		retention:
			"Wiped at the start of every capture run and never committed. Regenerate with `npm run check:visual`; share a run by its commit and this manifest, not by committing the PNGs.",
	};
	writeFileSync(`${outDir}manifest.json`, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

/** Everything about the artefact set that can be checked without a human. */
function auditManifest(manifest) {
	const issues = [];

	const missing = manifest.files.filter((f) => f.bytes === null);
	if (missing.length) {
		issues.push(
			`artefacts: ${missing.length} capture(s) are in the manifest but not on disk — ${missing
				.slice(0, 4)
				.map((f) => f.file)
				.join(", ")}`,
		);
	}

	// The expected set, derived from the matrix rather than from what happened.
	// This is what catches a route that threw halfway through and stopped writing
	// files while the run still reported a green count.
	//
	// `capture: false` is skipped *here* for the same reason it is skipped in the
	// screenshot call: the route is audited in full and photographed on purpose,
	// so demanding a PNG for it would be the manifest reporting the harness's own
	// decision as a lost artefact.
	const expected = [];
	for (const route of AUDITED) {
		if (route.nonHtml || route.capture === false) continue;
		for (const viewport of VIEWPORTS) {
			expected.push(`${route.name}--${viewport.name}.png`);
			if (route.scroll) expected.push(`${route.name}--${viewport.name}--scrolled.png`);
		}
	}
	expected.push("wall--iphone13.png");
	const have = new Set(manifest.files.map((f) => f.file));
	const absent = expected.filter((file) => !have.has(file));
	if (absent.length) {
		issues.push(
			`artefacts: ${absent.length} expected capture(s) were never written — ${absent.slice(0, 6).join(", ")}`,
		);
	}

	// Anything on disk the matrix does not name is debris from an earlier run or
	// from a route that has since been deleted, and either way it is a file
	// nobody can account for.
	const named = new Set([...expected, "manifest.json"]);
	const stray = readdirSync(outDir).filter((f) => !named.has(f));
	if (stray.length) {
		issues.push(
			`artefacts: ${stray.length} file(s) in screenshots/ that the matrix does not name — ${stray.slice(0, 6).join(", ")}. The directory is wiped per run, so these are from a route that has been removed and nobody looked.`,
		);
	}

	// The rule that keeps any of this out of the repository. A symlinked
	// `node_modules` does not match `node_modules/` either, which is how a
	// worktree's dependencies end up in `git add -A`; that is a separate one-line
	// fix, and this check is what would have noticed.
	const ignorePath = new URL("../.gitignore", import.meta.url).pathname;
	if (existsSync(ignorePath)) {
		const rules = readFileSync(ignorePath, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));
		const ignored = rules.some((rule) => rule === "screenshots/" || rule === "screenshots" || rule === "/screenshots/" || rule === "/screenshots");
		if (!ignored) {
			issues.push(
				"artefacts: screenshots/ is not in .gitignore, so a capture run would put ~200 PNGs into the working tree. Add the rule or stop committing them deliberately.",
			);
		}
	} else {
		issues.push("artefacts: no .gitignore found, so nothing stops screenshots/ being committed");
	}

	return issues;
}

/**
 * The coverage table, and the run's refusal to claim what it did not check.
 *
 * #47 asks for a named list of evidence. A list in an issue is a list somebody
 * has to keep true by hand, and it stops being true silently: a route is
 * renamed, or its `expect` is emptied, or a state is reachable only through a
 * fixture that stopped resolving — and the issue still says "captures all four
 * use states". So the run prints what carries each item and **fails** if an item
 * has nothing behind it, which makes the claim falsifiable instead of decorative.
 */
function auditCoverage() {
	const issues = [];
	const byName = new Map(ROUTES.map((r) => [r.name, r]));
	const lines = [];
	for (const entry of Object.values(COVERAGE)) {
		/*
		 * Three outcomes, and they are not the same thing:
		 *
		 * - the route is not in the matrix at all → the claim in the issue is
		 *   false, which is a **failure**;
		 * - the route is in the matrix, is development-only, and this is not a
		 *   development origin → covered on a laptop, not here: **reported**, and
		 *   expected;
		 * - the route is in the matrix and was visited → covered.
		 *
		 * Reporting the second as the first would fail every production audit for
		 * behaving correctly. Treating the second as the third would let a
		 * production run claim the coverage it does not have, which is the thing
		 * this table exists to prevent.
		 */
		const missing = entry.routes.filter((name) => !byName.has(name));
		const devOnlyHere = entry.routes.filter(
			(name) => byName.get(name)?.devOnly && !AUDITED.some((r) => r.name === name),
		);
		const present = entry.routes.filter(
			(name) => byName.has(name) && !devOnlyHere.includes(name),
		);
		if (missing.length) {
			issues.push(
				`coverage: "${entry.issue}" names route(s) ${missing.join(", ")} that the matrix does not contain — the claim in the issue is no longer true`,
			);
		}
		if (!present.length && !entry.extra) {
			issues.push(
				`coverage: "${entry.issue}" has no route and no check behind it on this origin`,
			);
		}
		lines.push({
			item: entry.issue,
			routes: present.length ? present.join(", ") : "—",
			also: entry.extra ?? null,
			devSkipped: devOnlyHere,
		});
	}
	return { issues, lines };
}

async function main() {
	if (!auditOnly && existsSync(outDir)) rmSync(outDir, { recursive: true });
	if (!auditOnly) mkdirSync(outDir, { recursive: true });
	/** Every file this run claims to have written. See `writeManifest`. */
	const captures = [];

	const browser = await chromium.launch();
	let captured = 0;

	for (const route of AUDITED) {
		// Non-HTML endpoints are verified as data, not screens.
		if (route.nonHtml) {
			const issues = await auditNonHtml(route);
			record("data", route, issues);
			continue;
		}
		for (const viewport of VIEWPORTS) {
			const context = await browser.newContext({
				viewport: { width: viewport.width, height: viewport.height },
				deviceScaleFactor: viewport.dsf,
				// Deterministic rendering: no locale or timezone drift.
				locale: "en-GB",
				timezoneId: "UTC",
				colorScheme: "dark",
				// A coarse pointer is a different contract, not just a different
				// size: `:hover` rules are inert there and the tap-target floor
				// applies. Landscape rows are phones held sideways, so they get it.
				...(viewport.touch || viewport.width < 500
					? { hasTouch: true, isMobile: true }
					: {}),
			});
			const page = await context.newPage();

			/*
			 * Seed the state a route cannot reach on its own.
			 *
			 * A shortlist is a cookie by design (`src/lib/board.ts`), so a route
			 * that means "the board with things on it" has to say so. Without this
			 * the matrix held one `/board` — the empty one — and the compare grid,
			 * the per-entry disclosure, the export block and the clear form had
			 * never been rendered at any viewport, which is how #65 could describe
			 * the empty board in detail while the loaded one went unlooked-at.
			 */
			if (route.cookie) {
				await context.addCookies(
					Object.entries(route.cookie).map(([name, value]) => ({
						name,
						value,
						url: baseUrl,
					})),
				);
			}

			/*
			 * Enlarged text, at full width.
			 *
			 * `Page.setFontSizes` raises the reader's *default* font size, which is
			 * what "Zoom text only" does in Firefox and what a minimum-font-size
			 * setting does in Chromium. Every `rem` on the site follows it, and the
			 * `clamp()` fluid scale follows it too, so this is the real thing
			 * rather than a stylesheet override that happens to look similar.
			 *
			 * It is set before `goto` so the first paint is already the enlarged
			 * one: measuring afterwards would catch a wrong width but not a wrong
			 * first frame.
			 */
			if (viewport.textScale) {
				const cdp = await context.newCDPSession(page);
				await cdp
					.send("Page.setFontSizes", {
						fontSizes: { standard: Math.round(16 * viewport.textScale), fixed: Math.round(13 * viewport.textScale) },
					})
					.catch(() => warnings.push(`${viewport.name}: this Chromium refused Page.setFontSizes`));
			}
			const consoleErrors = [];
			page.on("console", (msg) => {
				if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 160));
			});
			page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message.slice(0, 160)}`));

			/*
			 * A subresource the *server* failed to deliver, kept apart from the
			 * page's own faults.
			 *
			 * These are the findings that mislead. A dev server that answers 500
			 * for a style module paints its own error overlay over the masthead, and
			 * the sticky-overlap check then reports, with complete confidence, that
			 * the masthead is 99px behind `vite-error-overlay` — seventeen times
			 * across the matrix, every one of them a statement about a development
			 * tool rather than about the product. The console error is a symptom of
			 * the same thing and reads as a page fault.
			 *
			 * So they are recorded as *server* failures with the URL attached. A
			 * reader can then tell "the layout is wrong" from "the thing serving it
			 * is broken", and the first of those is worth filing.
			 */
			const serverErrors = [];
			page.on("response", (res) => {
				if (res.status() < 500) return;
				if (res.request().resourceType() === "document") return;
				serverErrors.push(`${res.status()} ${res.url().replace(baseUrl, "")}`);
			});

			const response = await page.goto(`${baseUrl}${route.path}`, {
				waitUntil: "networkidle",
				timeout: 30000,
			});
			const status = response?.status() ?? 0;

			const issues = [];
			if (route.allow404) {
				if (status !== 404) issues.push(`expected 404, got ${status}`);
			} else if (status !== 200) {
				issues.push(`HTTP ${status}`);
			}

			/*
			 * A development tool has painted over the page.
			 *
			 * `astro dev` injects `<vite-error-overlay>` as a `position: fixed`
			 * full-viewport element when a module fails to load. It is a
			 * development tool, not the product, and it is *sticky*, so every
			 * sticky check on the page reports the overlay sitting on top of the
			 * masthead and the filter rail. Those reports are true and worthless,
			 * and a run that prints seventeen of them teaches people to skip the
			 * run.
			 *
			 * So when the overlay is present the page's own checks are **skipped**
			 * and the reason is the finding. The server error that caused it is
			 * reported on its own line, so the next step is obvious.
			 */
			const devOverlay = await page
				.evaluate(() => Boolean(document.querySelector("vite-error-overlay")))
				.catch(() => false);
			if (devOverlay) {
				record(viewport.name, route, [
					"a dev-server error overlay covered this page, so none of its layout checks ran",
				]);
				for (const err of [...new Set(serverErrors)].slice(0, 3)) {
					failures.push(`${viewport.name} ${route.name}: server ${err}`);
				}
				await context.close();
				continue;
			}

			// Expected content must be present for the page to count as working.
			//
			// `0` is an assertion of **absence**, not a minimum nothing can fail: a
			// populated board that also renders `.empty__title` is the two-headline
			// problem in #65 appearing in a state nobody had looked at, and a
			// reference-only use page that grew a `.use__control--primary` is a
			// download appearing for material nobody has cleared — the one thing
			// `DESIGN.md` §9.6 exists to prevent. A minimum would pass both.
			for (const [selector, min] of Object.entries(route.expect ?? {})) {
				const found = await page.locator(selector).count();
				if (min === 0) {
					if (found > 0) issues.push(`${selector}: ${found} present, expected absent`);
				} else if (found < min) {
					issues.push(`${selector}: ${found} < ${min} expected`);
				}
			}

			// The fold check. `document` top is the honest measure because the
			// page has not been scrolled — screenshotting a full-page capture
			// would hide exactly the problem this catches.
			if (route.fold) {
				const plateTop = await page.evaluate((selector) => {
					const el = document.querySelector(selector);
					if (!el) return null;
					return Math.round(el.getBoundingClientRect().top);
				}, route.fold);
				const viewportHeight = page.viewportSize()?.height ?? 0;

				/*
				 * At 200% text the gate is measured rather than enforced, and the
				 * reason is worth stating rather than hiding: `DESIGN.md` §5b sets
				 * the fold rule for the composition at its designed type size, and
				 * WCAG 1.4.10 asks for reflow at 400% *zoom* (a 320px viewport,
				 * which `mobile-360` covers) rather than at enlarged text on a
				 * 1280px viewport. At twice the type the headline alone is 164px and
				 * the catalogue legitimately starts below the fold, so gating it
				 * would be failing a rule the design authority never wrote. It is
				 * still measured and printed — the number is what a later change to
				 * the intro would be argued about with.
				 *
				 * The same reasoning covers a viewport too short to hold a 4:5 plate.
				 * `landscape-844` and `landscape-932` are a phone on its side: 390px and
				 * 430px of height, where the plate is 800px tall and the sticky rule
				 * above 46rem deliberately does not apply. No arrangement of a header
				 * puts a 640px plate inside a 390px window, so gating those two would be
				 * gating a fact about the viewport rather than about the composition —
				 * and the two numbers are printed, because "the first screen here is the
				 * header" is worth seeing rather than hiding.
				 */
				if (viewport.textScale || viewportHeight < MIN_GATE_HEIGHT) {
					if (plateTop === null) {
						issues.push(`fold: ${route.fold} not found`);
					} else {
						measuredFolds.push({
							route: route.name,
							viewport: viewport.name,
							selector: route.fold,
							top: plateTop,
							percent: Math.round((plateTop / viewportHeight) * 100),
						});
					}
				} else if (plateTop === null) {
					issues.push(`fold: ${route.fold} not found`);
				} else {
					// A sliver of plate counts: the rule is "the media starts
					// here", not "a whole tile is visible".
					if (plateTop > viewportHeight * 0.75) {
						issues.push(
							`first plate starts ${plateTop}px down, past 75% of the ${viewportHeight}px fold`,
						);
					}
					if (plateTop < 0) {
						issues.push(`first plate starts ${plateTop}px from the top (content is hidden under the masthead)`);
					}
					// Reported on every route so the drill-in's number is visible
					// next to the wall's. See the "measured, not gated" note below.
					folds.push({
						route: route.name,
						viewport: viewport.name,
						top: plateTop,
						percent: Math.round((plateTop / viewportHeight) * 100),
					});
				}
			}

			// The plate crop check. Specimen plates are 4:5 diagrams whose meaning
			// is often in an annotation near an edge, so a tile that renders at a
			// different shape from the plate is cutting content off, not framing
			// it. This is the assertion that catches a "wider hero" change.
			if (route.plateAspect) {
				const ratio = await page.evaluate((selector) => {
					const el = document.querySelector(selector);
					if (!el) return null;
					const r = el.getBoundingClientRect();
					return r.height > 0 ? r.width / r.height : null;
				}, route.plateAspect);
				if (ratio === null) {
					issues.push(`plate crop: ${route.plateAspect} not found`);
				} else if (Math.abs(ratio - 0.8) > 0.02) {
					issues.push(
						`plate crop: ${route.plateAspect} renders at ${ratio.toFixed(2)}:1, not the plate's 0.80:1 — content is being cropped`,
					);
				}
			}

			/*
			 * The plate size gate (#64).
			 *
			 * The crop check above is about a plate's *shape*; this is about its
			 * *size*, and it exists because a 4:5 specimen plate has its content in
			 * its own type. The plates are authored at 800×1000 with mono
			 * annotations from 13px, so a plate rendered at `w` pixels puts those
			 * annotations at `13 × w / 800`. `DESIGN.md` §6 states the annotations are
			 * the plate's content — the real constraint values are written on the face
			 * — and §9.6 says the use page's plate has to be big enough to read the
			 * technique it shows. The threshold is the design authority's number
			 * (560px, 0.7 of the authored width, 9.1px effective for a 13px
			 * annotation), not this script's, which is the only reason it can be
			 * asserted rather than merely reported.
			 *
			 * It applies from `fromWidth` upwards, because below that the plate is the
			 * full width of the shell — at 390px there is no arrangement that reaches
			 * 560px, and a gate that could never pass is not a gate. Every viewport is
			 * still measured and printed so the numbers that *are* below the threshold
			 * are visible next to the ones that are not.
			 */
			if (route.plateMin) {
				const width = await page.evaluate((selector) => {
					const el = document.querySelector(selector);
					return el ? Math.round(el.getBoundingClientRect().width) : null;
				}, route.plateMin.selector);
				// Measured once, at every viewport; gated only where the floor applies.
				const gated = viewport.width >= route.plateMin.fromWidth && !viewport.textScale;
				if (width === null) {
					issues.push(`plate size: ${route.plateMin.selector} not found`);
				} else if (gated && width < route.plateMin.px) {
					issues.push(
						`plate size: ${route.plateMin.selector} renders ${width}px wide, under the ${route.plateMin.px}px floor — a 13px plate annotation lands at ${((width / 800) * 13).toFixed(1)}px, which is not readable`,
					);
				}
				plateSizes.push({
					route: route.name,
					viewport: viewport.name,
					width,
					gated: gated && width !== null && width >= route.plateMin.px,
				});
			}

			/*
			 * The anchor check runs here, immediately before the capture.
			 *
			 * A `fullPage` screenshot scrolls and re-lays-out the document, and
			 * pressing Tab moves focus and can scroll again. Both were measured
			 * *after* the capture on the first run and both left the page at a
			 * scroll offset no reader ever arrives at — which produced a false
			 * positive for a masthead race that does not exist. "Where does the
			 * browser land you" has to be asked before the harness starts
			 * rearranging the furniture.
			 */
			if (route.anchor) {
				issues.push(...(await attempt(() => auditAnchor(page, route.anchor), page)));
			}

			// Screenshot before the keyboard probe: focusing the skip link leaves
			// it on screen, and every capture in the matrix would carry the same
			// artefact over the masthead.
			//
			// This is also before the scroll below, deliberately. A `fullPage`
			// capture of a scrolled document renders sticky chrome at its scrolled
			// offset — so capturing after the scroll silently removed the masthead
			// from every screenshot of every route that has one. The evidence is
			// worthless if the harness is what moved the thing it is photographing.
			if (!auditOnly && route.capture !== false) {
				/*
				 * An anchored route is captured at the viewport, not full-page.
				 *
				 * The point of `/lab#signals` is the signal states, and the lab is
				 * 14,490px tall at 1280. A `fullPage` capture of an anchored route is
				 * therefore a thumbnail of a header with the states too small to read —
				 * which is exactly the failure the anchored route was added to prevent,
				 * and it looked fine in the output because the file existed and the
				 * assertions passed. Found by opening the PNG, not by reading the code.
				 *
				 * A full-page capture also re-lays-out the document, so it does not show
				 * where the browser actually lands you. For a fragment link that is the
				 * only interesting thing about the picture.
				 */
				await page.screenshot({
					path: `${outDir}${route.name}--${viewport.name}.png`,
					/*
					 * Three reasons not to capture the whole document, each measured.
					 *
					 * - An **anchored** route exists to show a region. The lab is
					 *   14,490px tall; a full-page capture of `/lab#signals` is a
					 *   thumbnail of a header with the states too small to read, which
					 *   is the failure the anchored route was added to prevent.
					 * - At **200% text** the same thing happens without a fragment: the
					 *   drill-in is 11,922px tall and the capture came out 190px wide.
					 * - A full-page capture also re-lays-out the document, so it does
					 *   not show where the browser actually lands you — which is the only
					 *   interesting thing about a picture of a fragment link.
					 *
					 * Routes that need the whole page still get it, and the two routes
					 * with sticky chrome have their own second, scrolled frame.
					 */
					fullPage: viewport.width >= 768 && !route.anchor && !viewport.textScale,
				});
				// Recorded, not counted. `captured` was a number that could be
				// anything, and a run that wrote nine files and said it wrote nine
				// hundred was still a green run. The manifest is the answer: it names
				// every file with its size and digest, and `auditManifest` fails the
				// run when one of them is missing.
				captures.push({
					route: route.name,
					path: route.path,
					viewport: viewport.name,
					file: `${route.name}--${viewport.name}.png`,
					kind: "page",
					...(viewport.textScale ? { textScale: viewport.textScale } : {}),
				});
				captured++;
			}

			/*
			 * Sticky chrome, measured on a scrolled frame.
			 *
			 * 1. **A `fullPage` screenshot does not simulate sticky positioning.**
			 *    Chromium lays sticky and fixed elements out at their unscrolled
			 *    position, so a rail sliding under the masthead captured
			 *    perfectly and was broken in the browser. That is how the first
			 *    version of this check came to exist, and it is why the second
			 *    capture here is viewport-sized rather than full-page.
			 * 2. **The screenshot moves the page.** Capturing re-lays-out the
			 *    document and focusing the skip link scrolls to it, so measuring
			 *    before the capture reads a scroll offset the harness itself
			 *    produced.
			 */
			if (route.scroll) {
				await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), route.scroll);
				await page.waitForTimeout(150);
				issues.push(...(await attempt(() => auditStickyOverlap(page), page)));
				if (!auditOnly) {
					await page.screenshot({
						path: `${outDir}${route.name}--${viewport.name}--scrolled.png`,
					});
					captures.push({
						route: route.name,
						path: route.path,
						viewport: viewport.name,
						file: `${route.name}--${viewport.name}--scrolled.png`,
						kind: "scrolled",
					});
					captured++;
				}
				// Back to the top, so the `pageAuditScript` measurements that follow
				// see the document as it loads rather than as this check left it.
				await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
				await page.waitForTimeout(80);
			}

			// Keyboard reachability: focus must be able to enter the page from the
			// top. A page that autofocuses an input (the 404 finder) legitimately
			// starts focused, so only flag the case where focus goes nowhere.
			await page.keyboard.press("Tab");
			const focused = await page.evaluate(() => {
				const el = document.activeElement;
				if (!el || el === document.body) return null;
				return `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""}`;
			});
			if (!focused) {
				issues.push("Tab does not move focus into the page");
			}

			// A media-first route whose media is *measured* rather than gated. The
			// number is collected on an unscrolled frame, before anything scrolls.
			if (route.measureFold) {
				const measured = await page.evaluate((selector) => {
					const el = document.querySelector(selector);
					return el ? Math.round(el.getBoundingClientRect().top) : null;
				}, route.measureFold);
				if (measured !== null) {
					measuredFolds.push({
						route: route.name,
						viewport: viewport.name,
						selector: route.measureFold,
						top: measured,
						percent: Math.round((measured / (page.viewportSize()?.height || 1)) * 100),
					});
				}
			}

			/*
			 * A named, state-specific audit, run once rather than at every viewport.
			 *
			 * `auditSignalStates` compares the control states of the seven rating
			 * panels against the panel that describes them. It is a claim about
			 * behaviour, not geometry, so eleven identical readings per run would
			 * cost minutes and learn nothing new — the same reason layout shift and
			 * reduced motion run once. A counting `expect` cannot stand in for it:
			 * counting `.rate button` cannot tell an enabled button from a disabled
			 * one, and that difference *is* the signed-in/signed-out state.
			 */
			if (route.audit === "signals" && viewport === VIEWPORTS[0]) {
				issues.push(...(await attempt(() => auditSignalStates(page), page)));
			}

			// The audit script is serialised into the page, so report its own
			// failure rather than silently passing a route.
			try {
				const auditResult = await attempt(() => page.evaluate(pageAuditScript), page);
				issues.push(...auditResult.issues);
				// A route where the aspect-ratio check found nothing to measure has
				// not been checked, not passed. Saying so is the difference between
				// a green run and a green run that means nothing.
				if (auditResult.ratioContainers === 0 && route.media) {
					warnings.push(
						`${viewport.name} ${route.name}: a media route has no aspect-ratio containers, so the crop check had nothing to measure`,
					);
				}
				for (const found of auditResult.clippedPlaceholders ?? []) {
					placeholders.push(`${viewport.name} ${route.name}: ${found}`);
				}
			} catch (err) {
				issues.push(`audit failed: ${String(err).split("\n")[0].slice(0, 120)}`);
			}

			// Blank media. Only on routes whose imagery *is* the content: on a
			// page with no plates this would find nothing, and a check that
			// passes because it had nothing to look at is the failure mode this
			// whole issue exists to avoid.
			if (route.media) {
				const blank = await attempt(() => auditBlankMedia(page), page);
				issues.push(...blank.issues);
				// The observed minimum is printed below, so "no flat frames" is
				// backed by a number rather than by an absence.
				blankMedia.push({ viewport: viewport.name, route: route.name, ...blank });
			}

			// Nothing on the public catalogue plays by itself. Cheap, and it is
			// the difference between "there is no video" being true and being
			// assumed.
			issues.push(...(await attempt(() => auditAutoplay(page), page)));

			// The one-accent rule, counted. Once per route rather than per viewport,
			// because the count is a property of the page and re-measuring it eleven
			// times would learn the same thing eleven times. See `auditAccent` for why
			// this is printed and not gated.
			if (viewport === VIEWPORTS.find((v) => v.name === "laptop-1280")) {
				const accent = await attempt(() => auditAccent(page), page);
				if (accent && accent.note) {
					warnings.push(`${route.name}: accent count skipped — ${accent.note}`);
				} else if (accent) {
					accents.push({ route: route.name, ...accent });
				}
			}

			// Sticky chrome and the scrolled capture both ran above, before the
			// full-page screenshot rearranged the document.

			// The tap-target gate. Gated since #46 cleared the numbers; see
			// `tapAdvisory` for the rule and for the inline exception.
			const small = await attempt(() => tapAdvisory(page), page);
			if (small.length) {
				tapUnder44.set(`${route.name} @ ${viewport.name}`, small.length);
				for (const entry of small.slice(0, 2)) {
					tapExamples.set(entry.key, entry);
				}
				for (const entry of small) {
					issues.push(
						`touch target ${entry.w}x${entry.h} below the 44px floor: ${entry.key}${entry.label ? ` "${entry.label}"` : ""} (x${entry.n})`,
					);
				}
			}

			// A 404 page legitimately 404s on some subresources (e.g. a favicon
			// variant), so those are reported as warnings rather than failures.
			if (consoleErrors.length) {
				const message = `console: ${consoleErrors.slice(0, 2).join(" | ")}`;
				if (route.allow404 && /status of 404/.test(message)) {
					warnings.push(`${viewport.name} ${route.name}: ${message}`);
				} else {
					issues.push(message);
				}
			}

			// The server's own failures, kept out of the page's list. See the
			// `response` handler above for why they are worth separating.
			for (const err of [...new Set(serverErrors)].slice(0, 3)) {
				failures.push(`${viewport.name} ${route.name}: server ${err}`);
			}

			record(viewport.name, route, issues);
			await context.close();
		}
	}

	// Touch-target check on a real device profile, separate from the width matrix.
	if (!auditOnly) {
		const context = await browser.newContext({ ...devices["iPhone 13"] });
		const page = await context.newPage();
		await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
		await page.screenshot({ path: `${outDir}wall--iphone13.png`, fullPage: true });
		captures.push({
			route: "wall",
			path: "/",
			viewport: "iphone13",
			file: "wall--iphone13.png",
			kind: "device-profile",
		});
		await context.close();
		captured++;
	}

	/*
	 * Three one-off checks, each run once rather than per viewport.
	 *
	 * Layout shift needs its own network conditions (media held back), reduced
	 * motion needs its own emulation, and CMS reflection is not a page at all —
	 * it compares the machine catalogue against the served HTML. Running any of
	 * them five times would cost minutes and learn nothing new.
	 */
	const shiftViewport =
		VIEWPORTS.find((v) => v.name === "laptop-1280") ?? VIEWPORTS[0];
	const shiftRoute = AUDITED.find((r) => r.name === "wall");
	if (shiftRoute) {
		const shiftIssues = await auditLayoutShift(browser, shiftViewport, shiftRoute);
		if (shiftIssues.length) {
			for (const issue of shiftIssues) failures.push(`layout-shift ${issue}`);
		} else {
			console.log(
				`Layout shift — ${shiftRoute.path} @ ${shiftViewport.width}px: media held back, nothing moved`,
			);
		}
	}

	const motionIssues = await auditReducedMotion(browser);
	if (motionIssues.length) for (const issue of motionIssues) failures.push(issue);

	/*
	 * Dark only, asserted as an absence (#47's "light/dark if both are
	 * supported", and `DESIGN.md` §9.3's decision not to have a light one).
	 *
	 * Skipping this row would be the wrong answer twice over: the issue asks for
	 * light *and* dark only if both exist, and the honest reply to "only one is
	 * supported" is "here is the evidence that the other one is not there" — not
	 * silence. `auditDarkOnly` reads the same page under both colour schemes and
	 * fails if anything differs, if `color-scheme` is not `dark`, or if a theme
	 * control has appeared in the interface. Its self-check has already pointed it
	 * at a page that *does* have a light theme, so a pass here means it looked.
	 */
	const themeIssues = await auditDarkOnly(browser);
	if (themeIssues.length) {
		for (const issue of themeIssues) failures.push(issue);
	} else {
		console.log(
			`Light/dark — the wall renders identically under prefers-color-scheme: dark and light, color-scheme is dark, and there is no theme control: DESIGN.md §9.3 is dark only`,
		);
	}

	/*
	 * Sticky chrome has to fit the viewport it sticks to. Run once per viewport
	 * rather than per route×viewport: it needs its own context (it is a
	 * geometry question, not an audit of one page's contents), and the routes
	 * that have sticky chrome are known — the wall's filter rail and the
	 * drill-in's plate. Both are audited at every size in the matrix.
	 */
	const stickyRoutes = AUDITED.filter((r) => r.stickyFits && !r.nonHtml);
	for (const viewport of VIEWPORTS) {
		for (const route of stickyRoutes) {
			const issues = await auditStickyFits(browser, viewport, route);
			for (const issue of issues) failures.push(`${viewport.name} ${route.name}: ${issue}`);
		}
	}
	if (stickyRoutes.length) {
		console.log(
			`Sticky fits — ${stickyRoutes.map((r) => r.name).join(", ")} × ${VIEWPORTS.length} viewport(s): no sticky element taller than the viewport that sticks to it`,
		);
	}

	const cmsIssues = await auditCmsReflection();
	if (cmsIssues.length) for (const issue of cmsIssues) failures.push(issue);

	/*
	 * Last, and before the browser closes, because it needs one: every detector
	 * added for the sticky-overlap, blank-media, clipped-content, collapsed-
	 * control, aspect-ratio and layout-shift work is pointed at a page built to
	 * break it. A detector that stays quiet there is a check that cannot fail,
	 * and this run fails rather than reporting one.
	 */
	const selfIssues = await auditSelfCheck(browser);
	if (selfIssues.length) {
		for (const issue of selfIssues) failures.push(issue);
	} else {
		console.log(
			"Self-check — every detector added for #47 fired on a page built to break it",
		);
	}

	await browser.close();

	/*
	 * The artefact set, described and then checked.
	 *
	 * Written before the checks so a failing run still leaves a record of what it
	 * was looking at — a run that fails on the eleventh viewport is exactly the
	 * run somebody needs to know the origin of. `auditManifest` then fails the run
	 * on a missing capture, an unaccounted file, or `screenshots/` having stopped
	 * being ignored.
	 */
	let manifest = null;
	if (!auditOnly) {
		manifest = writeManifest(captures);
		for (const issue of auditManifest(manifest)) failures.push(issue);
	} else {
		// An audit-only run still has to answer the coverage question, because that
		// is about the matrix rather than about the captures.
		for (const issue of auditCoverage().issues) failures.push(issue);
	}
	if (!auditOnly) {
		for (const issue of auditCoverage().issues) failures.push(issue);
	}

	console.log(`\nVisual QA — ${AUDITED.length} routes × ${VIEWPORTS.length} viewports`);
	if (!auditOnly) {
		console.log(
			`Captured ${captured} screenshot(s) → screenshots/, described by screenshots/manifest.json (commit ${manifest?.commit?.slice(0, 7) ?? "unknown"}, ${manifest?.origin})`,
		);
		console.log(
			`Artefacts — wiped at the start of every run and never committed; regenerate rather than keeping them. Share a run by its commit and manifest.`,
		);
	}

	/*
	 * What the issue names, and what answered it.
	 *
	 * Printed on every run, including a failing one, because the alternative is a
	 * coverage claim that lives only in the issue text and goes stale the moment
	 * somebody renames a route. The dev-only rows are the ones a production audit
	 * covers less of, and that is stated rather than left to be discovered.
	 */
	const coverage = auditCoverage();
	console.log("\nCoverage — what the issue asked for, and what carried it:");
	for (const line of coverage.lines) {
		const also = line.also ? ` + ${line.also}` : "";
		console.log(`  ${line.item.padEnd(38)} ${line.routes}${also}`);
	}
	const devSkipped = coverage.lines.flatMap((line) => line.devSkipped);
	if (devSkipped.length) {
		console.log(
			`  (this is not a development origin, so ${devSkipped.length} development-only route(s) were skipped — ${[...new Set(devSkipped)].join(", ")}. They are refused in production by design, not failing; run them against a local dev server.)`,
		);
	}

	const byViewport = new Map();
	for (const entry of audit) {
		if (!byViewport.has(entry.viewport)) byViewport.set(entry.viewport, { routes: 0, issues: 0 });
		const v = byViewport.get(entry.viewport);
		v.routes++;
		v.issues += entry.issues.length;
	}
	for (const [name, v] of byViewport) {
		console.log(`  ${String(name).padEnd(14)} ${v.routes} route(s) · ${v.issues} issues`);
	}

	/*
	 * Measured, not gated.
	 *
	 * These are printed so a number that matters cannot quietly stop being
	 * looked at. None of them is a pass/fail, and that is a decision rather than
	 * an omission:
	 *
	 * - **Blank media** reports the lowest distinct-colour count any plate
	 *   produced. A real specimen plate lands in the dozens; a flat frame is 1.
	 * - **The fold** reports where the first plate or example starts on every
	 *   route. `DESIGN.md` §5b gates the wall and §9.6 gates the use page, both at
	 *   75% of the fold; the drill-in is still only measured, because §5b states no
	 *   rule for it and gating one would be inventing a threshold here. Two cases
	 *   are measured rather than gated on every route — 200% text, and a window
	 *   shorter than 46rem where a 4:5 plate cannot fit at all. The number is what
	 *   makes the observation in #25 arguable rather than anecdotal.
	 * - **Plate size** reports the rendered width of the use page's plate and the
	 *   effective size of the plate's own smallest annotation, on the viewports the
	 *   560px floor does not cover as well as the ones it does (#64).
	 * - **Touch targets under 44px** is printed alongside the gate so a run that
	 *   *does* fail says which controls and how far off they are, rather than
	 *   only that something is.
	 */
	if (blankMedia.length) {
		const least = Math.min(...blankMedia.map((b) => b.least));
		const sampled = blankMedia.reduce((sum, b) => sum + b.sampled, 0);
		const deferred = blankMedia.reduce((sum, b) => sum + (b.deferred ?? 0), 0);
		console.log(
			`Blank media — ${sampled} image(s) sampled, fewest distinct colours on any plate: ${least} (a flat frame scores 1)` +
				(deferred
					? `; ${deferred} image(s) below the fold were never requested (loading="lazy"), so that number is drawn from the first viewport only`
					: ""),
		);
	}
	if (folds.length) {
		const byRoute = new Map();
		for (const f of folds) {
			if (!byRoute.has(f.route)) byRoute.set(f.route, []);
			byRoute.get(f.route).push(`${f.viewport} ${f.percent}%`);
		}
		for (const [route, cells] of byRoute) {
			console.log(`Fold (gated at 75%) — ${route}: ${cells.join(", ")}`);
		}
	}
	if (measuredFolds.length) {
		const byRoute = new Map();
		for (const f of measuredFolds) {
			if (!byRoute.has(f.route)) byRoute.set(f.route, []);
			byRoute.get(f.route).push(`${f.viewport} ${f.top}px (${f.percent}%)`);
		}
		for (const [route, cells] of byRoute) {
			console.log(
				`Fold (measured, not gated — 200% text, or a window shorter than ${MIN_GATE_HEIGHT / 16}rem): ${route}: ${cells.join(", ")}`,
			);
		}
	}
	if (plateSizes.length) {
		/*
		 * The rendered plate width against the effective size of the plate's own
		 * smallest annotation (13px in an 800px-wide authored file). The floor is
		 * marked per cell because it only applies from `fromWidth` up — and printing
		 * the effective size rather than the pixel width is what makes a phone's
		 * 355px an honest number rather than a failure.
		 */
		const rule = ROUTES.find((r) => r.plateMin);
		console.log(
			`Plate size — ${rule.plateMin.px}px floor from ${rule.plateMin.fromWidth}px wide (a 13px plate annotation lands at ${((rule.plateMin.px / 800) * 13).toFixed(1)}px): ` +
				plateSizes
					.map(
						(p) =>
							`${p.viewport} ${p.width === null ? "missing" : `${p.width}px`} (${p.width === null ? "—" : `${((p.width / 800) * 13).toFixed(1)}px annotation`}${p.gated ? ", gated" : ""})`,
					)
					.join(", "),
		);
	}
	if (placeholders.length) {
		const byField = new Map();
		for (const entry of placeholders) {
			const field = entry.replace(/^\S+ \S+: /, "");
			byField.set(field, (byField.get(field) ?? 0) + 1);
		}
		console.log(
			`Placeholders wider than their field — ${byField.size} distinct field(s) across ${placeholders.length} page/viewport pair(s). Measured, not gated: when the field already has the whole line the remaining fix is the wording, which is DESIGN.md's to decide.`,
		);
		for (const [field, n] of [...byField.entries()].slice(0, 6)) {
			console.log(`  · ×${n}  ${field}`);
		}
	}
	if (accents.length) {
		const worst = [...accents].sort((x, y) => y.count - x.count);
		console.log(
			`Accent (DESIGN.md §2 allows one per viewport; measured, not gated) — ${
				worst.length
			} route(s) counted; most: ${worst
				.slice(0, 5)
				.map((a) => `${a.route} ${a.count}`)
				.join(", ")}${worst[0].names.length ? ` · e.g. ${worst[0].names.join(", ")}` : ""}`,
		);
	}
	if (tapUnder44.size) {
		const worst = [...tapUnder44.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4);
		console.log(
			`Touch targets below the 44px floor — ${[...tapUnder44.values()].reduce((a, b) => a + b, 0)} control(s) across ${tapUnder44.size} page/viewport pair(s); widest gap: ${worst
				.map(([where, n]) => `${where} (${n})`)
				.join(", ")}`,
		);
		for (const [key, entry] of [...tapExamples.entries()].slice(0, 6)) {
			console.log(`  · ${key} ${entry.w}×${entry.h} ×${entry.n}${entry.label ? ` "${entry.label}"` : ""}`);
		}
	}
	if (warnings.length) {
		console.log(`\n${warnings.length} warning(s):`);
		for (const w of warnings.slice(0, 10)) console.log(`  · ${w}`);
	}

	if (failures.length) {
		console.log(`\n✖ ${failures.length} issue(s):\n`);
		for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
		if (failures.length > 40) console.log(`  …and ${failures.length - 40} more`);
		process.exit(1);
	}
	console.log("\n✔ no layout, contrast, tap-target, image, sticky-overlap or console issues found");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
