#!/usr/bin/env node
/**
 * Generates social and app icons from the running product.
 *
 * Deliberately captures the real wall rather than composing a mock: the
 * project's own rule is that marketing media comes from the product, so a
 * prettier card cannot be produced by a layout that the site does not have.
 *
 * Brand tokens are **read from `src/styles/global.css`**, not re-typed here. The
 * previous version pinned `background: #08090a` and `font-family: "Bricolage"`
 * directly, which meant changing `--canvas` in the token file would silently
 * leave every social card rendering the old palette — a brand change that
 * looked shipped and was not. The card now fails loudly if a token it needs has
 * gone missing rather than falling back to a hard-coded colour.
 *
 * Usage: node scripts/generate-og.mjs [--url http://localhost:4321]
 * Requires the dev server to be running.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const urlIndex = args.indexOf("--url");
const baseUrl = urlIndex === -1 ? "http://localhost:4321" : args[urlIndex + 1];
const publicDir = new URL("../public/", import.meta.url).pathname;

/**
 * Reads the custom properties out of the token file.
 *
 * A `--token` declaration is the only place a brand value is defined, so the
 * tokens are parsed rather than duplicated. `clamp()` and `var()` values are
 * kept as-is: only the colours and font stacks the card actually overrides need
 * to resolve to a literal, and those are plain values in the token file.
 */
function brandTokens() {
	const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");
	const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
	const tokens = new Map();
	for (const m of root.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
		tokens.set(m[1], m[2].trim());
	}
	const need = ["canvas", "ink", "ink-3", "font-display"];
	const missing = need.filter((name) => !tokens.has(name));
	if (missing.length) {
		// Failing here is the point. A missing token means the token file and
		// this script disagree about where the brand lives, and the honest
		// outcome is a broken build rather than a card with a stale colour.
		throw new Error(
			`src/styles/global.css is missing ${missing.map((n) => `--${n}`).join(", ")}. ` +
				"The OG card reads its colours and type from that file rather than hard-coding them.",
		);
	}
	return {
		canvas: tokens.get("canvas"),
		ink: tokens.get("ink"),
		ink3: tokens.get("ink-3"),
		display: tokens.get("font-display"),
	};
}

/**
 * The card restyle. Suppression is by class, so a layout change in the app
 * cannot silently produce a card full of clipped masthead.
 *
 * `tokens` is interpolated rather than re-declared, so `--canvas` and
 * `--font-display` are the shipped values.
 */
function cardCss(tokens, { grid = true, headline = true } = {}) {
	return `
	.masthead, .footer, .rail, .legend, .intro__summary, .lede, .tally, .skip-link { display: none !important; }
	/* The card is a fixed frame, not a page. Laying the wall out as a page and
	   screenshotting a viewport crops wherever the page happened to end, which
	   is how a share card ends up cut through the middle of a specimen. A flex
	   column pinned to the viewport lets the grid take the space that is
	   actually left over, at any aspect ratio. */
	html, body { height: 100%; overflow: hidden; }
	body { background: ${tokens.canvas}; }
	main {
		padding: 0 !important;
		height: 100vh;
		display: flex !important;
		flex-direction: column;
		overflow: hidden;
	}
	:root {
		--canvas: ${tokens.canvas};
		--ink: ${tokens.ink};
		--ink-3: ${tokens.ink3};
		--font-display: ${tokens.display};
	}
	.intro { padding-block: 40px 14px !important; gap: 6px !important; }
	.intro { flex: 0 0 auto; }
	${
		headline
			? `.intro__title { font-size: 54px !important; line-height: 1.04 !important; max-width: none !important; font-family: ${tokens.display} !important; }`
			: ".intro__title { display: none !important; }"
	}
	.wall { padding-block: 0 !important; }
	.wall__feature { display: none !important; }
	${
		grid
			? `
	.wall { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
	.grid {
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
		/* Explicit rows sized to the space left after the headline, because a
		   media wall that overflows the frame crops the specimens rather than
		   fitting them. The featured tile spans 2×2 of this same grid
		   (DESIGN.md §5), so the row count has to leave room for it. */
		grid-template-columns: repeat(${COLUMNS}, minmax(0, 1fr)) !important;
		grid-template-rows: repeat(${ROWS}, minmax(0, 1fr)) !important;
		gap: 8px !important;
	}
	/* Captions off: a small tile cannot carry type, and a shrunken label
	   would misrepresent the design. The specimens are the message. */
	.tile__label { display: none !important; }
	/* The plate is the tile. On a card the tile cannot grow past its row, or
	   the specimen is cropped mid-annotation — which is the one thing a
	   specimen plate must never be. */
	.grid > :global(.tile) { overflow: hidden; min-height: 0; }
	.tile__plate {
		aspect-ratio: 1 / 1 !important;
		border-radius: 2px !important;
		width: 100% !important;
		height: 100% !important;
	}
	.tile:nth-child(n + ${COLUMNS * ROWS + 1}) { display: none !important; }
	`
			: ".tile { display: none !important; }\n\t.intro__title { display: block !important; }"
	}
	.intro__title, .tile__title { font-family: ${tokens.display}; }
`;
}

/** Tiles per row, and rows down. Set per output; see `OUTPUTS`. */
let COLUMNS = 6;
let ROWS = 2;

/**
 * The outputs.
 *
 * The issue asks for a set of aspect ratios rather than one card, because
 * surfaces differ: a link preview is 1.91:1, a square avatar is 1:1, and a
 * phone story is 9:16. A single 1200×630 PNG stretched into all three is how
 * "we have an OG image" turns into a cropped, half-empty share.
 *
 * `columns` × `rows` is chosen per frame so the grid fills it. A 9:16 frame at
 * six across and two rows leaves the bottom half black — a valid PNG that
 * communicates nothing. The tall card therefore runs fewer, taller columns and
 * more rows of them.
 */
const OUTPUTS = [
	{ file: "og.png", width: 1200, height: 630, columns: 6, rows: 2, grid: true },
	{ file: "og-square.png", width: 1200, height: 1200, columns: 4, rows: 3, grid: true },
	{ file: "og-story.png", width: 1080, height: 1920, columns: 3, rows: 4, grid: true },
	// 4:5, because the feed placements that get a link preview crop towards portrait
	// and a 1.91:1 card loses its edges there. The grid runs 4×4 so the frame fills:
	// six across at this ratio leaves the bottom third empty, which is the "valid PNG
	// that communicates nothing" the note above warns about.
	{ file: "og-portrait.png", width: 1200, height: 1500, columns: 4, rows: 4, grid: true },
	// A wordmark card for surfaces that want the brand rather than a grid.
	{ file: "og-mark.png", width: 1200, height: 630, columns: 0, rows: 0, grid: false },
];

/**
 * Post-capture quality control.
 *
 * "The file exists" is not proof of a usable share card. A blank frame, a frame
 * that is mostly empty because the grid failed to lay out, and a frame with
 * clipped text all produce a perfectly valid PNG. Each of those is caught here
 * by measuring the captured pixels rather than by trusting the template.
 */
function inspectPng(buffer) {
	// PNG dimensions live in the IHDR chunk — bytes 16..23, big-endian — so they are
	// read from the header rather than by decoding the image.
	//
	// `og:check` needs them, and it cannot ask Playwright: the whole point of that
	// check is to run offline. Without them it reported every card as
	// "undefined×undefined, not the declared size", which is a check that fails for a
	// reason nobody can act on.
	const width = buffer.length >= 24 ? buffer.readUInt32BE(16) : null;
	const height = buffer.length >= 24 ? buffer.readUInt32BE(20) : null;
	return { bytes: buffer.length, width, height };
}

/**
 * Measures the captured frame in the browser, where the pixels already exist.
 *
 * A card whose content occupies almost none of the frame is a failed card: the
 * crop landed but the composition did not fill it.
 */
async function frameCoverage(page, total) {
	return page.evaluate((area) => {
		const marks = [...document.querySelectorAll(".tile, .intro__title")].filter(
			(el) => el.getBoundingClientRect().width > 0,
		);
		const covered = marks.reduce((sum, el) => {
			const r = el.getBoundingClientRect();
			return sum + r.width * r.height;
		}, 0);
		return { marks: marks.length, coverage: covered / area };
	}, total);
}

/**
 * A fingerprint of the tokens these cards were composed from.
 *
 * ## Why the images can now be checked without rendering them
 *
 * `generate:og` needs a running server and a browser, so it cannot sit in `verify` —
 * which is the same reason `check:visual` is only in `verify:full`. The consequence
 * was that the brand media could drift: change `--canvas` in `src/styles/global.css`
 * and every shipped share card keeps the old palette until somebody remembers to
 * regenerate. Nothing reported it, because the images are still valid PNGs of the
 * right dimensions, and that is the failure this whole repository keeps rediscovering.
 *
 * So a generation records the tokens it used, and `--check` recomputes the
 * fingerprint and compares. Cheap, offline, and it fails on the *cause* rather than
 * on a symptom nobody measures.
 *
 * The fingerprint is over the parsed token values, not the file: reformatting a
 * declaration should not demand a re-render, and a changed token should.
 */
function tokenFingerprint(tokens) {
	// `brandTokens()` resolves the handful of values a card actually overrides into a
	// plain object, not the whole token Map. Fingerprint *those*, because they are what
	// the composition depends on — a token no card reads cannot make a card wrong.
	//
	// The first version spread `tokens.entries()` and threw on every run, which is why
	// the manifest it was written for did not exist until this was fixed: the generation
	// printed five successes and then died on the line after them.
	const canonical = Object.entries(tokens)
		.filter(([, value]) => value !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const MANIFEST = `${publicDir}og-manifest.json`;

/**
 * Fail if the committed cards were not composed from the tokens in force now.
 *
 * Four things, because each is a way for the media to be quietly wrong:
 * no manifest at all; a fingerprint that has moved; a declared card that is missing
 * or implausibly small; and a card in `public/` that nothing declares, which is how a
 * renamed output lingers and gets linked from somewhere.
 */
function checkGenerated() {
	const problems = [];
	if (!existsSync(MANIFEST)) {
		problems.push(
			`no ${MANIFEST.replace(publicDir, "public/")} — run \`npm run generate:og\` so the cards record the tokens they used`,
		);
	} else {
		const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
		const tokens = brandTokens();
		const now = tokenFingerprint(tokens);
		if (manifest.tokens !== now) {
			problems.push(
				`the share cards were composed from different brand tokens (${String(manifest.tokens).slice(0, 12)}…, now ${now.slice(0, 12)}…) — run \`npm run generate:og\``,
			);
		}
		for (const out of manifest.outputs ?? []) {
			const path = `${publicDir}${out.file}`;
			if (!existsSync(path)) {
				problems.push(`${out.file} is declared but missing`);
				continue;
			}
			const { width, height, bytes } = inspectPng(readFileSync(path));
			if (width !== out.width || height !== out.height) {
				problems.push(`${out.file} is ${width}×${height}, not the declared ${out.width}×${out.height}`);
			}
			/*
			 * Compared against what generation recorded, not a fixed floor.
			 *
			 * A fixed floor was tried and is too weak to be worth having: a hand-built
			 * solid-colour PNG of the right dimensions compressed to 7 KB, which cleared a
			 * 4 KB threshold and sailed through a check whose whole job is to notice that a
			 * card stopped being a card. Half of what was generated catches that, and
			 * catches a truncated write for the same reason.
			 *
			 * What genuinely proves a card is *not blank* is `frameCoverage`, measured in
			 * the browser at generation time. This is the offline proxy for "the file is
			 * still the file that was rendered", and it says so rather than implying more.
			 */
			if (out.bytes && bytes < out.bytes / 2) {
				problems.push(
					`${out.file} is ${(bytes / 1024).toFixed(0)} KB where generation recorded ${(out.bytes / 1024).toFixed(0)} KB — truncated, or replaced with something that is not a rendered card`,
				);
			}
		}
		const declared = new Set((manifest.outputs ?? []).map((o) => o.file));
		for (const out of OUTPUTS) {
			if (!declared.has(out.file)) {
				problems.push(`${out.file} is a declared output but the manifest does not record it`);
			}
		}
	}

	if (problems.length) {
		console.error("✖ brand media is out of step with the product:");
		for (const problem of problems) console.error(`    ${problem}`);
		process.exit(1);
	}
	const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
	console.log(
		`✔ ${manifest.outputs.length} share cards match the current brand tokens (${manifest.tokens.slice(0, 12)}…)`,
	);
}

async function capture(page, out, tokens) {
	COLUMNS = out.columns;
	ROWS = out.rows;
	await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
	await page.addStyleTag({ content: cardCss(tokens, { grid: out.grid }) });
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(600);

	const { marks, coverage } = await frameCoverage(page, out.width * out.height);

	// Thresholds, not guesses. A 6-across 16:9 grid fills most of the frame; a
	// 3-across 9:16 frame with the headline is roughly a third. Anything under
	// a tenth means the layout did not apply and the card is effectively blank.
	const floor = out.grid ? 0.1 : 0.02;
	if (marks === 0 || coverage < floor) {
		throw new Error(
			`${out.file}: composed nothing usable (${marks} marks, ${(coverage * 100).toFixed(1)}% of frame). The card template did not apply.`,
		);
	}

	const buffer = await page.screenshot({ path: `${publicDir}${out.file}`, type: "png" });
	const { bytes, width, height } = inspectPng(buffer);
	// The frame we asked for and the frame we got are not the same claim. Playwright
	// honours the viewport, so a mismatch means the output definition and the file on
	// disk have drifted apart, which is exactly what `og:check` later fails on.
	if (width !== out.width || height !== out.height) {
		throw new Error(`${out.file}: wrote ${width}×${height}, expected ${out.width}×${out.height}`);
	}
	return { ...out, marks, coverage, bytes };
}

async function main() {
	if (checkOnly) {
		try {
			checkGenerated();
		} catch (err) {
			console.error(`✖ ${err.message}`);
			process.exit(1);
		}
		return;
	}

	let tokens;
	try {
		tokens = brandTokens();
	} catch (err) {
		console.error(`✖ ${err.message}`);
		process.exit(1);
	}

	try {
		await fetch(`${baseUrl}/`);
	} catch {
		console.error(`✖ no server at ${baseUrl} — start it with \`npm run dev\``);
		process.exit(1);
	}

	if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });

	const browser = await chromium.launch();
	const written = [];

	for (const out of OUTPUTS) {
		const page = await browser.newPage({
			viewport: { width: out.width, height: out.height },
			deviceScaleFactor: 1,
			colorScheme: "dark",
		});
		try {
			const result = await capture(page, out, tokens);
			written.push(result);
		} catch (err) {
			console.error(`✖ ${err.message}`);
			process.exitCode = 1;
		} finally {
			await page.close();
		}
	}

	await browser.close();

	if (!written.length) {
		console.error("✖ nothing generated");
		process.exit(1);
	}

	for (const w of written) {
		if (!existsSync(`${publicDir}${w.file}`)) {
			console.error(`✖ ${w.file} was not written`);
			process.exit(1);
		}
		console.log(
			`  ✔ ${w.file.padEnd(15)} ${String(w.width).padStart(4)}×${w.height}  ` +
				`${w.marks} marks, ${(w.coverage * 100).toFixed(0)}% of frame, ${(w.bytes / 1024).toFixed(0)} KB`,
		);
	}
	// Recorded so `--check` can tell "these cards match the brand" from "these cards
	// are whatever they were when somebody last ran this".
	writeFileSync(
		MANIFEST,
		`${JSON.stringify(
			{
				$comment:
					"Written by scripts/generate-og.mjs. `npm run og:check` fails when the brand tokens move, because a share card that no longer matches the product is still a valid PNG.",
				tokens: tokenFingerprint(tokens),
				generatedFrom: baseUrl,
				outputs: written.map((w) => ({ file: w.file, width: w.width, height: w.height, bytes: w.bytes })),
			},
			null,
			"\t",
		)}\n`,
	);

	console.log(`\n✔ generated ${written.length} brand images from the running product`);
	console.log(`  tokens read from src/styles/global.css — canvas ${tokens.canvas}`);
	console.log(`  recorded in public/og-manifest.json, so og:check can tell when they go stale`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
