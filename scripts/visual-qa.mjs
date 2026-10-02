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
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { chromium, devices } from "playwright";

const args = process.argv.slice(2);
const baseUrl = valueOf("--url") ?? "http://localhost:4321";
const auditOnly = args.includes("--audit-only");
const outDir = new URL("../screenshots/", import.meta.url).pathname;

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
 * Routes under audit. `expect` is the minimum number of elements that must be
 * present for the page to count as working — it is what distinguishes a real
 * render from an empty state or an error page. `fold` names the selector whose
 * top edge must land inside the first viewport: on a media-first catalogue, a
 * wall whose plates start below the fold is a layout bug even though every
 * other check passes.
 *
 * Three optional flags carry the checks that need more than a fresh page:
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
 *   the wall and none for the drill-in, and a script is not where a design
 *   authority gets invented.
 */
const ROUTES = [
	// `stickyFits` marks the two routes that hold sticky chrome — the wall's
	// filter rail and the drill-in's plate — so both are checked at every size in
	// the matrix rather than only where a screenshot happens to look right.
	{ path: "/", name: "wall", expect: { ".tile": 20 }, fold: ".tile__plate", plateAspect: ".tile--featured .tile__plate", media: true, scroll: 1400, stickyFits: true },
	{ path: "/?vertical=games", name: "wall-filtered", expect: { ".tile": 2 }, fold: ".tile__plate", media: true },
	{ path: "/possibilities/density-gradient", name: "detail", expect: { ".section__title": 3 }, media: true, scroll: 1200, stickyFits: true },
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
	// The rating and report interactions (#37). Audited on a scrolled frame
	// because that block is 2,000px down the drill-in and a `fullPage` capture
	// of the top of the page says nothing about it. `scroll` lands on it.
	{
		path: "/possibilities/density-gradient#signals",
		name: "detail-signals",
		expect: { ".rate__star": 5, ".rate button": 1, ".report__form select": 1, ".report__form button": 1 },
		anchor: "#signals",
	},
	// The asset-use flow (#42). Audited like a real route because "no download
	// appears unless the record permits one" is a visual property too: if a
	// control ever renders, this capture is the evidence of what changed.
	{ path: "/use/density-gradient", name: "asset-use", expect: { ".use": 1, ".summary__payload": 1 }, media: true },
	{ path: "/verticals", name: "verticals", expect: { ".row": 10 }, media: true },
	// An in-page anchor. `/verticals#games` and `/pages/licensing#statuses` are
	// linked from the masthead, the breadcrumbs and the footer, so a target that
	// lands under the sticky masthead is a link that looks broken.
	{ path: "/verticals#games", name: "verticals-anchor", expect: { ".row": 10 }, anchor: "#games" },
	{ path: "/collections", name: "collections", expect: { ".collection": 4 } },
	{ path: "/collections/seams", name: "collection", expect: { ".tile": 4 }, fold: ".tile__plate", media: true },
	{ path: "/pages/about", name: "page-about", expect: { ".prose p": 5 } },
	{ path: "/pages/licensing", name: "page-licensing", expect: { ".prose h2": 3 }, anchor: "#the-statuses" },
	// The lab (#45) is development-only but audited like a real route: a state
	// that exists only in a screenshot is a state nobody has checked. It 404s in
	// production by design, so it is skipped rather than reported there — a
	// matrix that fails because a deliberately-absent route is absent would train
	// people to ignore the matrix.
	...(baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")
		? [{ path: "/lab", name: "lab", expect: { ".case": 30, "#vocabulary": 1, ".signal-case": 7 }, media: true }]
		: []),
	{ path: "/board", name: "board", expect: { ".empty__title": 1 } },
	{ path: "/search?q=seam", name: "search", expect: { ".count": 1 }, media: true },
	{ path: "/nope-does-not-exist", name: "404", expect: {}, allow404: true },
	// Non-HTML: checked for content type and well-formedness, not pixels.
	{ path: "/rss.xml", name: "feed", expect: {}, nonHtml: true },
];

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

	return { issues, ratioContainers };
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
		if (!images.length) return { issues: ["blank media: no resolved image on a media route"], sampled: 0, least: 0 };
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
		return { issues, sampled, least: least === Number.POSITIVE_INFINITY ? 0 : least };
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
	const snapshot = () =>
		page.evaluate(() => ({
			positions: [...document.querySelectorAll("body *")].map((el) =>
				Math.round(el.getBoundingClientRect().top),
			),
			height: document.documentElement.scrollHeight,
			images: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length,
		}));
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
	} finally {
		await context.close();
	}
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
		const all = [...found.issues, ...(await auditStickyOverlap(page)), ...(await auditBlankMedia(page)).issues];
		const expect = [
			["clipped content:", "clipped content inside a non-scrolling box"],
			["collapsed control:", "an interactive element with no area"],
			["aspect-ratio:", "a ratio container rendering the wrong shape"],
			["sticky div", "one sticky element painted over another"],
			["blank media:", "an image that resolves and paints a flat frame"],
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

async function main() {
	if (!auditOnly && existsSync(outDir)) rmSync(outDir, { recursive: true });
	if (!auditOnly) mkdirSync(outDir, { recursive: true });

	const browser = await chromium.launch();
	let captured = 0;

	for (const route of ROUTES) {
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

			// Expected content must be present for the page to count as working.
			for (const [selector, min] of Object.entries(route.expect ?? {})) {
				const found = await page.locator(selector).count();
				if (found < min) issues.push(`${selector}: ${found} < ${min} expected`);
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
				 */
				if (viewport.textScale) {
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

			/*
			 * Sticky chrome, measured after a scroll.
			 *
			 * Two things force this to run here, before the capture and the Tab
			 * probe:
			 *
			 * 1. **A `fullPage` screenshot does not simulate sticky positioning.**
			 *    Chromium lays sticky and fixed elements out at their unscrolled
			 *    position, so a rail sliding under the masthead captured
			 *    perfectly and was broken in the browser. That is how the first
			 *    version of this check came to exist.
			 * 2. **The screenshot moves the page.** Capturing re-lays-out the
			 *    document and focusing the skip link scrolls to it, so measuring
			 *    afterwards reads a scroll offset the harness itself produced.
			 */
			if (route.scroll) {
				await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), route.scroll);
				await page.waitForTimeout(150);
				issues.push(...(await attempt(() => auditStickyOverlap(page), page)));
				if (!auditOnly) {
					await page.screenshot({
						path: `${outDir}${route.name}--${viewport.name}--scrolled.png`,
					});
					captured++;
				}
			}

			// Screenshot before the keyboard probe: focusing the skip link leaves
			// it on screen, and every capture in the matrix would carry the same
			// artefact over the masthead.
			if (!auditOnly) {
				await page.screenshot({
					path: `${outDir}${route.name}--${viewport.name}.png`,
					fullPage: viewport.width >= 768,
				});
				captured++;
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

			// The audit script is serialised into the page, so report its own
			// failure rather than silently passing a route.
			try {
				const auditResult = await attempt(() => page.evaluate(pageAuditScript), page);
				issues.push(...auditResult.issues);
				// A route where the aspect-ratio check found nothing to measure has
				// not been checked, not passed. Saying so is the difference between
				// a green run and a green run that means nothing.
				if (auditResult.ratioContainers === 0) {
					warnings.push(
						`${viewport.name} ${route.name}: no aspect-ratio containers on this page, so the crop check had nothing to measure`,
					);
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
	const shiftRoute = ROUTES.find((r) => r.name === "wall");
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
	 * Sticky chrome has to fit the viewport it sticks to. Run once per viewport
	 * rather than per route×viewport: it needs its own context (it is a
	 * geometry question, not an audit of one page's contents), and the routes
	 * that have sticky chrome are known — the wall's filter rail and the
	 * drill-in's plate. Both are audited at every size in the matrix.
	 */
	const stickyRoutes = ROUTES.filter((r) => r.stickyFits && !r.nonHtml);
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

	console.log(`\nVisual QA — ${ROUTES.length} routes × ${VIEWPORTS.length} viewports`);
	if (!auditOnly) console.log(`Captured ${captured} screenshots → screenshots/`);

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
	 *   route, including the drill-in. `DESIGN.md` §5b sets a rule for the wall
	 *   (gated above at 75% of the fold) and states none for the drill-in, so
	 *   gating one would be inventing a threshold. The number is what makes the
	 *   observation in #25 arguable rather than anecdotal.
	 * - **Touch targets under 44px** is printed alongside the gate so a run that
	 *   *does* fail says which controls and how far off they are, rather than
	 *   only that something is.
	 */
	if (blankMedia.length) {
		const least = Math.min(...blankMedia.map((b) => b.least));
		const sampled = blankMedia.reduce((sum, b) => sum + b.sampled, 0);
		console.log(
			`Blank media — ${sampled} image(s) sampled, fewest distinct colours on any plate: ${least} (a flat frame scores 1)`,
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
		console.log(
			`Fold (measured, not gated — no threshold exists for these yet): ${
				measuredFolds.map((f) => `${f.route}/${f.viewport} ${f.top}px (${f.percent}%)`).join(", ")
			}`,
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
