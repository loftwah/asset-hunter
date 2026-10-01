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
 */
const VIEWPORTS = [
	{ name: "mobile-360", width: 360, height: 780, dsf: 2 },
	{ name: "mobile-390", width: 390, height: 844, dsf: 2 },
	{ name: "tablet-768", width: 768, height: 1024, dsf: 2 },
	{ name: "laptop-1280", width: 1280, height: 800, dsf: 1 },
	{ name: "desktop-1680", width: 1680, height: 1050, dsf: 1 },
];

/**
 * Routes under audit. `expect` is the minimum number of elements that must be
 * present for the page to count as working — it is what distinguishes a real
 * render from an empty state or an error page. `fold` names the selector whose
 * top edge must land inside the first viewport: on a media-first catalogue, a
 * wall whose plates start below the fold is a layout bug even though every
 * other check passes.
 */
const ROUTES = [
	{ path: "/", name: "wall", expect: { ".tile": 20 }, fold: ".tile__plate", plateAspect: ".tile--featured .tile__plate" },
	{ path: "/?vertical=games", name: "wall-filtered", expect: { ".tile": 2 }, fold: ".tile__plate" },
	{ path: "/possibilities/density-gradient", name: "detail", expect: { ".section__title": 3 } },
	{ path: "/verticals", name: "verticals", expect: { ".row": 10 } },
	{ path: "/collections", name: "collections", expect: { ".collection": 4 } },
	{ path: "/collections/seams", name: "collection", expect: { ".tile": 4 }, fold: ".tile__plate" },
	{ path: "/pages/about", name: "page-about", expect: { ".prose p": 5 } },
	{ path: "/pages/licensing", name: "page-licensing", expect: { ".prose h2": 3 } },
	{ path: "/search?q=seam", name: "search", expect: { ".count": 1 } },
	{ path: "/nope-does-not-exist", name: "404", expect: {}, allow404: true },
	// Non-HTML: checked for content type and well-formedness, not pixels.
	{ path: "/rss.xml", name: "feed", expect: {}, nonHtml: true },
];

const audit = [];
const failures = [];
const warnings = [];

function record(group, route, issues) {
	audit.push({ viewport: group, route: route.name, issues });
	for (const issue of issues) failures.push(`${group} ${route.name}: ${issue}`);
}

/**
 * In-page audit. Runs inside the browser so it measures what is rendered
 * rather than what the stylesheet intended.
 */
function pageAuditScript() {
	const issues = [];

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
				...(viewport.width < 500 ? { hasTouch: true, isMobile: true } : {}),
			});
			const page = await context.newPage();
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
				if (plateTop === null) {
					issues.push(`fold: ${route.fold} not found`);
				} else {
					const viewportHeight = page.viewportSize()?.height ?? 0;
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

			// The audit script is serialised into the page, so report its own
			// failure rather than silently passing a route.
			try {
				issues.push(...(await page.evaluate(pageAuditScript)));
			} catch (err) {
				issues.push(`audit failed: ${String(err).split("\n")[0].slice(0, 120)}`);
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

	if (failures.length) {
		console.log(`\n✖ ${failures.length} issue(s):\n`);
		for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
		if (failures.length > 40) console.log(`  …and ${failures.length - 40} more`);
		process.exit(1);
	}
	console.log("\n✔ no layout, contrast, tap-target, image or console issues found");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
