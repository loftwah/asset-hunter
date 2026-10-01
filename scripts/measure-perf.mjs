#!/usr/bin/env node
/**
 * Performance measurement for the visual wall (#49).
 *
 * The point is not to hit a number someone invented in an article. It is to
 * *measure this implementation* — desktop and mobile separately, on the routes
 * that matter — and then write the numbers into a budget file so a regression is
 * a diff rather than an opinion.
 *
 * What is measured, and why each one can go wrong here:
 *
 * - **Transfer weight per route.** A media-first catalogue that ships every
 *   plate up front is the failure this product is most able to produce.
 * - **When the media starts.** `loading="lazy"` on everything means the wall
 *   above the fold renders instantly; `loading="lazy"` on the *lead* plate means
 *   the largest thing on the page is the slowest thing on the page.
 * - **Layout shift.** Plates reserve their space by aspect ratio, so CLS should
 *   be near zero. Anything else is a real jump.
 * - **Interaction latency** for the search shortcut and the filter rail, which
 *   are the two things a reader does within a minute of arriving.
 * - **Request counts and image dimensions**, because a wall of 4:5 plates at
 *   800x1000 is 24 requests at full size before anything is lazy.
 *
 * Usage:
 *   node scripts/measure-perf.mjs                     # measure and print
 *   node scripts/measure-perf.mjs --write             # measure and update budgets
 *   node scripts/measure-perf.mjs --budgets-only      # compare only, no measuring
 *   node scripts/measure-perf.mjs --url http://…      # a different origin
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const value = (f, fallback) => {
	const i = args.indexOf(f);
	return i === -1 ? fallback : args[i + 1];
};

const baseUrl = value("--url", "http://localhost:4321");
const budgetsPath = new URL("../docs/performance-budgets.json", import.meta.url).pathname;

/**
 * The routes that matter, and why.
 *
 * The wall first because it is the product. Then a drill-in, because it is the
 * heaviest page per byte of *content*. The lab is a scale fixture: it is the only
 * route that renders every state at once, so it is the closest thing here to a
 * worst case.
 */
const ROUTES = [
	{ path: "/", name: "wall" },
	{ path: "/possibilities/density-gradient", name: "detail" },
	{ path: "/search?q=seam", name: "search" },
	{ path: "/board", name: "board" },
	{ path: "/verticals", name: "verticals" },
];

/**
 * Profiles. Mobile is measured separately because the media-first decision and
 * the lazy-loading strategy have completely different trade-offs at 390px on a
 * slow link, and one combined number hides exactly that.
 */
const PROFILES = [
	{
		name: "mobile-390",
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
	},
	{
		name: "desktop-1280",
		viewport: { width: 1280, height: 800 },
		deviceScaleFactor: 1,
	},
];

// A budget is a ceiling on a measurement. Anything above it is a regression to
// investigate, not a number to negotiate.
const DEFAULT_BUDGETS = {
	"mobile-390": {
		"wall": { bytes: 900_000, requests: 20, domNodes: 2500, cls: 0.02, loadMs: 4500 },
		"detail": { bytes: 500_000, requests: 10, domNodes: 1200, cls: 0.02, loadMs: 4000 },
		"search": { bytes: 700_000, requests: 18, domNodes: 1800, cls: 0.02, loadMs: 4000 },
		"board": { bytes: 400_000, requests: 8, domNodes: 900, cls: 0.02, loadMs: 3500 },
		"verticals": { bytes: 900_000, requests: 24, domNodes: 2600, cls: 0.02, loadMs: 4500 },
	},
	"desktop-1280": {
		"wall": { bytes: 1_600_000, requests: 30, domNodes: 2500, cls: 0.02, loadMs: 4000 },
		"detail": { bytes: 600_000, requests: 10, domNodes: 1200, cls: 0.02, loadMs: 3500 },
		"search": { bytes: 900_000, requests: 20, domNodes: 1800, cls: 0.02, loadMs: 3500 },
		"board": { bytes: 500_000, requests: 8, domNodes: 900, cls: 0.02, loadMs: 3000 },
		"verticals": { bytes: 1_600_000, requests: 32, domNodes: 2600, cls: 0.02, loadMs: 4000 },
	},
};

/**
 * Measures one route in one profile.
 *
 * Everything is counted from the network log rather than from the DOM, because
 * the interesting failures are transfers that never became DOM nodes.
 */
async function measure(browser, profile, route) {
	const context = await browser.newContext({
		viewport: profile.viewport,
		deviceScaleFactor: profile.deviceScaleFactor,
		isMobile: profile.isMobile ?? false,
		hasTouch: profile.hasTouch ?? false,
		colorScheme: "dark",
		locale: "en-GB",
		timezoneId: "UTC",
	});
	const page = await context.newPage();

	const transfers = [];
	page.on("response", async (res) => {
		try {
			const headers = res.headers();
			const length = Number(headers["content-length"] ?? 0);
			transfers.push({
				url: res.url(),
				status: res.status(),
				type: headers["content-type"] ?? "",
				bytes: length,
			});
		} catch {
			// A response that arrives after the page closes is not a measurement.
		}
	});

	// Cumulative layout shift, observed rather than calculated. A plate that
	// fails to reserve its geometry shows up here and nowhere else.
	await page.addInitScript(() => {
		window.__cls = 0;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (!entry.hadRecentInput) window.__cls += entry.value;
			}
		}).observe({ type: "layout-shift", buffered: true });
	});

	const started = Date.now();
	const response = await page.goto(`${baseUrl}${route.path}`, {
		waitUntil: "networkidle",
		timeout: 45_000,
	});
	const loadMs = Date.now() - started;

	const inPage = await page.evaluate(() => {
		const nav = performance.getEntriesByType("navigation")[0];
		const images = [...document.images];
		return {
			domNodes: document.querySelectorAll("*").length,
			cls: window.__cls ?? 0,
			// The largest contentful paint, when the browser reports one.
			lcp: null,
			images: {
				total: images.length,
				aboveFold: images.filter((img) => img.getBoundingClientRect().top < 800).length,
				// An image above the fold that is lazy is the single most common
				// way a media-first page makes itself slow.
				lazyAboveFold: images.filter(
					(img) =>
						img.getBoundingClientRect().top < 800 &&
						img.getAttribute("loading") === "lazy",
				).length,
				withoutDimensions: images.filter((img) => !img.getAttribute("width")).length,
				nativeWidths: images.map((img) => img.naturalWidth),
			},
			fontRequests: performance
				.getEntriesByType("resource")
				.filter((r) => r.initiatorType === "css" || r.name.endsWith(".woff2")).length,
			transferEncoding: nav?.transferSize ?? 0,
		};
	});

	// Interaction latency: the two things a reader does immediately.
	const interaction = await page.evaluate(async () => {
		const measure = async (fn) => {
			const t0 = performance.now();
			await fn();
			return Math.round(performance.now() - t0);
		};
		const out = {};
		document.body.focus();
		const focusSearch = await measure(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }),
			);
			await new Promise((r) => requestAnimationFrame(r));
		});
		out.searchShortcutMs = focusSearch;
		out.searchFocused = document.activeElement?.id === "q";

		const back = await measure(async () => {
			if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
			const rail = document.querySelector("[data-rail] a[data-vertical]");
			if (rail) {
				rail.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			}
		});
		out.filterToggleMs = back;
		return out;
	});

	// In \`astro dev\` every module is served separately, so a route looks like it
	// makes sixty requests when production makes a dozen. Counting those would make
	// the number meaningless in both directions, so dev-only module requests are
	// separated out and the budget is on everything else.
	const isDevModule = (url) =>
		url.includes("/@vite/") ||
		url.includes("/@id/") ||
		url.includes("/node_modules/.vite/") ||
		url.includes("?import");
	const assetRequests = transfers.filter((t) => !isDevModule(t.url));

	const imageBytes = assetRequests
		.filter((t) => t.type.startsWith("image/"))
		.reduce((n, t) => n + t.bytes, 0);
	const maxImageWidth = Math.max(0, ...inPage.images.nativeWidths);

	await context.close();

	return {
		route: route.name,
		path: route.path,
		profile: profile.name,
		status: response?.status() ?? 0,
		bytes: assetRequests.reduce((n, t) => n + t.bytes, 0),
		imageBytes,
		requests: assetRequests.length,
		devRequests: transfers.length - assetRequests.length,
		topTransfers: [...assetRequests]
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, 5)
			.map((t) => ({ url: t.url.replace(/^https?:\/\/[^/]+/, ""), bytes: t.bytes })),
		failed: transfers.filter((t) => t.status >= 400).length,
		domNodes: inPage.domNodes,
		cls: Number(inPage.cls.toFixed(4)),
		loadMs,
		images: {
			...inPage.images,
			nativeWidths: undefined,
			maxWidth: maxImageWidth,
			averageWidth: inPage.images.nativeWidths.length
				? Math.round(
						inPage.images.nativeWidths.reduce((a, b) => a + b, 0) /
							inPage.images.nativeWidths.length,
					)
				: 0,
		},
		interaction,
	};
}

const kb = (n) => `${Math.round(n / 1024)}kB`;
const over = (value, limit) => value > limit;

async function main() {
	if (!has("--budgets-only")) {
		const browser = await chromium.launch();
		const results = [];
		for (const profile of PROFILES) {
			for (const route of ROUTES) {
				process.stdout.write(`  measuring ${profile.name} ${route.name}…`);
				results.push(await measure(browser, profile, route));
				process.stdout.write("\r");
			}
		}
		await browser.close();

		console.log(`\nMeasurements — ${baseUrl}\n`);
		console.log(
			"profile       route       status  transfer  images   req   DOM    CLS    load    interactions",
		);
		for (const r of results) {
			console.log(
				[
					r.profile.padEnd(14),
					r.route.padEnd(11),
					String(r.status).padEnd(6),
					kb(r.bytes).padEnd(8),
					kb(r.imageBytes).padEnd(7),
					String(r.requests).padEnd(5),
					String(r.domNodes).padEnd(5),
					r.cls.toFixed(4).padEnd(6),
					`${r.loadMs}ms`.padEnd(7),
					`/foc ${r.interaction.searchShortcutMs}ms, /filt ${r.interaction.filterToggleMs}ms`,
				].join(" "),
			);
		}

		// The media-specific findings, because they are the ones a byte count
		// hides.
		console.log("\nLargest transfers — where the bytes actually are");
		for (const r of results) {
			const top = r.topTransfers.map((t) => `${kb(t.bytes)} ${t.url}`).join("   ");
			console.log(`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)} ${top}`);
		}
		console.log(
			"\nDev module requests are excluded from `req`: `astro dev` serves each module\non its own, so a raw count there is not the number production sees.",
		);

		console.log("\nMedia");
		for (const r of results) {
			const flags = [];
			if (r.images.lazyAboveFold > 0) {
				flags.push(
					`${r.images.lazyAboveFold} lazy image(s) above the fold — the largest thing on the page loads last`,
				);
			}
			if (r.images.withoutDimensions > 0) {
				flags.push(`${r.images.withoutDimensions} image(s) without width/height — these shift`);
			}
			if (r.images.maxWidth > 1600) {
				flags.push(`largest plate is ${r.images.maxWidth}px wide for a ~285px tile`);
			}
			if (r.failed > 0) flags.push(`${r.failed} failed request(s)`);
			console.log(
				`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)} ${r.images.total} images (${r.images.aboveFold} above the fold, widest ${r.images.maxWidth}px, mean ${r.images.averageWidth}px)${flags.length ? ` — ${flags.join("; ")}` : ""}`,
			);
		}

		if (has("--write")) {
			// The written budget is the measurement plus 15%, rounded, so it is a
			// ceiling rather than a coin flip on a noisy run.
			const next = structuredClone(DEFAULT_BUDGETS);
			for (const r of results) {
				next[r.profile][r.route] = {
					bytes: Math.ceil((r.bytes * 1.15) / 1000) * 1000,
					requests: Math.ceil(r.requests * 1.15),
					domNodes: Math.ceil(r.domNodes * 1.15),
					cls: 0.02,
					loadMs: Math.ceil(r.loadMs * 1.15),
				};
			}
			writeFileSync(
				budgetsPath,
				`${JSON.stringify(
					{
						$comment:
							"Generated by scripts/measure-perf.mjs --write. Ceilings on measurements of this implementation, 15% over the observed run. A value above one of these is a regression to investigate, not a number to negotiate.",
						measuredAt: new Date().toISOString().slice(0, 10),
						budgets: next,
					},
					null,
					"\t",
				)}\n`,
			);
			console.log(`\n✔ wrote ${budgetsPath}`);
		}

		compare(results);
		return;
	}

	// Budgets-only: compare the recorded file against nothing, which is a read.
	if (!existsSync(budgetsPath)) {
		console.error(`✖ no budgets recorded at ${budgetsPath}. Run with --write after measuring.`);
		process.exit(1);
	}
	const recorded = JSON.parse(readFileSync(budgetsPath, "utf8"));
	console.log(`Recorded budgets from ${recorded.measuredAt}. Re-measure to compare.`);
	console.log(
		Object.entries(recorded.budgets)
			.flatMap(([profile, routes]) =>
				Object.entries(routes).map(
					([route, budget]) => `  ${profile.padEnd(14)} ${route.padEnd(11)} ${kb(budget.bytes).padEnd(8)} ${budget.requests} req`,
				),
			)
			.join("\n"),
	);
}

function compare(results) {
	const recorded = existsSync(budgetsPath) ? JSON.parse(readFileSync(budgetsPath, "utf8")) : null;
	const budget = recorded?.budgets ?? DEFAULT_BUDGETS;
	const failures = [];
	console.log("\nBudgets");
	for (const r of results) {
		const b = budget[r.profile]?.[r.route];
		if (!b) {
			console.log(`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)} no budget recorded`);
			continue;
		}
		const rows = [
			["transfer", r.bytes, b.bytes, kb],
			["requests", r.requests, b.requests, String],
			["DOM nodes", r.domNodes, b.domNodes, String],
			["CLS", r.cls, b.cls, (n) => n.toFixed(3)],
			["load", r.loadMs, b.loadMs, (n) => `${n}ms`],
		];
		const detail = rows
			.map(([label, value, limit, fmt]) => {
				const mark = over(value, limit) ? "✖" : "✔";
				return `${label} ${fmt(value)}/${fmt(limit)}${mark === "✖" ? " " : ""}`;
			})
			.join("  ");
		console.log(`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)} ${detail}`);
		for (const [label, value, limit] of rows) {
			if (over(value, limit)) failures.push(`${r.profile} ${r.route}: ${label} ${value} over ${limit}`);
		}
		if (r.images.lazyAboveFold > 0) {
			failures.push(`${r.profile} ${r.route}: ${r.images.lazyAboveFold} lazy images above the fold`);
		}
		if (r.images.withoutDimensions > 0) {
			failures.push(`${r.profile} ${r.route}: ${r.images.withoutDimensions} images without dimensions`);
		}
	}

	if (failures.length) {
		console.error(`\n✖ ${failures.length} over budget:\n`);
		for (const f of failures) console.error(`  ${f}`);
		process.exitCode = 1;
		return;
	}
	console.log("\n✔ within budget");
}

await main();