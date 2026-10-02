/**
 * Responsive, touch and keyboard hardening (#46).
 *
 * These are the live half of #46: `scripts/visual-qa.mjs` measures geometry and
 * the accessibility tree across a viewport matrix, and this file drives the
 * *behaviour* that geometry cannot assert — a filter that follows the URL, an
 * outcome that is actually shown to the reader, a sign-in route that exists when
 * the copy says one is needed.
 *
 * Same three-valued server gate as `routes.test.ts`, for the same reason: a gate
 * that skips because the thing it checks is broken is worse than no gate. The
 * two files share the shape rather than the module because each is a test file
 * `node --test` runs on its own.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

let server = "down";
/** A browser, launched only when there is a server to look at. Playwright is a
 *  heavy dependency and `npm run test:unit` must stay usable on its own. */
let browser: Browser | null = null;

before(async () => {
	try {
		const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
		server = res.ok ? "up" : "broken";
		if (server === "broken") {
			const body = await res.text().catch(() => "");
			const reason = body.match(/"message":"([^"]{0,200})/)?.[1];
			console.error(`✖ ${baseUrl} answered HTTP ${res.status}${reason ? `: ${reason}` : ""}`);
		}
	} catch {
		server = "down";
	}
	// In the same hook rather than a second one: two top-level hooks race the
	// suites that read their results, and the symptom is a suite that skips
	// itself for a reason that is not true.
	if (server === "up") browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
});

/**
 * Runs `fn` against a page at one viewport. Skips only when there is genuinely
 * no server or no browser; a server that answers with an error is a failure, not
 * a skip.
 */
interface ViewOptions {
	/** A coarse pointer: `hasTouch`/`isMobile`, and the tap-target contract. */
	touch?: boolean;
	/** `Page.setFontSizes` at 200% — a reader's enlarged default font size. */
	textScale?: boolean;
	/** Emulate `prefers-reduced-motion: reduce`. */
	reducedMotion?: boolean;
}

type ViewFn = (page: Page, context: BrowserContext) => Promise<void>;

/*
 * `HTMLElement.hidden` is on `HTMLElement`, not on `Element`, so
 * `document.querySelectorAll(".tile")` — which is typed `Element` because the
 * selector is a string — will not let a test read the property the filter
 * actually toggles.
 *
 * This widens the return type of the one selector rather than casting at four
 * call sites. `Tile` is the intersection that is actually true of a
 * `PossibilityTile`: an `<article>` with `hidden` and the `data-vertical` the
 * rail filters on.
 */
interface Tile extends HTMLElement {
	hidden: boolean;
	readonly dataset: DOMStringMap;
}

/**
 * How many tiles the client-side filter is currently showing.
 *
 * **This body is serialised into the page**, so it cannot close over anything at
 * module scope — that is why `Tile` exists as a type only and why this is a
 * single self-contained function rather than a call to a helper. It reads
 * `hidden`, which the wall's script is what sets.
 */
const VISIBLE_TILES_IN_PAGE = (): number =>
	[...document.querySelectorAll<HTMLElement>(".tile")].filter(
		(tile) => !(tile as Tile).hidden,
	).length;

function view(
	name: string,
	width: number,
	height: number,
	fn: ViewFn,
	opts: ViewOptions = {},
) {
	test(name, async (t) => {
		if (server === "down") {
			t.skip(`no server at ${baseUrl} — start with \`npm run dev\``);
			return;
		}
		if (server === "broken") {
			assert.fail(
				`${baseUrl} is running but not serving (see the message above). Fix the server before reading anything else here.`,
			);
		}
		if (!browser) {
			t.skip("no browser available");
			return;
		}
		const context = await browser.newContext({
			viewport: { width, height },
			locale: "en-GB",
			timezoneId: "UTC",
			colorScheme: "dark",
			...(opts.touch ? { hasTouch: true, isMobile: true } : {}),
			...(opts.reducedMotion ? { reducedMotion: "reduce" } : {}),
		});
		const page = await context.newPage();
		try {
			if (opts.textScale) {
				const cdp = await context.newCDPSession(page);
				await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 28 } });
			}
			await fn(page, context);
		} finally {
			await context.close();
		}
	});
}

describe("the filter rail", () => {
	view(
		"the rail sticks below the masthead, not behind it",
		390,
		844,
		async (page) => {
			await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
			// A full-page screenshot cannot show this: Chromium lays sticky
			// elements out at their unscrolled position, so the rail renders
			// perfectly in a capture and is broken in the browser.
			await page.evaluate(() => scrollTo({ top: 900, behavior: "instant" }));
			await page.waitForTimeout(150);
			const clash = await page.evaluate(() => {
				const masthead = document.querySelector(".masthead");
				const rail = document.querySelector(".rail");
				if (!masthead || !rail) return null;
				const header = masthead.getBoundingClientRect();
				const stuck = rail.getBoundingClientRect();
				const overlapY =
					Math.min(header.bottom, stuck.bottom) - Math.max(header.top, stuck.top);
				return {
					overlap: Math.round(overlapY),
					mastheadZ: Number.parseInt(getComputedStyle(masthead).zIndex, 10),
					railTop: Math.round(stuck.top),
					headerBottom: Math.round(header.bottom),
				};
			});
			assert.ok(clash, "the wall has no masthead or no filter rail");
			// It used to sit 30px under the header at every width below 1280.
			assert.ok(
				clash.overlap <= 1,
				`the rail overlaps the masthead by ${clash.overlap}px once stuck (rail top ${clash.railTop}, header bottom ${clash.headerBottom})`,
			);
		},
		{ touch: true },
	);

	view(
		"choosing a vertical moves the selected state onto the chip that was chosen",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
			const active = () =>
				page.evaluate(() =>
					[...document.querySelectorAll(".chip")]
						.filter((chip) => chip.getAttribute("aria-current") === "true")
						.map((chip) => chip.getAttribute("data-vertical")),
				);
			assert.deepEqual(await active(), [""], "the wall opens on the whole catalogue");
			await page.click('.chip[data-vertical="games"]');
			await page.waitForTimeout(150);
			// The defect: the tiles filtered, the URL changed, and the rail still
			// said "All" was selected — in the pixels and in the accessibility tree.
			assert.deepEqual(await active(), ["games"]);
			const visible = await page.evaluate(VISIBLE_TILES_IN_PAGE);
			assert.ok(visible > 0 && visible < 24, `expected a subset, got ${visible}`);
			assert.equal(new URL(page.url()).searchParams.get("vertical"), "games");
		},
	);

	view(
		"the filtered count is announced rather than only drawn",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
			const status = page.locator("[data-filter-status]");
			assert.equal(await status.count(), 1, "the wall has no live region for its own filter");
			assert.equal(await status.getAttribute("role"), "status");
			await page.click('.chip[data-vertical="games"]');
			await page.waitForTimeout(150);
			const said = (await status.textContent()) ?? "";
			const visible = await page.evaluate(VISIBLE_TILES_IN_PAGE);
			// The number it announces has to be the number on screen, or it is
			// worse than silence.
			assert.match(said, new RegExp(`Showing ${visible} possibilit`));
			assert.match(said, /Games/);
		},
	);

	view(
		"back and forward put the tiles back, because the URL is the filter",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
			const visible = () => page.evaluate(VISIBLE_TILES_IN_PAGE);
			const all = await visible();
			await page.click('.chip[data-vertical="games"]');
			await page.waitForTimeout(150);
			await page.goBack();
			await page.waitForTimeout(300);
			// It used to stay filtered: three of twenty-four tiles under an
			// unfiltered URL, with no reload in sight.
			assert.equal(new URL(page.url()).searchParams.get("vertical"), null);
			assert.equal(await visible(), all, "Back did not restore the unfiltered wall");
			await page.goForward();
			await page.waitForTimeout(300);
			assert.equal(new URL(page.url()).searchParams.get("vertical"), "games");
			assert.equal(await visible(), 3);
		},
	);

	view(
		"a deep link reconciles with the DOM it lands on",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/?vertical=shaders`, { waitUntil: "networkidle" });
			const shown = await page.evaluate(() => ({
				visible: (() =>
					[...document.querySelectorAll<HTMLElement>(".tile")].filter(
						(tile) => !(tile as Tile).hidden,
					).length)(),
				current: [...document.querySelectorAll(".chip")]
					.filter((c) => c.getAttribute("aria-current") === "true")
					.map((c) => c.getAttribute("data-vertical")),
				status: document.querySelector("[data-filter-status]")?.textContent ?? "",
			}));
			assert.equal(shown.current[0], "shaders", "the rail disagrees with its own URL");
			assert.match(shown.status, /Shaders/);
		},
	);
});

describe("the drill-in on a short landscape viewport", () => {
	// 844×390 and 932×430 are where a phone is actually held sideways. The
	// sticky plate was the failure: 471–491px of specimen in a 414–430px
	// viewport, so 129–133px of it was off screen at every scroll offset.
	//
	// The rule is about *stickiness*, not about fitting. A tall image in a short
	// viewport is fine — the reader scrolls it. What is not fine is a sticky
	// element taller than the viewport it sticks to, because then its own bottom
	// edge has no scroll position that brings it into view.
	for (const [width, height] of [
		[844, 390],
		[932, 430],
	]) {
		view(
			`nothing is stuck that cannot fit in ${width}×${height}`,
			width,
			height,
			async (page) => {
				await page.goto(`${baseUrl}/possibilities/density-gradient`, {
					waitUntil: "networkidle",
				});
				const stuck = await page.evaluate(() =>
					[...document.querySelectorAll("body *")]
						.filter((el) => getComputedStyle(el).position === "sticky")
						.map((el) => {
							const r = el.getBoundingClientRect();
							return {
								name: (el.className || "").toString().split(" ")[0] || el.tagName,
								height: Math.round(r.height),
								viewport: innerHeight,
							};
						})
						.filter((s) => s.height > s.viewport),
				);
				assert.deepEqual(
					stuck,
					[],
					`at ${width}×${height} something is stuck and taller than the viewport: ${JSON.stringify(stuck)}`,
				);
			},
			{ touch: true },
		);
	}

	view(
		"the specimen itself is reachable end to end at 932×430",
		932,
		430,
		async (page) => {
			await page.goto(`${baseUrl}/possibilities/density-gradient`, {
				waitUntil: "networkidle",
			});
			// Proven by scrolling rather than by arithmetic: at some offset the top
			// of the plate is on screen, and at some later offset its bottom is.
			// The old sticky rule satisfied the first and failed the second
			// permanently.
			const sweep = await page.evaluate(async () => {
				const plate = document.querySelector<HTMLElement>(".plate img");
				if (!plate) return { missing: true, sawTop: false, sawBottom: false, viewport: innerHeight };
				const page_ = document.documentElement;
				const step = Math.max(60, Math.round(innerHeight * 0.5));
				let sawTop = false;
				let sawBottom = false;
				for (let y = 0; y <= page_.scrollHeight - innerHeight; y += step) {
					scrollTo({ top: y, behavior: "instant" });
					await new Promise((r) => requestAnimationFrame(r));
					const r = plate.getBoundingClientRect();
					if (r.top >= 0 && r.top < innerHeight) sawTop = true;
					if (r.bottom > 0 && r.bottom <= innerHeight) sawBottom = true;
					if (sawTop && sawBottom) break;
				}
				return { missing: false, sawTop, sawBottom, viewport: innerHeight };
			});
			assert.equal(sweep.missing, false, "the drill-in has no specimen plate");
			assert.ok(sweep.sawTop, "the top of the specimen never came into view");
			assert.ok(
				sweep.sawBottom,
				`the bottom of the specimen never came into view in a ${sweep.viewport}px viewport — it is taller than the window and stuck`,
			);
		},
		{ touch: true },
	);

	view(
		"and it still sticks when there is room for it",
		1280,
		900,
		async (page) => {
			// The other half of the same rule: the fix must not have removed the
			// behaviour that makes a long drill-in pleasant on a desktop.
			await page.goto(`${baseUrl}/possibilities/density-gradient`, {
				waitUntil: "networkidle" });
			const position = await page.evaluate(() => {
				const plate = document.querySelector(".plate");
				return plate ? getComputedStyle(plate).position : null;
			});
			assert.equal(position, "sticky");
		},
	);
});

/**
 * The selection page's plate (#64).
 *
 * `/use/<slug>` was the one surface on the site where the specimen was neither
 * readable nor on screen: it rendered its only image at 104–128px — a plate
 * authored at 800px with 13px annotations lands at 1.7px there — and started it
 * at 124–149% of the fold. `DESIGN.md` §6 and §9.6 own the two numbers, and
 * `scripts/visual-qa.mjs` gates them; these are the behavioural halves, which
 * measure the same things in the browser and fail here rather than in a
 * screenshot nobody diffs.
 */
describe("the selection page is media-first", () => {
	const use = "/use/density-gradient";

	view(
		"the plate is the largest thing on the page, and big enough to read",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}${use}`, { waitUntil: "networkidle" });
			const read = await page.evaluate(() => {
				const plate = document.querySelector<HTMLImageElement>(".plate img");
				if (!plate) {
					return {
						missing: true,
						width: 0,
						height: 0,
						intrinsic: 0,
						top: 0,
						viewport: window.innerHeight,
						images: 0,
						h1Height: 0,
						ledeHeight: 0,
						tallestType: 0,
					};
				}
				const box = plate.getBoundingClientRect();
				const h1 = document.querySelector<HTMLElement>("h1");
				const lede = document.querySelector<HTMLElement>(".lede");
				const textHeight = (el: HTMLElement | null) =>
					el ? Math.round(el.getBoundingClientRect().height) : 0;
				return {
					missing: false,
					width: Math.round(box.width),
					height: Math.round(box.height),
					intrinsic: plate.naturalWidth,
					top: Math.round(box.top),
					viewport: window.innerHeight,
					images: document.images.length,
					h1Height: textHeight(h1),
					ledeHeight: textHeight(lede),
					tallestType: Math.max(textHeight(h1), textHeight(lede)),
				};
			});
			assert.equal(read.missing, false, "the use page rendered no plate at all");
			// The floor `DESIGN.md` §9.6 states and `check:visual` gates: 0.7 of the
			// authored 800px, so a 13px plate annotation lands at 9px or more.
			assert.ok(
				read.width >= 560,
				`the plate rendered ${read.width}px wide, under the 560px floor — a 13px annotation lands at ${((read.width / 800) * 13).toFixed(1)}px`,
			);
			assert.equal(read.width / read.intrinsic >= 0.7, true, "the plate is under 0.7 of its authored width");
			assert.equal(read.images, 1, `the page rendered ${read.images} images for one example`);
			/*
			 * "The visual focus", measured as geometry rather than as taste: the
			 * specimen is taller than the page's own headline and lede, so the
			 * biggest thing a reader lands on is the thing §1.1 calls the content.
			 * Full-width section containers are not counted here — they are layout,
			 * and the plate is beside them, never inside one.
			 */
			assert.ok(
				read.height > read.tallestType,
				`the plate is ${read.height}px tall and the tallest type block is ${read.tallestType}px (h1 ${read.h1Height}px, lede ${read.ledeHeight}px)`,
			);
			// And it is on screen, not below the header (`DESIGN.md` §5b).
			assert.ok(
				read.top <= read.viewport * 0.75,
				`the plate starts ${read.top}px down in a ${read.viewport}px viewport`,
			);
		},
	);

	view(
		"the plate is inside the first viewport on a phone",
		390,
		844,
		async (page) => {
			await page.goto(`${baseUrl}${use}`, { waitUntil: "networkidle" });
			const read = await page.evaluate(() => {
				const plate = document.querySelector<HTMLImageElement>(".plate img");
				if (!plate) {
					return { missing: true, top: 0, width: 0, viewport: window.innerHeight, images: 0 };
				}
				const box = plate.getBoundingClientRect();
				return {
					missing: false,
					top: Math.round(box.top),
					width: Math.round(box.width),
					viewport: window.innerHeight,
					images: document.images.length,
				};
			});
			assert.equal(read.missing, false);
			assert.ok(
				read.top <= read.viewport * 0.75,
				`the plate starts ${read.top}px down in a ${read.viewport}px viewport — the header is the page again`,
			);
			// The wall's tile is 160px wide at this viewport; anything near that is
			// the defect #64 reports as a texture.
			assert.ok(read.width >= 320, `the plate is ${read.width}px wide at 390px`);
			// One file, one plate: this entry's example preview *is* the
			// representative plate, so showing it again in the row would be the same
			// image twice at two sizes.
			assert.equal(read.images, 1, `the page rendered ${read.images} images for one example`);
		},
	);

	view(
		"the four use states are answered in words, with their counts",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}${use}`, { waitUntil: "networkidle" });
			const read = await page.evaluate(() => {
				const rows = [...document.querySelectorAll<HTMLElement>(".states__row")];
				return {
					rows: rows.length,
					states: rows.map((row) => ({
						state: row.dataset.useState ?? "",
						label: (row.querySelector("dt")?.textContent ?? "").trim(),
						count: (row.querySelector("dd")?.textContent ?? "").trim(),
						ring: row.querySelector(".states__ring") !== null,
						// Every row states its colour, so the count is never the only
						// thing a greyscale reader has.
						ringColour: row.style.getPropertyValue("--c"),
					})),
					blocks: document.querySelectorAll(".use[data-use-state]").length,
					labels: [...document.querySelectorAll(".use__label")].map((el) =>
						(el.textContent ?? "").trim(),
					),
				};
			});
			// All four, worst first, each with a ring beside a real count.
			assert.equal(read.rows, 4);
			assert.deepEqual(
				read.states.map((s) => s.state),
				["reference-only", "review-required", "reusable-with-attribution", "reusable"],
			);
			for (const row of read.states) {
				assert.ok(row.label.length > 0, `${row.state} has no label in words`);
				assert.match(row.count, /^\d+$/, `${row.state} count reads ${JSON.stringify(row.count)}`);
				assert.equal(row.ring, true, `${row.state} has no ring beside its label`);
				assert.ok(row.ringColour.length > 0, `${row.state} has no colour token`);
			}
			// And the per-example decision still leads with the state in words.
			assert.equal(read.blocks, read.labels.length);
			assert.deepEqual(read.labels, ["Reference only"]);
		},
	);

	view(
		"nothing on the selection page is stuck and taller than the window",
		1024,
		768,
		async (page) => {
			// The one viewport where a full-width plate (827px) is taller than the
			// window. A sticky plate there would park its top and hide its own bottom
			// permanently — which is what `check:visual` reported while this page's
			// plate was still marked sticky.
			await page.goto(`${baseUrl}${use}`, { waitUntil: "networkidle" });
			const stuck = await page.evaluate(() =>
				[...document.querySelectorAll<HTMLElement>("body *")]
					.filter((el) => getComputedStyle(el).position === "sticky")
					.map((el) => ({
						name: (el.className || "").toString().split(" ")[0] || el.tagName,
						height: Math.round(el.getBoundingClientRect().height),
						viewport: window.innerHeight,
					}))
					.filter((s) => s.height > s.viewport),
			);
			assert.deepEqual(stuck, [], JSON.stringify(stuck));
		},
	);
});

describe("enlarged text", () => {
	view(
		"200% of the default font size does not give the page a sideways scroll",
		1280,
		800,
		async (page) => {
			const wide = [];
			for (const path of [
				"/",
				"/possibilities/density-gradient",
				"/use/density-gradient",
				"/search?q=seam",
				"/board",
				"/collections",
			]) {
				await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
				await page.waitForTimeout(150);
				const r = await page.evaluate(() => ({
					scroll: document.documentElement.scrollWidth,
					client: document.documentElement.clientWidth,
					root: getComputedStyle(document.documentElement).fontSize,
				}));
				assert.equal(r.root, "32px", `the font scale did not apply on ${path}`);
				assert.ok(
					r.scroll <= r.client + 1,
					`${path} scrolls sideways at 200% text: ${r.scroll}px of content in ${r.client}px`,
				);
				wide.push(path);
			}
			assert.ok(wide.length >= 6);
		},
		{ textScale: true },
	);

	view(
		"the primary action and the media label survive 200% text",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/possibilities/density-gradient`, {
				waitUntil: "networkidle",
			});
			await page.waitForTimeout(150);
			const ok = await page.evaluate(() => {
				const plate = document.querySelector(".plate img");
				const heading = document.querySelector("h1");
				return {
					plateWidth: plate ? Math.round(plate.getBoundingClientRect().width) : 0,
					headingVisible: heading ? heading.getBoundingClientRect().height > 0 : false,
					scroll: document.documentElement.scrollWidth,
					client: document.documentElement.clientWidth,
				};
			});
			// The media must still be a plate and not a strip.
			assert.ok(ok.plateWidth > 200, `the specimen collapsed to ${ok.plateWidth}px wide at 200% text`);
			assert.ok(ok.headingVisible);
			assert.ok(ok.scroll <= ok.client + 1);
		},
		{ textScale: true },
	);
});

describe("every POST answers", () => {
	view(
		"a rating refusal is shown, in the words the endpoint wrote",
		1280,
		800,
		async (page) => {
			// The endpoint composes a sentence for every branch and redirects with
			// it in `?note=`. Nothing read it back: a refused rating, a failed one
			// and a successful one all looked identical.
			const response = await page.context().request.post(`${baseUrl}/api/signal`, {
				form: {
					intent: "rate",
					subject_type: "possibility",
					subject_slug: "density-gradient",
					stars: "5",
					back: "/possibilities/density-gradient",
				},
				maxRedirects: 0,
			});
			const location = response.headers().location ?? "";
			assert.ok(location.includes("note="), `no note in the redirect: ${location}`);
			const target = new URL(location, baseUrl);
			await page.goto(target.href, { waitUntil: "networkidle" });
			const flash = page.locator(".flash").first();
			assert.equal(await flash.count(), 1, "the drill-in shows nothing about the outcome");
			assert.equal(await flash.getAttribute("role"), "alert", "a refusal is not polite news");
			const said = (await flash.textContent()) ?? "";
			assert.match(said, /Sign in to rate/, `the sentence the endpoint wrote was lost: ${said}`);
		},
	);

	view(
		"a successful rating is shown too",
		1280,
		800,
		async (page) => {
			await page.goto(
				`${baseUrl}/possibilities/density-gradient?note=${encodeURIComponent("Rating recorded")}`,
				{ waitUntil: "networkidle" },
			);
			const flash = page.locator(".flash").first();
			assert.equal(await flash.getAttribute("role"), "status");
			assert.match((await flash.textContent()) ?? "", /Rating recorded/);
		},
	);

	view(
		"saving, unsaving and clearing each say something different",
		1280,
		800,
		async (page) => {
			const post = async (form: Record<string, string>) => {
				const res = await page.context().request.post(`${baseUrl}/api/board`, {
					form,
					maxRedirects: 0,
				});
				return new URL(res.headers().location ?? "", baseUrl);
			};
			// One `?saved=` for every action was what made unsave and clear silent.
			const saved = await post({
				action: "save",
				slug: "density-gradient",
				board: "default",
				back: "/",
			});
			const unsaved = await post({
				action: "unsave",
				slug: "density-gradient",
				board: "default",
				back: "/",
			});
			const cleared = await post({ action: "clear", board: "default", back: "/board" });
			assert.equal(saved.searchParams.get("saved"), "density-gradient");
			assert.equal(unsaved.searchParams.get("unsaved"), "density-gradient");
			assert.equal(cleared.searchParams.get("cleared"), "1");

			const cases: [URL, RegExp][] = [
				[saved, /Kept on your shortlist/],
				[unsaved, /Removed from your shortlist/],
				[cleared, /empty/],
			];
			for (const [url, expected] of cases) {
				await page.goto(url.href, { waitUntil: "networkidle" });
				const said = (await page.locator(".flash").first().textContent()) ?? "";
				assert.match(said, expected, `no answer for ${url.pathname}${url.search}`);
			}
		},
	);

	view(
		"clearing a board asks first, because there is no undo",
		1280,
		800,
		async (page: Page, context) => {
			await context.addCookies([
				{
					name: "ah_board",
					value: encodeURIComponent(
						JSON.stringify({ default: ["density-gradient", "crowd-fluid"] }),
					),
					url: baseUrl,
				},
			]);
			await page.goto(`${baseUrl}/board`, { waitUntil: "networkidle" });
			// One press of a link that looks like the other linkish buttons used
			// to empty a reader's list irreversibly. `count()` is DOM presence, so
			// the question is whether it is *reachable* before the disclosure opens.
			const confirm = page.locator("form.clear button[type=submit]");
			assert.equal(
				await confirm.isVisible(),
				false,
				"the destructive button is reachable without opening the disclosure",
			);
			await page.locator("form.clear summary").click();
			await page.waitForTimeout(100);
			assert.equal(await confirm.count(), 1, "the disclosure has no confirm button");
			assert.ok(await confirm.isVisible(), "the confirm button did not appear");
			assert.match((await confirm.textContent()) ?? "", /empty this board/i);
		},
	);
});

describe("the unauthorised state", () => {
	view(
		"the copy that says signing in is required also says where",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/possibilities/density-gradient`, {
				waitUntil: "networkidle",
			});
			const notes = await page.evaluate(() =>
				[...document.querySelectorAll(".signal__note")]
					.map((n) => n.textContent?.replace(/\s+/g, " ").trim() ?? "")
					.filter((t) => /signing in is required|needs a sign-in/i.test(t)),
			);
			assert.ok(notes.length >= 2, `expected both refusals to be present, got ${notes.length}`);
			const links = await page.evaluate(() =>
				[...document.querySelectorAll(".signal__note")]
					.map((n) => n.querySelector("a")?.getAttribute("href") ?? "")
					.filter(Boolean),
			);
			// A refusal with no route is the keyboard journey failing at its last
			// step: a reader told to sign in and given nowhere to go.
			for (const note of notes) {
				assert.match(note, /Sign in/);
			}
			assert.ok(
				links.includes("/_emdash/admin"),
				`no sign-in route in the refusal: ${JSON.stringify(links)}`,
			);
		},
	);

	view(
		"the sign-in route is EmDash's own and it answers",
		1280,
		800,
		async (page) => {
			const res = await page.context().request.get(`${baseUrl}/_emdash/admin`, {
				maxRedirects: 0,
			});
			// 200 = the admin, 302 = EmDash's sign-in screen. Either is the entry
			// point; a 404 would mean the link is a dead end, which is what the
			// refusal note used to be.
			assert.ok(
				[200, 302].includes(res.status()),
				`/_emdash/admin answered ${res.status()}`,
			);
		},
	);
});

describe("the accessibility tree", () => {
	view(
		"a tile link does not announce its own title twice",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
			const snapshot = await page.locator(".tile__link").first().ariaSnapshot();
			const name = /link "([^"]+)"/.exec(snapshot)?.[1] ?? "";
			assert.ok(name.length > 0, `could not read a link name from: ${snapshot}`);
			const title = await page.evaluate(
				() => document.querySelector(".tile__title")?.textContent?.trim() ?? "",
			);
			const occurrences = name.split(title).length - 1;
			assert.equal(
				occurrences,
				1,
				`"${title}" appears ${occurrences} times in its own link name: ${name}`,
			);
		},
	);

	view(
		"the plate keeps its tagline for anyone not looking at it",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
			const taglines = await page.evaluate(() => {
				const tile = document.querySelector(".tile");
				if (!tile) return { fromAlt: null, hidden: null };
				return {
					fromAlt: tile.querySelector("img")?.getAttribute("alt") ?? null,
					hidden: tile.querySelector(".visually-hidden")?.textContent?.trim() ?? null,
				};
			});
			// The plate is a decorative cover of a link that already names the
			// entry, so its alt is empty — and the tagline it used to carry is
			// still in the tree.
			assert.equal(taglines.fromAlt, "");
			assert.ok(taglines.hidden, "the tagline was dropped with the alt text");
		},
	);

	view(
		"the drill-in's plate is a captioned figure, not a bare image",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/possibilities/density-gradient`, {
				waitUntil: "networkidle",
			});
			const snapshot = await page.locator(".plate").first().ariaSnapshot();
			assert.match(snapshot, /img "[^"]{10,}"/, `the figure has no described image: ${snapshot}`);
			assert.match(snapshot, /reference plate/, "the caption that names it a reference is missing");
			// And the separator has a space in front of it, which it did not.
			const caption = (await page.locator(".plate figcaption").first().innerText()) ?? "";
			assert.doesNotMatch(caption, /specimen·/, `caption is welded to its separator: "${caption}"`);
		},
	);

	view(
		"every nav landmark on a page is named, so two of them can be told apart",
		1280,
		800,
		async (page) => {
			for (const path of ["/", "/possibilities/density-gradient", "/verticals", "/pages/licensing"]) {
				await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
				const navs = await page.evaluate(() =>
					[...document.querySelectorAll("nav")].map((nav) => {
						const labelled = nav.getAttribute("aria-label");
						const id = nav.getAttribute("aria-labelledby");
						const title = id ? document.getElementById(id)?.textContent?.trim() : null;
						return labelled ?? title ?? "";
					}),
				);
				for (const name of navs) {
					assert.ok(name, `${path} has an unnamed <nav>`);
				}
			}
		},
	);

	view(
		"every control that changes state reports it",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
			const pressed = await page.evaluate(() => {
				const button = document.querySelector(".save__button");
				return button?.getAttribute("aria-pressed") ?? null;
			});
			// The save control is a toggle that navigates, so its state has to be
			// in the tree rather than in the glyph.
			assert.ok(pressed !== null, "the save control does not report its state");
			assert.ok(["true", "false"].includes(pressed), `aria-pressed is "${pressed}"`);
		},
	);
});

describe("motion and media", () => {
	view(
		"nothing on the catalogue plays by itself",
		1280,
		800,
		async (page) => {
			for (const path of ["/", "/possibilities/density-gradient", "/collections", "/search?q=seam"]) {
				await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
				const found = await page.evaluate(() => ({
					playing: [...document.querySelectorAll("video,audio")].filter(
						(el) => !(el as HTMLMediaElement).paused,
					).length,
					autoplay: document.querySelectorAll("[autoplay]").length,
				}));
				assert.equal(found.playing, 0, `${path} is playing media`);
				assert.equal(found.autoplay, 0, `${path} autoplays something`);
			}
		},
	);

	view(
		"reduced motion collapses every transition the wall has",
		1280,
		800,
		async (page) => {
			await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
			const moving = await page.evaluate(() =>
				[...document.querySelectorAll(".tile__plate,.chip,.nav__link,.save__button,.masthead")]
					.map((el) => ({
						cls: (el.className || "").toString().split(" ")[0],
						duration: getComputedStyle(el).transitionDuration,
					}))
					.filter((e) => e.duration.split(",").some((d) => Number.parseFloat(d) > 0.02)),
			);
			assert.deepEqual(
				moving.slice(0, 4),
				[],
				`still transitioning under \`prefers-reduced-motion: reduce\`: ${JSON.stringify(moving.slice(0, 4))}`,
			);
			const behaviour = await page.evaluate(
				() => getComputedStyle(document.documentElement).scrollBehavior,
			);
			assert.equal(behaviour, "auto", "smooth scrolling survives reduced motion");
		},
		{ reducedMotion: true },
	);
});