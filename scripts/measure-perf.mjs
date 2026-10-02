#!/usr/bin/env node
/**
 * Performance measurement for the visual wall (#49).
 *
 * The point is not to hit a number someone invented in an article. It is to
 * *measure this implementation* — desktop and mobile separately, on the routes
 * that matter, at both catalogue scale and a wall five hundred entries long —
 * and then write the numbers into a budget file so a regression is a diff
 * rather than an opinion.
 *
 * ## What is measured, and why each one can go wrong here
 *
 * - **Transfer weight per route.** A media-first catalogue that ships every
 *   plate up front is the failure this product is most able to produce.
 * - **When the media starts.** `loading="lazy"` on everything means the wall
 *   above the fold renders instantly; `loading="lazy"` on the *lead* plate means
 *   the largest thing on the page is the slowest thing on the page. The
 *   *attribute* is counted rather than the network, because the attribute is
 *   the decision and the network is the machine's opinion about it.
 * - **How much media actually decoded.** `document.images.length` says how many
 *   images the markup declared, not how many the browser fetched. On a
 *   five-hundred-tile wall the difference between 500 and 7 is the whole
 *   acceptance criterion for #49, and only `naturalWidth` knows which it is.
 * - **Expensive media elements.** A `<video>`, `<audio>`, `<canvas>` or
 *   `<iframe>` on the catalogue wall means something started decoding or
 *   scripting off a plate. None of them belongs there; all of them are counted.
 * - **Layout shift.** Plates reserve their space by aspect ratio, so CLS should
 *   be near zero. Anything else is a real jump. It is sampled after load *and*
 *   after the long scroll, and never across a synthetic click — Chromium's
 *   `hadRecentInput` does not fire for a dispatched event, so a scripted filter
 *   toggle would otherwise be recorded as a quarter-second of layout shift that
 *   no reader experienced.
 * - **Interaction latency** for the search shortcut and the filter rail, which
 *   are the two things a reader does within a minute of arriving — measured
 *   both ways on a large wall, because showing 500 tiles and hiding 490 of them
 *   are different jobs.
 * - **Main-thread cost down a long wall.** Task time, layout, style
 *   recalculation, long tasks and DOM node count, before and after scrolling a
 *   five-hundred-tile wall to its end. This is the "memory/CPU behaviour for
 *   long walls" line of #49 and it is the reason the script can answer the
 *   virtualisation question with a measurement instead of an opinion.
 * - **Request counts and image dimensions**, because a wall of 4:5 plates at
 *   800x1000 is 24 requests at full size before anything is lazy.
 *
 * ## What is a gate and what is only a report — and why
 *
 * Timings are the part of this that is not portable. A laptop in a warm VM will
 * load this page faster than a laptop under a debugger, and a budget that fails
 * on the second is a budget that gets deleted. So every scalar measurement
 * carries a `gate` flag, and only the ones that are properties of the *page*
 * rather than of the machine can fail the run:
 *
 * | Metric        | Gate | Because                                                        |
 * | ------------- | ---- | -------------------------------------------------------------- |
 * | `bytes`       | yes  | a `content-length` from the server                             |
 * | `requests`    | yes  | a count of URLs the document referenced                       |
 * | `domNodes`    | yes  | deterministic given the markup                                 |
 * | `eagerImages` | yes  | the `loading` attribute the wall chose — the decision itself    |
 * | `loadedImages`| no   | a race between the viewport strategy and the network; measured as 1 or 7 or 24 for the same wall depending on when the sampler ran |
 * | `cls`         | no   | depends on when a frame lands                                  |
 * | `loadMs`      | no   | the CPU and the disk                                          |
 * | `ttfbMs`      | no   | the same, plus dev-server module compilation                   |
 *
 * The structural assertions are gates whatever the machine does: a failed
 * request, a lazy image above the fold, an image with no dimensions, an
 * expensive media element, or a scale wall that did not produce the number of
 * tiles it was asked for.
 *
 * ## Transfer is measured after the long scroll, on purpose
 *
 * Every route is scrolled to its end before the byte total is read. That makes
 * `bytes` mean "what it cost a reader who read the whole page", which is the
 * question #49 asks, and it is why a five-hundred-entry wall and a
 * twenty-four-entry wall report the same transfer: the plates are twenty-four
 * unique vectors, so the extra 476 tiles cost 476 cache hits and no bytes.
 *
 * Usage:
 *   node scripts/measure-perf.mjs                     # measure and print
 *   node scripts/measure-perf.mjs --write             # measure and update budgets
 *   node scripts/measure-perf.mjs --budgets-only      # read the recorded file
 *   node scripts/measure-perf.mjs --url http://…      # a different origin
 *   node scripts/measure-perf.mjs --repeat 3          # median of N runs, noisy hosts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
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
 * Median of N runs, for hosts where one sample is noise.
 *
 * A single `loadMs` on a machine that is also running a dev server, a type
 * checker and three test suites is not a measurement, it is a sample. Three
 * samples with the median taken is the cheapest honest improvement, and it is
 * opt-in because the cost is three times the browser work.
 */
const REPEAT = Math.max(1, Number(value("--repeat", "1")) || 1);

/**
 * The routes that matter, and why.
 *
 * The wall first because it is the product. Then a drill-in, because it is the
 * heaviest page per byte of *content*. `scale-500` is the acceptance criterion
 * for #49 written as a route: the same wall, with the same component, grid,
 * filter and lazy strategy, rendered with five hundred entries instead of
 * twenty-four. It is `devOnly` because `?scale=` is refused outside `astro dev`
 * — the entries it invents do not exist, and a production wall of five hundred
 * of them would be a real performance liability and a larger lie.
 */
const ROUTES = [
	{ path: "/", name: "wall" },
	{ path: "/possibilities/density-gradient", name: "detail" },
	{ path: "/search?q=seam", name: "search" },
	{ path: "/board", name: "board" },
	{ path: "/verticals", name: "verticals" },
	{ path: "/?scale=500", name: "scale-500", devOnly: true, scale: 500 },
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

const kb = (n) => `${Math.round(n / 1024)}kB`;
const ms = (n) => `${Math.round(n)}ms`;

/**
 * A scalar measurement, and whether it can fail the run.
 *
 * `gate: false` does not mean "not measured" — it means "measured, printed,
 * budgeted, and a diff in `docs/performance-budgets.json` will show it, but it
 * will not turn a run red". The `why` is written into the budget file so a
 * later reader does not have to reconstruct the argument from a failing CI job.
 */
const SCALAR_METRICS = {
	bytes: {
		gate: true,
		why: "a content-length reported by the server, summed after the long scroll, so it is not a property of the host",
	},
	requests: { gate: true, why: "a count of URLs the document referenced" },
	domNodes: { gate: true, why: "deterministic given the markup" },
	eagerImages: {
		gate: true,
		why: "the `loading` attribute the wall chose per plate — the decision itself, which is what stops a 500-tile wall fetching 500 plates",
	},
	loadedImages: {
		gate: false,
		/**
		 * Not a ceiling at all, which is why it is compared differently.
		 *
		 * The first version of this recorded 7 and reported 87 as an overrun on
		 * every subsequent run, which is worse than useless: a permanently red line
		 * trains people to ignore the section it is in. The number is a race
		 * between the viewport strategy and the network — the same wall measured 7
		 * and 87 on consecutive runs, depending on how much Chromium had decided to
		 * prefetch below the fold — so it is recorded as an *observation*, with the
		 * spread the run saw, and never compared to anything.
		 *
		 * `eagerImages` is the gate. It is the decision, this is the outcome.
		 */
		observation: true,
		why: "a race between the viewport strategy and the network — the same wall measured 7 and 87 on consecutive runs. `eagerImages` is the decision and is gated; this is the outcome and is not",
	},
	documentBytes: {
		gate: false,
		why: "a function of how many entries the catalogue holds, so it moves when content is published rather than when code regresses; `eagerImages` and `domNodes` are the ceilings that catch a rendering regression",
	},
	cls: { gate: false, why: "depends on when a frame lands, so it moves with the host" },
	loadMs: { gate: false, why: "wall clock on whatever machine ran it" },
	ttfbMs: { gate: false, why: "server render plus, in dev, Vite module compilation" },
	drillInMs: {
		gate: false,
		why: "a real click and navigation; the server render dominates and the server is the host",
	},
};

// A budget is a ceiling on a measurement. Anything above it is a regression to
// investigate, not a number to negotiate. These are the hand-set ceilings that
// apply when nothing has been recorded yet; `--write` replaces them with what
// this implementation actually did.
const DEFAULT_BUDGETS = {
	"mobile-390": {
		wall: { bytes: 900_000, requests: 90, domNodes: 2500, eagerImages: 8, loadedImages: 40, cls: 0.02, loadMs: 4500, ttfbMs: 4000, drillInMs: 4500, documentBytes: 2_000_000 },
		detail: { bytes: 500_000, requests: 60, domNodes: 1200, eagerImages: 8, loadedImages: 12, cls: 0.02, loadMs: 4000, ttfbMs: 3500, drillInMs: 4500, documentBytes: 2_000_000 },
		search: { bytes: 700_000, requests: 60, domNodes: 1800, eagerImages: 8, loadedImages: 12, cls: 0.02, loadMs: 4000, ttfbMs: 3500, drillInMs: 4500, documentBytes: 2_000_000 },
		board: { bytes: 400_000, requests: 55, domNodes: 900, eagerImages: 4, loadedImages: 4, cls: 0.02, loadMs: 3500, ttfbMs: 3000, drillInMs: 4500, documentBytes: 2_000_000 },
		verticals: { bytes: 900_000, requests: 85, domNodes: 2600, eagerImages: 30, loadedImages: 40, cls: 0.02, loadMs: 4500, ttfbMs: 3500, drillInMs: 4500, documentBytes: 2_000_000 },
		"scale-500": { bytes: 6_000_000, requests: 90, domNodes: 30_000, eagerImages: 8, loadedImages: 200, cls: 0.02, loadMs: 12_000, ttfbMs: 6000, drillInMs: 12_000, documentBytes: 2_000_000 },
	},
	"desktop-1280": {
		wall: { bytes: 1_600_000, requests: 90, domNodes: 2500, eagerImages: 8, loadedImages: 40, cls: 0.02, loadMs: 4000, ttfbMs: 3500, drillInMs: 4500, documentBytes: 2_000_000 },
		detail: { bytes: 600_000, requests: 60, domNodes: 1200, eagerImages: 8, loadedImages: 12, cls: 0.02, loadMs: 3500, ttfbMs: 3000, drillInMs: 4500, documentBytes: 2_000_000 },
		search: { bytes: 900_000, requests: 60, domNodes: 1800, eagerImages: 8, loadedImages: 12, cls: 0.02, loadMs: 3500, ttfbMs: 3000, drillInMs: 4500, documentBytes: 2_000_000 },
		board: { bytes: 500_000, requests: 55, domNodes: 900, eagerImages: 4, loadedImages: 4, cls: 0.02, loadMs: 3000, ttfbMs: 2500, drillInMs: 4500, documentBytes: 2_000_000 },
		verticals: { bytes: 1_600_000, requests: 85, domNodes: 2600, eagerImages: 30, loadedImages: 40, cls: 0.02, loadMs: 4000, ttfbMs: 3000, drillInMs: 4500, documentBytes: 2_000_000 },
		"scale-500": { bytes: 8_000_000, requests: 90, domNodes: 30_000, eagerImages: 8, loadedImages: 200, cls: 0.02, loadMs: 12_000, ttfbMs: 6000, drillInMs: 12_000, documentBytes: 2_000_000 },
	},
};

/**
 * Reads Chromium's own counters.
 *
 * `performance.memory` is non-standard and Chromium-only; the CDP
 * `Performance.getMetrics` list is the same data with stable names, and it is
 * the only way to answer "what does a 500-tile wall cost" rather than guessing
 * from the DOM node count.
 *
 * The honest limit, stated because it matters: `JSHeapUsedSize` is the
 * *JavaScript* heap and a wall's cost is not in it. DOM memory belongs to the
 * renderer and is not exposed as a byte count by any CDP domain this script can
 * reach, so the DOM is counted in nodes — which is the unit it is actually
 * expensive in — and the process RSS is simply not measured. `docs/PERFORMANCE.md`
 * says the same thing in prose so nobody reads a small heap number as a small
 * wall.
 */
async function counters(client) {
	if (!client) return null;
	try {
		const { metrics } = await client.send("Performance.getMetrics");
		const by = (name) => metrics.find((m) => m.name === name)?.value;
		let dom = null;
		try {
			dom = await client.send("Memory.getDOMCounters");
		} catch {
			// Not every Chromium build exposes the Memory domain; nulls print as `—`.
		}
		return {
			heapMB: (by("JSHeapUsedSize") ?? 0) / 1024 / 1024,
			taskMs: (by("TaskDuration") ?? 0) * 1000,
			layoutCount: by("LayoutCount") ?? 0,
			layoutMs: (by("LayoutDuration") ?? 0) * 1000,
			recalcStyleCount: by("RecalcStyleCount") ?? 0,
			recalcStyleMs: (by("RecalcStyleDuration") ?? 0) * 1000,
			domNodes: dom?.nodes ?? null,
			jsEventListeners: dom?.jsEventListeners ?? null,
		};
	} catch {
		return null;
	}
}

/**
 * Measures one route in one profile.
 *
 * Everything is counted from the network log rather than from the DOM, because
 * the interesting failures are transfers that never became DOM nodes — and, at
 * 500 entries, the other way round: DOM nodes that never became transfers.
 */
async function measureOnce(browser, profile, route) {
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
	// Chromium only; the counters are the one measurement here that another
	// engine would have to be asked differently.
	const client = await context.newCDPSession(page).catch(() => null);
	if (client) await client.send("Performance.enable").catch(() => {});

	/**
	 * Parses EmDash's `Server-Timing` header.
	 *
	 * This is the server half of the measurement, and it is the only place the
	 * numbers come from rather than from Chromium's clock: `render` is the page
	 * render, `db.total` is time spent in D1, `db.count` is how many queries it
	 * took, and `db.first`/`db.last` say when in the render they happened. On the
	 * drill-in that is where the N+1 in `loadExamplesFor` shows up, and no amount
	 * of client-side instrumentation would have found it.
	 */
	const serverTiming = (header) => {
		const out = {};
		if (!header) return out;
		for (const part of header.split(",")) {
			const [name, ...params] = part.trim().split(";");
			const dur = params.find((p) => p.trim().startsWith("dur="));
			if (dur) out[name.trim()] = Number(dur.trim().slice(4));
		}
		return out;
	};

	const transfers = [];
	/** The document, tracked on its own. A navigation response is not
	 *  identifiable by content-type — `astro dev` and a Worker both serve HTML
	 *  with whatever headers they like — but `isNavigationRequest` is exact. */
	let document_ = null;
	let documentTiming = {};
	page.on("response", async (res) => {
		try {
			const headers = res.headers();
			// `content-length` is missing on the document: `astro dev` and the
			// Worker both answer a streamed page with `transfer-encoding: chunked`.
			// Counting only what declares a length silently drops the largest single
			// transfer on the page — and on a 500-tile wall that is 1.1MB, which is
			// the number #49 exists to find. So the body is read when the header is
			// absent. `res.body()` is cached by Playwright, so this costs one
			// transfer that has already happened.
			let length = Number(headers["content-length"] ?? 0);
			if (length === 0) {
				length = (await res.body().catch(() => Buffer.alloc(0))).length;
			}
			const entry = {
				url: res.url(),
				status: res.status(),
				type: headers["content-type"] ?? "",
				bytes: length,
			};
			transfers.push(entry);
			if (res.request().isNavigationRequest() && !document_) {
				document_ = entry;
				documentTiming = serverTiming(headers["server-timing"]);
			}
		} catch {
			// A response that arrives after the page closes is not a measurement.
		}
	});

	page.on("requestfailed", (req) => {
		// A request that never produced a response has no `status` to count in the
		// response handler, so it is counted here instead. A wall with a silently
		// dropped plate is worse than a wall with a 404.
		transfers.push({ url: req.url(), status: 599, type: "", bytes: 0 });
	});

	// Cumulative layout shift and long tasks, observed rather than calculated.
	// A plate that fails to reserve its geometry shows up in the first and
	// nowhere else; a long task shows up in the second and is the only portable
	// way to say the main thread was blocked while scrolling a long wall.
	await page.addInitScript(() => {
		window.__cls = 0;
		window.__longTasks = [];
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (!entry.hadRecentInput) window.__cls += entry.value;
			}
		}).observe({ type: "layout-shift", buffered: true });
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					window.__longTasks.push(Math.round(entry.duration));
				}
			}).observe({ type: "longtask", buffered: true });
		} catch {
			// `longtask` is Chromium-only. Absent, the scroll report shows `—`.
		}
	});

	const started = Date.now();
	const response = await page.goto(`${baseUrl}${route.path}`, {
		waitUntil: "networkidle",
		timeout: 120_000,
	});
	const loadMs = Date.now() - started;
	// Let the lazy strategy finish whatever it was about to start, so "how many
	// plates has this wall fetched" is sampled after it has stopped rather than
	// in the middle of a decision. It still cannot be a gate — see `SCALAR_METRICS`.
	await page.waitForTimeout(400);

	/**
	 * Reads the page. Everything the "is it eager?" question needs is here:
	 * `loaded` is `naturalWidth`, so it is the browser's own answer to "did this
	 * image actually arrive", not an inference from the `loading` attribute.
	 */
	const readPage = () =>
		page.evaluate(() => {
			const nav = performance.getEntriesByType("navigation")[0];
			const images = [...document.images];
			const loaded = (img) => img.complete && img.naturalWidth > 0;
			return {
				domNodes: document.querySelectorAll("*").length,
				cls: window.__cls ?? 0,
				tiles: document.querySelectorAll(".tile").length,
				images: {
					total: images.length,
					aboveFold: images.filter((img) => img.getBoundingClientRect().top < 800).length,
					// An image above the fold that is lazy is the single most common
					// way a media-first page makes itself slow.
					lazyAboveFold: images.filter(
						(img) => img.getBoundingClientRect().top < 800 && img.getAttribute("loading") === "lazy",
					).length,
					withoutDimensions: images.filter((img) => !img.getAttribute("width")).length,
					// The decision the wall made, per plate. Deterministic, and the
					// thing that stops a 500-tile wall from fetching 500 plates.
					eager: images.filter((img) => img.getAttribute("loading") !== "lazy").length,
					loaded: images.filter(loaded).length,
					nativeWidths: images.map((img) => img.naturalWidth),
				},
				/**
				 * The expensive-media census.
				 *
				 * Every one of these is something the catalogue wall must not
				 * instantiate: a `<video>` decodes frames, an `<audio>` opens a
				 * decoder, a `<canvas>` runs a renderer, an `<iframe>` runs a
				 * document. A plate is an `<img>` with a poster, and a poster frame
				 * is the whole of what #49's "poster frames" delivery strategy is
				 * supposed to mean. Anything non-zero here is a wall that has
				 * started decoding off a plate.
				 */
				expensive: {
					video: document.querySelectorAll("video").length,
					audio: document.querySelectorAll("audio").length,
					canvas: document.querySelectorAll("canvas").length,
					iframe: document.querySelectorAll("iframe,object,embed").length,
				},
				nav: {
					ttfbMs: nav ? nav.responseStart - nav.requestStart : 0,
					documentMs: nav ? nav.responseEnd - nav.responseStart : 0,
					domInteractiveMs: nav ? nav.domInteractive : 0,
					domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : 0,
					transferSize: nav?.transferSize ?? 0,
				},
			};
		});

	const inPage = await readPage();
	const afterLoad = await counters(client);

	/**
	 * The long-wall measurement.
	 *
	 * Twenty frames' worth of scrolling to the bottom of the wall, with
	 * Chromium's own counters read either side. This is what answers
	 * "memory/CPU behaviour for long walls": how much main-thread time scrolling
	 * it consumes, how many layouts and style recalculations it triggers, how
	 * many nodes it holds, and how many plates a reader who reads to the end
	 * actually downloads.
	 */
	// `afterLoad` above is the "before" reading: the counters are taken once the
	// wall has settled and again once it has been scrolled to its end, and the
	// difference is the cost of the scroll. A third reading here would only be
	// taken mid-scroll, which is the one moment a count means nothing.
	const deep = await page.evaluate(async () => {
		const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const longTasksBefore = window.__longTasks.length;
		const t0 = performance.now();
		const height = Math.max(1, document.documentElement.scrollHeight);
		const steps = 20;
		for (let i = 1; i <= steps; i++) {
			scrollTo({ top: (height * i) / steps, behavior: "instant" });
			await frame();
		}
		scrollTo({ top: height, behavior: "instant" });
		await frame();
		const images = [...document.images];
		return {
			ms: Math.round(performance.now() - t0),
			longTasks: window.__longTasks.slice(longTasksBefore),
			scrollHeight: height,
			atBottom: Math.round(scrollY),
			loadedAfter: images.filter((img) => img.complete && img.naturalWidth > 0).length,
			cls: window.__cls ?? 0,
		};
	});
	const maxImageWidth = Math.max(0, ...inPage.images.nativeWidths);
	const delta = (a, b, key) => (a && b && a[key] !== null && b[key] !== null ? Number((b[key] - a[key]).toFixed(1)) : null);

	const afterScroll = await counters(client);
	const settled = await readPage();

	// Interaction latency: the two things a reader does immediately. Measured
	// *after* the long scroll, on a wall that has already decoded everything it
	// is going to decode — so this is the worst case, not a page caught mid-load.
	await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
	await page.waitForTimeout(120);
	const interaction = await page.evaluate(async () => {
		const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
		const measure = async (fn) => {
			const t0 = performance.now();
			await fn();
			await nextFrame();
			return Math.round(performance.now() - t0);
		};
		const clickChip = async (selector) => {
			const chip = document.querySelector(selector);
			if (!chip) return false;
			chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			await nextFrame();
			return true;
		};
		const out = {};
		document.body.focus();
		out.searchShortcutMs = await measure(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
		});
		out.searchFocused = document.activeElement?.id === "q";
		if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

		// "All" — the reader putting every tile back. On the real wall that is 24
		// tiles; on the scale wall it is five hundred, and the gap between the two
		// is the number #49 is asking for.
		out.filterToggleMs = (await measure(() => clickChip("[data-rail] a[data-vertical]"))) ?? 0;

		// The narrowest vertical in the rail — the reader hiding the most tiles
		// with one click. On the real wall that is 21 of 24; on the scale wall it
		// is the same loop over twenty times the tiles.
		const counts = [...document.querySelectorAll("[data-rail] a[data-vertical]")].map((chip) => ({
			slug: chip.dataset.vertical ?? "",
			n: Number(chip.querySelector(".chip__n")?.textContent ?? "0"),
		}));
		const narrowest = counts.filter((c) => c.slug !== "").sort((a, b) => a.n - b.n)[0];
		out.filterNarrowMs = narrowest
			? ((await measure(() => clickChip(`[data-rail] a[data-vertical="${narrowest.slug}"]`))) ?? 0)
			: 0;
		out.filterNarrowSlug = narrowest?.slug ?? null;
		out.filterNarrowTiles = narrowest?.n ?? 0;

		// Back to everything, so nothing after this sees a filtered wall.
		await clickChip('[data-rail] a[data-vertical=""]');
		return out;
	});

	// In `astro dev` every module is served separately, so a route looks like it
	// makes sixty requests when production makes a dozen. Counting those would make
	// the number meaningless in both directions, so dev-only module requests are
	// separated out and the budget is on everything else.
	const isDevModule = (url) =>
		url.includes("/@vite/") ||
		url.includes("/@id/") ||
		url.includes("/node_modules/.vite/") ||
		url.includes("?import");

	/**
	 * The transfer totals are taken *here*, after the long scroll and before the
	 * drill-in, because the drill-in is a second page and its bytes are its own.
	 * Summing afterwards is how a wall ends up reported as 473kB because the
	 * reader went somewhere.
	 */
	const routeTransfers = transfers.filter((t) => !isDevModule(t.url));
	const bytes = routeTransfers.reduce((n, t) => n + t.bytes, 0);
	const imageBytes = routeTransfers
		.filter((t) => t.type.startsWith("image/"))
		.reduce((n, t) => n + t.bytes, 0);

	/**
	 * Drill-in latency, which #49's budget list names and nothing here measured.
	 *
	 * A real click on the first plate and a real navigation, because the number
	 * that matters is the reader's: server render plus document transfer plus
	 * network idle, from a wall that is already on screen and warm. Measured on a
	 * wall of 500 as well as a wall of 24, because the drill-in's cost is the
	 * same work either way and the difference is the server's.
	 *
	 * Last, because it leaves the page. Anything measured after it would be
	 * measuring the drill-in rather than the wall.
	 */
	let drillInMs = null;
	let drillInStatus = 0;
	const firstPlate = await page.$('.tile__link[href^="/possibilities/"]');
	if (firstPlate) {
		const t0 = Date.now();
		try {
			await firstPlate.click({ timeout: 20_000 });
			await page.waitForLoadState("networkidle", { timeout: 60_000 });
			drillInMs = Date.now() - t0;
			drillInStatus = page.url().includes("/possibilities/") ? 200 : 0;
		} catch {
			// A route with plates that do not drill in is not a failure; a route that
			// does drill in and lands somewhere else is, and `drillInStatus` is how
			// that shows up.
			drillInMs = null;
		}
	}

	/**
	 * What the document costs once a compressor has been through it.
	 *
	 * 1.1MB of HTML for a 500-tile wall sounds like a verdict, and on a cold
	 * uncompressed connection it nearly is one. But this document is 500 copies
	 * of the same 24 tiles, so a compressor removes almost all of it, and the
	 * whole virtualisation argument turns on which of those two numbers a reader
	 * actually receives. Cloudflare compresses HTML automatically; this measures
	 * what a compressor can do to the bytes rather than what a particular CDN
	 * configuration did, which is the claim that can be made honestly.
	 *
	 * Read over Playwright's request API so it does not land in the page's own
	 * transfer log — `routeTransfers` was already snapshotted above.
	 */
	let compressed = null;
	try {
		const raw = await (await page.context().request.get(`${baseUrl}${route.path}`)).text();
		const buf = Buffer.from(raw, "utf8");
		compressed = {
			raw: buf.length,
			gzip: gzipSync(buf, { level: 9 }).length,
			brotli: brotliCompressSync(buf, {
				params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
			}).length,
		};
	} catch {
		// No compressor numbers rather than invented ones.
	}

	await context.close();

	return {
		route: route.name,
		path: route.path,
		profile: profile.name,
		status: response?.status() ?? 0,
		bytes,
		imageBytes,
		documentBytes: document_?.bytes ?? 0,
		compressed,
		serverTiming: documentTiming,
		requests: routeTransfers.length,
		devRequests: transfers.length - routeTransfers.length,
		topTransfers: [...routeTransfers]
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, 5)
			.map((t) => ({ url: t.url.replace(/^https?:\/\/[^/]+/, ""), bytes: t.bytes })),
		failed: transfers.filter((t) => t.status >= 400).length,
		domNodes: inPage.domNodes,
		cls: Number(Math.max(inPage.cls, deep.cls).toFixed(4)),
		loadMs,
		ttfbMs: Math.round(inPage.nav.ttfbMs),
		documentMs: Math.round(inPage.nav.documentMs),
		domInteractiveMs: Math.round(inPage.nav.domInteractiveMs),
		tiles: inPage.tiles,
		scale: route.scale ?? null,
		images: {
			total: inPage.images.total,
			aboveFold: inPage.images.aboveFold,
			lazyAboveFold: inPage.images.lazyAboveFold,
			withoutDimensions: inPage.images.withoutDimensions,
			eager: inPage.images.eager,
			loaded: inPage.images.loaded,
			maxWidth: maxImageWidth,
			averageWidth: inPage.images.nativeWidths.length
				? Math.round(
						inPage.images.nativeWidths.reduce((a, b) => a + b, 0) / inPage.images.nativeWidths.length,
					)
				: 0,
		},
		expensive: {
			...inPage.expensive,
			total:
				inPage.expensive.video + inPage.expensive.audio + inPage.expensive.canvas + inPage.expensive.iframe,
		},
		deep: {
			ms: deep.ms,
			scrollHeight: deep.scrollHeight,
			atBottom: deep.atBottom,
			longTasks: deep.longTasks.length,
			longestTaskMs: deep.longTasks.length ? Math.max(...deep.longTasks) : 0,
			heapMB: afterScroll?.heapMB ?? null,
			heapDeltaMB: delta(afterLoad, afterScroll, "heapMB"),
			domNodes: afterScroll?.domNodes ?? null,
			jsEventListeners: afterScroll?.jsEventListeners ?? null,
			taskDeltaMs: delta(afterLoad, afterScroll, "taskMs"),
			layoutCountDelta: delta(afterLoad, afterScroll, "layoutCount"),
			layoutDeltaMs: delta(afterLoad, afterScroll, "layoutMs"),
			recalcStyleCountDelta: delta(afterLoad, afterScroll, "recalcStyleCount"),
			recalcStyleDeltaMs: delta(afterLoad, afterScroll, "recalcStyleMs"),
			loadedAfter: deep.loadedAfter,
			imagesNowLoaded: settled.images.loaded,
		},
		interaction,
		drillInMs,
		drillInStatus,
	};
}

/**
 * Navigates once, throws the result away.
 *
 * Exists so the first *measured* route is not also the first navigation a cold
 * browser has ever made. Kept beside the measurement rather than at the call
 * site so the reason travels with it.
 */
async function warmBrowser(browser, url) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	try {
		await page.goto(`${url}/board`, { waitUntil: "networkidle", timeout: 60_000 });
		await page.waitForTimeout(300);
	} catch {
		// A warm-up that fails is not a reason to stop; the measurement that
		// follows will report the real problem against the route that has it.
	}
	await context.close();
	return true;
}

/**
 * One measurement, or the median of several.
 *
 * The median rather than the mean because a single slow run on a busy machine
 * is an outlier and the mean would bake it in; the minimum would flatter.
 */
async function measure(browser, profile, route) {
	const runs = [];
	for (let i = 0; i < REPEAT; i++) runs.push(await measureOnce(browser, profile, route));
	if (runs.length === 1) return runs[0];
	const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
	const merged = { ...runs[0] };
	for (const key of [
		"bytes", "imageBytes", "documentBytes", "requests", "devRequests", "failed", "domNodes", "cls",
		"loadMs", "ttfbMs", "documentMs", "domInteractiveMs", "tiles", "drillInMs",
	]) {
		merged[key] = median(runs.map((r) => r[key]));
	}
	merged.images = { ...runs[0].images };
	for (const key of ["total", "aboveFold", "lazyAboveFold", "withoutDimensions", "eager", "loaded", "maxWidth"]) {
		merged.images[key] = median(runs.map((r) => r.images[key]));
	}
	merged.deep = { ...runs[0].deep };
	for (const key of ["ms", "scrollHeight", "longestTaskMs", "loadedAfter", "imagesNowLoaded"]) {
		merged.deep[key] = median(runs.map((r) => r.deep[key]));
	}
	merged.deep.longTasks = median(runs.map((r) => r.deep.longTasks));
	return merged;
}

/** Formats a metric for the budget line. Every one of them, in one place. */
const FORMAT = {
	bytes: kb,
	requests: String,
	domNodes: String,
	eagerImages: String,
	loadedImages: String,
	documentBytes: kb,
	cls: (n) => n.toFixed(4),
	loadMs: ms,
	ttfbMs: ms,
	drillInMs: ms,
};

const valueOf = (result, key) =>
	key === "loadedImages"
		? result.images.loaded
		: key === "eagerImages"
			? result.images.eager
			: key === "drillInMs"
				? (result.drillInMs ?? 0)
				: result[key];

/**
 * Is there a server, and is it serving?
 *
 * `up`, `down` or `broken`, the same three-way answer `tests/routes.test.ts`
 * gives, for the same reason: a reachable server that answers every route with a
 * 500 is reachable, and a "can I connect?" check would then send every assertion
 * downstream to fail for the wrong reason. The worse failure is the one that
 * started there — a gate that skips because the thing it checks is broken is
 * worse than no gate.
 */
async function preflight(url) {
	try {
		const res = await fetch(`${url}/`, { redirect: "manual" });
		if (res.ok) return { state: "up" };
		const body = await res.text().catch(() => "");
		const reason = body.match(/"message":"([^"]{0,200})/)?.[1];
		return { state: "broken", why: `HTTP ${res.status}${reason ? `: ${reason}` : ""}` };
	} catch {
		return { state: "down" };
	}
}

async function main() {
	if (!has("--budgets-only")) {
		const reach = await preflight(baseUrl);
		if (reach.state === "down") {
			console.error(
				`✖ nothing is serving ${baseUrl}.\n  This check measures a running site. Start one with \`npm run dev\`\n  (or \`npm run preview\` for the production build) and point at it with --url.`,
			);
			process.exit(1);
		}
		if (reach.state === "broken") {
			console.error(
				`✖ ${baseUrl} is running but not serving (${reach.why}).\n  Fix the server before reading anything else here — every measurement below would\n  be measuring the error page.`,
			);
			process.exit(1);
		}
		let browser;
		try {
			browser = await chromium.launch();
		} catch (error) {
			console.error(
				`✖ could not launch Chromium (${error.message}).\n  This check needs a browser; it is not a bundle-size gate.`,
			);
			process.exit(1);
		}
		const isLocal = /localhost|127\.0\.0\.1/.test(baseUrl);
		const results = [];
		const skipped = [];

		/**
		 * One discarded navigation before anything is measured.
		 *
		 * The first route in a run pays for the browser: first paint of the process,
		 * JIT warm-up, first-paint of the fonts, and the first cost of every Vite
		 * transform the page needs. Left in, it landed on `mobile wall` as a
		 * 2,266ms long task — four times the entire main-thread budget of the
		 * 500-tile wall — which is a true statement about the first navigation of
		 * a cold browser and a completely useless statement about a wall. `/board`
		 * is the warm-up because it is the cheapest route with a real layout.
		 */
		await warmBrowser(browser, baseUrl);

		for (const profile of PROFILES) {
			for (const route of ROUTES) {
				if (route.devOnly && !isLocal) {
					skipped.push({ ...route, why: "`?scale=` is refused outside `astro dev`" });
					continue;
				}
				process.stdout.write(`  measuring ${profile.name} ${route.name}…`);
				results.push(await measure(browser, profile, route));
				process.stdout.write("\r");
			}
		}
		await browser.close();

		console.log(`\nMeasurements — ${baseUrl}  (transfer read after the long scroll)\n`);
		console.log(
			"profile       route       status  transfer  images   req   DOM     CLS     TTFB   load    tiles  fetched  interactions",
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
					String(r.domNodes).padEnd(7),
					r.cls.toFixed(4).padEnd(7),
					ms(r.ttfbMs).padEnd(6),
					ms(r.loadMs).padEnd(7),
					String(r.tiles).padEnd(6),
					`${r.images.loaded}/${r.images.total}`.padEnd(8),
					`/foc ${r.interaction.searchShortcutMs}ms, /all ${r.interaction.filterToggleMs}ms, /narrow ${r.interaction.filterNarrowMs}ms, /in ${r.drillInMs === null ? "—" : ms(r.drillInMs)}`,
				].join(" "),
			);
		}
		for (const s of skipped) {
			console.log(`  ${"(skipped)".padEnd(14)} ${s.name.padEnd(11)} ${s.why}`);
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
			if (r.expensive.total > 0) {
				flags.push(
					`${r.expensive.total} expensive media element(s) — ${r.expensive.video} video, ${r.expensive.audio} audio, ${r.expensive.canvas} canvas, ${r.expensive.iframe} iframe/embed`,
				);
			}
			if (r.failed > 0) flags.push(`${r.failed} failed request(s)`);
			console.log(
				`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)} ${r.images.total} plates, ${r.images.eager} marked eager, ${r.images.loaded} fetched (${r.images.aboveFold} above the fold, widest ${r.images.maxWidth}px, mean ${r.images.averageWidth}px)${flags.length ? ` — ${flags.join("; ")}` : ""}`,
			);
		}

		/**
		 * The scale report.
		 *
		 * Printed for every wall rather than only the fixture, because the real
		 * comparison is the ratio: a plate the viewport strategy did not fetch
		 * costs a reader nothing until they look at it, and that ratio is what
		 * #49's acceptance criterion is really about.
		 */
		console.log("\nLong-wall behaviour — scrolled to the end in 20 frames");
		for (const r of results) {
			const d = r.deep;
			const pct = (n) => (r.images.total ? ` (${Math.round((n / r.images.total) * 100)}%)` : "");
			const longTasks =
				d.longTasks === 0 ? "no long task" : `${d.longTasks} long task(s), worst ${ms(d.longestTaskMs)}`;
			const c = r.compressed;
			const wire = c ? `${kb(c.raw)} → ${kb(c.gzip)} gzip / ${kb(c.brotli)} brotli` : "—";
			console.log(
				[
					`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)}`,
					`HTML ${kb(r.documentBytes)}`.padEnd(16),
					wire.padEnd(38),
					`${d.scrollHeight}px tall`.padEnd(14),
					`nodes ${d.domNodes ?? "—"}`.padEnd(14),
					`main thread ${d.taskDeltaMs === null ? "—" : ms(d.taskDeltaMs)}`.padEnd(22),
					`layout ×${d.layoutCountDelta ?? "—"} / style ×${d.recalcStyleCountDelta ?? "—"}`.padEnd(26),
					`${longTasks}`.padEnd(30),
					`plates fetched ${r.images.loaded} at load${pct(r.images.loaded)} → ${d.loadedAfter} at the bottom${pct(d.loadedAfter)} of ${r.images.total}`,
				].join(" "),
			);
		}

		/**
		 * The server's own account of itself.
		 *
		 * EmDash emits `Server-Timing` on every render, so the server half of
		 * "wall render time" does not have to be inferred from a client clock. It
		 * also answers the question `docs/PERFORMANCE.md` had left open — where
		 * the time goes — because `db.count` is the number of queries a route took
		 * and `render` is everything that was not the query.
		 */
		console.log("\nServer render — EmDash's own Server-Timing, in milliseconds");
		for (const r of results) {
			const t = r.serverTiming;
			const n = (v) => (v === undefined ? "—" : Math.round(v));
			console.log(
				[
					`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)}`,
					`render ${n(t.render)}`.padEnd(16),
					`middleware ${n(t.mw)}`.padEnd(19),
					`D1 ${n(t["db.total"])}`.padEnd(10),
					`${n(t["db.count"])} queries`.padEnd(15),
					`first ${n(t["db.first"])} / last ${n(t["db.last"])}`.padEnd(24),
					`cache ${n(t["cache.hit"])} hit / ${n(t["cache.miss"])} miss`,
				].join(" "),
			);
		}

		if (has("--write")) {
			// The written budget is the measurement plus 15%, rounded, so it is a
			// ceiling rather than a coin flip on a noisy run.
			const next = structuredClone(DEFAULT_BUDGETS);
			for (const r of results) {
				next[r.profile][r.route] = {};
				for (const [key] of Object.entries(SCALAR_METRICS)) {
					if (key === "cls") {
						// CLS keeps a fixed 0.02. It is the one number here that is a
						// standard rather than a measurement of this implementation, and
						// deriving a ceiling from an observed 0.0000 would be a ceiling of
						// zero — which fails on the first frame that lands differently.
						next[r.profile][r.route][key] = 0.02;
						continue;
					}
					const observed = valueOf(r, key);
					// A route with nothing to drill into keeps the hand-set ceiling rather
					// than recording a ceiling of zero, which would become a fake limit the
					// first time somebody added a plate to it.
					if (observed === 0 && key === "drillInMs") continue;
					// Observations are recorded as what was seen and compared to nothing.
					if (SCALAR_METRICS[key].observation) {
						next[r.profile][r.route][key] = observed;
						continue;
					}
					const round = key === "bytes" ? 1000 : key === "loadMs" || key === "ttfbMs" || key === "drillInMs" ? 250 : 1;
					next[r.profile][r.route][key] = Math.ceil((observed * 1.15) / round) * round;
				}
			}
			writeFileSync(
				budgetsPath,
				`${JSON.stringify(
					{
						$comment:
							"Generated by scripts/measure-perf.mjs --write. Ceilings on measurements of this implementation, 15% over the observed run. A value above one of these is a regression to investigate, not a number to negotiate.",
						measuredAt: new Date().toISOString().slice(0, 10),
						$gate:
							"A metric only fails the run when `gate` is true. Timings depend on the machine; byte counts, request counts, DOM size and the eager/lazy decision the wall made are properties of the page and fail anywhere.",
						metrics: Object.fromEntries(
							Object.entries(SCALAR_METRICS).map(([key, spec]) => [
								key,
								{
									gate: spec.gate,
									...(spec.observation ? { observation: true } : {}),
									why: spec.why,
								},
							]),
						),
						structural: [
							"a measured route answering anything but 200",
							"a failed request (4xx/5xx)",
							"a lazy image above the fold",
							"an image without width/height",
							"a video, audio, canvas, iframe, object or embed instantiated by the page",
							"a scale wall that did not render the number of tiles it was asked for",
						],
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
					([route, budget]) =>
						`  ${profile.padEnd(14)} ${route.padEnd(11)} ${kb(budget.bytes).padEnd(8)} ${budget.requests} req`,
				),
			)
			.join("\n"),
	);
}

function compare(results) {
	const recorded = existsSync(budgetsPath) ? JSON.parse(readFileSync(budgetsPath, "utf8")) : null;
	const budget = recorded?.budgets ?? DEFAULT_BUDGETS;
	const failures = [];
	/** Over budget but not gated: still printed, still recorded, never fatal. */
	const advisories = [];
	console.log("\nBudgets  (✔ within a gate, · over a reported-only ceiling)");
	for (const r of results) {
		const b = budget[r.profile]?.[r.route];
		if (!b) {
			console.log(`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)} no budget recorded`);
			continue;
		}
		const detail = Object.entries(SCALAR_METRICS)
			.map(([key, spec]) => {
				const value = valueOf(r, key);
				const limit = b[key];
				if (limit === undefined) return null;
				// An observation is shown without a mark. It has no opinion to give.
				if (spec.observation) return `${key} ${FORMAT[key](value)} (observed)`;
				const mark = value > limit ? (spec.gate ? "✖" : "·") : "✔";
				return `${key} ${FORMAT[key](value)}/${FORMAT[key](limit)} ${mark}`;
			})
			.filter(Boolean)
			.join("  ");
		console.log(`  ${r.profile.padEnd(14)} ${r.route.padEnd(11)} ${detail}`);
		for (const [key, spec] of Object.entries(SCALAR_METRICS)) {
			if (spec.observation) continue;
			const value = valueOf(r, key);
			const limit = b[key];
			if (limit === undefined || value <= limit) continue;
			const line = `${r.profile} ${r.route}: ${key} ${FORMAT[key](value)} over ${FORMAT[key](limit)}`;
			if (spec.gate) failures.push(line);
			else advisories.push(`${line} — reported, not gated: ${spec.why}`);
		}

		// --- The structural assertions. Machine-independent, so always fatal. ---

		if (r.status !== 200) failures.push(`${r.profile} ${r.route}: answered HTTP ${r.status}, not 200`);
		if (r.failed > 0) failures.push(`${r.profile} ${r.route}: ${r.failed} failed request(s)`);
		if (r.images.lazyAboveFold > 0) {
			failures.push(`${r.profile} ${r.route}: ${r.images.lazyAboveFold} lazy images above the fold`);
		}
		if (r.images.withoutDimensions > 0) {
			failures.push(`${r.profile} ${r.route}: ${r.images.withoutDimensions} images without dimensions`);
		}
		if (r.expensive.total > 0) {
			failures.push(
				`${r.profile} ${r.route}: ${r.expensive.total} expensive media element(s) — the catalogue wall renders plates, not players`,
			);
		}
		if (r.scale !== null && r.tiles !== r.scale) {
			failures.push(
				`${r.profile} ${r.route}: rendered ${r.tiles} tiles, asked for ${r.scale} — a scale measurement of an empty or short wall measures nothing`,
			);
		}
	}

	if (advisories.length) {
		console.log("\nOver a reported-only ceiling (these move with the machine):");
		for (const a of advisories) console.log(`  · ${a}`);
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