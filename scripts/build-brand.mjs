#!/usr/bin/env node
/**
 * Generates every committed brand asset from `src/lib/brand/`.
 *
 * The mark used to exist twice — inline in `Wordmark.astro` and hand-drawn in
 * `public/favicon.svg` — and the copies drifted, which is why the committed
 * `apple-touch-icon.png` had quietly lost the inner ring. This script exists so
 * that the second copy cannot be maintained by hand: the geometry lives in
 * `src/lib/brand/mark.ts`, the file list in `src/lib/brand/assets.ts`, and this
 * script only writes bytes.
 *
 * `--check` re-generates everything in memory and compares it with what is
 * committed, so it is a drift check rather than a formatting lint. It also
 * measures the raster icons against a fresh render, because "the PNG exists" is
 * not evidence that the PNG still shows the mark.
 *
 * Usage:
 *   node scripts/build-brand.mjs            # write brand/ and the icon set
 *   node scripts/build-brand.mjs --check    # verify committed bytes + pixels
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { BRAND_ICONS, BRAND_SVGS, MASKABLE_SCALE } from "../src/lib/brand/assets.ts";
import { clearSpaceSvg, markSvg } from "../src/lib/brand/mark.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const verbose = process.argv.includes("--verbose");

/** The vector behind each raster icon: an SVG document string plus its pixel size. */
function iconSvg({ size, detail, ink, ground, maskable }) {
	return markSvg({
		detail,
		ink,
		ground,
		size,
		label: "Asset Hunter",
		...(maskable ? { scale: MASKABLE_SCALE } : {}),
	});
}

function brandSvg({ file, label, kind, detail, ink, ground, size, maskable }) {
	if (kind === "diagram") return clearSpaceSvg(label);
	return markSvg({
		detail,
		ink,
		ground,
		size,
		label,
		...(maskable ? { scale: MASKABLE_SCALE } : {}),
	});
}

/**
 * Rasterises an SVG string at `size`×`size` and returns PNG bytes.
 *
 * Rendered in Chromium — the same engine that will draw the icon — so the
 * antialiasing is the antialiasing a reader gets. Playwright is already a
 * dependency for `check:plates` and `check:visual`, and adding a rasteriser to
 * do this would be a dependency bought for one file format.
 */
async function rasterise(page, svg, size) {
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(
		`<!doctype html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">${svg}</body>`,
	);
	return await page.screenshot({ omitBackground: false, type: "png" });
}

/**
 * Pixels of a PNG, decoded in the browser via a canvas.
 *
 * A PNG's own bytes are not comparable across machines — the same vector
 * antialiases slightly differently on a different Chromium — so `--check`
 * compares the committed PNG with a *fresh local render of the same vector* and
 * tolerates that jitter. A missing ring is a large fraction of the icon, so it
 * cannot hide inside the tolerance; the previous drift (no inner ring) would
 * have failed this check by a wide margin.
 */
async function pixelsOf(page, buffer) {
	await page.setViewportSize({ width: 8, height: 8 });
	await page.setContent("<!doctype html><body></body>");
	return await page.evaluate(async (bytes) => {
		const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
		const bitmap = await createImageBitmap(blob);
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(bitmap, 0, 0);
		const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		let lit = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) lit += 1;
		}
		return { width: bitmap.width, height: bitmap.height, data: [...data], lit };
	}, [...buffer]);
}

/**
 * Mean and worst-case per-channel disagreement between two RGBA buffers of the
 * same size. Both are rendered locally, so this compares the committed raster
 * with a current one and not against a golden file from another machine.
 */
function difference(a, b) {
	if (a.width !== b.width || a.height !== b.height) {
		return { mean: 255, differing: 1 };
	}
	let total = 0;
	let differing = 0;
	for (let i = 0; i < a.data.length; i += 4) {
		const d =
			Math.abs(a.data[i] - b.data[i]) +
			Math.abs(a.data[i + 1] - b.data[i + 1]) +
			Math.abs(a.data[i + 2] - b.data[i + 2]);
		total += d / 3;
		if (d / 3 > 24) differing += 1;
	}
	const pixels = a.data.length / 4;
	return { mean: total / pixels, differing: differing / pixels };
}

const failures = [];
const written = [];

// --- Vector assets -----------------------------------------------------------

for (const asset of BRAND_SVGS) {
	const target = join(root, asset.file);
	const svg = brandSvg(asset);
	if (check) {
		if (!existsSync(target)) {
			failures.push(`${asset.file} is missing — run: npm run brand:build`);
		} else if (readFileSync(target, "utf8") !== svg) {
			failures.push(`${asset.file} has drifted from src/lib/brand/ — run: npm run brand:build`);
		}
	} else {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, svg);
		written.push(`${asset.file} (${svg.length} B)`);
	}
}

// `public/favicon.svg` is both a kit file and the tab icon, so it is generated
// from the icon manifest rather than the kit manifest. Both write the same bytes
// and the `--check` comparison below proves it.
const favicon = BRAND_ICONS.find((icon) => icon.file === "public/favicon.svg");
const faviconSvg = iconSvg(favicon);
{
	const target = join(root, favicon.file);
	if (check) {
		if (!existsSync(target)) failures.push(`${favicon.file} is missing — run: npm run brand:build`);
		else if (readFileSync(target, "utf8") !== faviconSvg) {
			failures.push(`${favicon.file} has drifted from src/lib/brand/ — run: npm run brand:build`);
		}
	} else {
		writeFileSync(target, faviconSvg);
		written.push(`${favicon.file} (${faviconSvg.length} B)`);
	}
}

// --- Raster icons ------------------------------------------------------------

const rasters = BRAND_ICONS.filter((icon) => icon.file.endsWith(".png"));
const browser = await chromium.launch();
const page = await browser.newPage();

for (const icon of rasters) {
	const target = join(root, icon.file);
	const svg = iconSvg(icon);
	const png = await rasterise(page, svg, icon.size);

	if (check) {
		if (!existsSync(target)) {
			failures.push(`${icon.file} is missing — run: npm run brand:build`);
			continue;
		}
		const committed = readFileSync(target);
		const [a, b] = await Promise.all([pixelsOf(page, committed), pixelsOf(page, png)]);
		if (a.width !== icon.size || a.height !== icon.size) {
			failures.push(`${icon.file} is ${a.width}×${a.height}, expected ${icon.size}×${icon.size}`);
			continue;
		}
		if (a.lit < icon.size * icon.size * 0.02) {
			failures.push(`${icon.file} is effectively blank (${a.lit} lit pixels)`);
			continue;
		}
		const diff = difference(a, b);
		// Antialiasing jitter between Chromium builds is a fraction of a percent;
		// a missing element is not. 1.5 mean levels and 4% of pixels is well
		// inside the first band and well outside the second.
		if (diff.mean > 1.5 || diff.differing > 0.04) {
			failures.push(
				`${icon.file} does not match a fresh render of src/lib/brand/ (mean Δ${diff.mean.toFixed(2)}, ${(diff.differing * 100).toFixed(1)}% of pixels differ) — run: npm run brand:build`,
			);
			continue;
		}
		if (verbose) {
			console.log(`  ✔ ${icon.file} — ${icon.size}×${icon.size}, ${a.lit} lit px, Δ${diff.mean.toFixed(2)}`);
		}
	} else {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, png);
		written.push(`${icon.file} (${(png.length / 1024).toFixed(1)} KB)`);
	}
}

await browser.close();

// --- Report ------------------------------------------------------------------

const total = [...BRAND_SVGS.map((a) => a.file), ...BRAND_ICONS.map((a) => a.file)];

if (failures.length) {
	console.error(`✖ ${failures.length} brand asset(s) out of sync with src/lib/brand/:\n`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

if (check) {
	console.log(`✔ ${total.length} brand assets match src/lib/brand/ — ${BRAND_SVGS.length} SVG, ${rasters.length} PNG`);
} else {
	console.log(`✔ wrote ${written.length} brand assets from src/lib/brand/:\n`);
	for (const line of written) console.log(`  - ${line}`);
}
