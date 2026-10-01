#!/usr/bin/env node
/**
 * Captures the reference compositions checked into `reference/`.
 *
 * Deliberately separate from visual-qa: that script sweeps the whole route ×
 * viewport matrix and its output is disposable. This captures a small, stable
 * set of the real product at the two widths that matter, for comparing against
 * DESIGN.md when making a design change.
 *
 * Usage: node scripts/capture-reference.mjs [--url http://localhost:4321]
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const baseUrl = args[args.indexOf("--url") + 1] ?? "http://localhost:4321";
const outDir = new URL("../reference/", import.meta.url).pathname;

const SHOTS = [
	{ path: "/", name: "wall", viewport: { width: 1280, height: 860 }, dsf: 1 },
	{ path: "/possibilities/density-gradient", name: "detail", viewport: { width: 1280, height: 860 }, dsf: 1 },
	{ path: "/verticals", name: "verticals", viewport: { width: 1280, height: 860 }, dsf: 1 },
	{ path: "/collections", name: "collections", viewport: { width: 1280, height: 860 }, dsf: 1 },
	{ path: "/search?q=seam", name: "search", viewport: { width: 1280, height: 860 }, dsf: 1 },
	{ path: "/pages/licensing", name: "licensing", viewport: { width: 1280, height: 860 }, dsf: 1 },
	{ path: "/nope", name: "404", viewport: { width: 1280, height: 860 }, dsf: 1, expect404: true },
	// The fold check: what a phone sees before scrolling.
	{ path: "/", name: "wall-mobile", viewport: { width: 390, height: 844 }, dsf: 2, mobile: true },
];

try {
	await fetch(`${baseUrl}/`);
} catch {
	console.error(`✖ no server at ${baseUrl} — start it with \`npm run dev\``);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const written = [];

for (const shot of SHOTS) {
	const page = await browser.newPage({
		viewport: shot.viewport,
		deviceScaleFactor: shot.dsf ?? 1,
		colorScheme: "dark",
		...(shot.mobile ? { isMobile: true, hasTouch: true } : {}),
	});
	const res = await page.goto(`${baseUrl}${shot.path}`, { waitUntil: "networkidle" });
	const status = res?.status() ?? 0;
	// A 404 page is a real composition worth reviewing, so it is captured
	// rather than skipped — the point of this directory is what the product
	// looks like, and "what the product looks like when it has no answer"
	// is part of that.
	if (!res || (status >= 400 && !shot.expect404)) {
		console.error(`  ✖ ${shot.path} → HTTP ${status}`);
		await page.close();
		continue;
	}
	// Wait for webfonts so the headline is captured in the real face, not a
	// fallback that changes the apparent weight and line breaks.
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(350);
	const file = `${shot.name}--${shot.viewport.width}.png`;
	await page.screenshot({ path: `${outDir}${file}` });
	written.push(file);
	await page.close();
}

// Anything left over from a previous run is a stale composition, which is worse
// than no composition: it looks like current evidence and is not.
for (const stale of readdirSync(outDir)) {
	if (stale.endsWith(".png") && !written.includes(stale)) {
		rmSync(`${outDir}${stale}`);
		console.log(`  removed stale ${stale}`);
	}
}

await browser.close();
console.log(`✔ captured ${written.length} reference composition(s) → reference/`);
for (const file of written) console.log(`  ${file}`);
