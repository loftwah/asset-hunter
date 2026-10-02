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
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The public `/gallery` page needs four of those eight as served images.
 *
 * The alternative — a second capture script, or a hand-picked screenshot — is
 * the arrangement #48 forbids: marketing media that is not the product. So
 * these are the *same* captures from the *same* pass, renamed to the names
 * `src/lib/gallery.ts` declares and written to `public/gallery/`.
 *
 * `reference/` keeps its own set because it is a design-review artefact with a
 * different purpose: this half is a page's content, with alt text and a route
 * behind every image, and it is served rather than reviewed.
 */
const GALLERY = [
	{ source: "wall", file: "wall" },
	{ source: "detail", file: "drill-in" },
	{ source: "search", file: "search" },
	{ source: "licensing", file: "licensing" },
	{ source: "wall-mobile", file: "phone" },
];

/** Where the gallery page's images live. Served, so `public/`, not `reference/`. */
const galleryDir = new URL("../public/gallery/", import.meta.url).pathname;

try {
	await fetch(`${baseUrl}/`);
} catch {
	console.error(`✖ no server at ${baseUrl} — start it with \`npm run dev\``);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(galleryDir, { recursive: true });
const browser = await chromium.launch();
const written = [];

/** `name → capture file`, so the gallery half can reuse this pass's bytes. */
const captured = new Map();

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
	const buffer = await page.screenshot({ path: `${outDir}${file}` });
	written.push(file);
	captured.set(shot.name, buffer);
	await page.close();
}

// The gallery half: the same pixels, at the names the page declares. Written
// from this pass's buffer rather than re-screenshotted, so a gallery image and
// the reference capture it came from are byte-identical — a second pass would
// differ by a webfont that finished loading a frame later, and then the page
// would be showing something the design reference does not contain.
for (const { source, file } of GALLERY) {
	const buffer = captured.get(source);
	if (!buffer) {
		console.error(`  ✖ gallery: no capture named "${source}" — nothing captured for it`);
		process.exitCode = 1;
		continue;
	}
	writeFileSync(`${galleryDir}${file}.png`, buffer);
}

// A gallery image left over from a previous run is a stale composition, which is
// worse than no composition — it looks like current evidence and is not.
for (const existing of readdirSync(galleryDir)) {
	if (existing.endsWith(".png") && !GALLERY.some((g) => g.file === existing.replace(/\.png$/, ""))) {
		rmSync(`${galleryDir}${existing}`);
		console.log(`  removed stale gallery/${existing}`);
	}
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
// The gallery is a *copy* of five of these, not new captures, and saying so is
// what keeps "one generator, from the real product" checkable by reading this
// file rather than by trusting it.
console.log(`✔ wrote ${GALLERY.length} gallery image(s) → public/gallery/ (copied, not re-shot)`);
