#!/usr/bin/env node
/**
 * Generates social and app icons from the running product.
 *
 * Deliberately captures the real wall rather than composing a mock: the
 * project's own rule is that marketing media comes from the product, so a
 * prettier card cannot be produced by a layout that the site does not have.
 *
 * The OG card is a deterministic restyle of `/` — the plates, type and colour
 * are the shipped ones, with the masthead, chrome and captions suppressed so
 * the specimens are the subject.
 *
 * Usage: node scripts/generate-og.mjs [--url http://localhost:4321]
 * Requires the dev server to be running.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const baseUrl = urlIndex === -1 ? "http://localhost:4321" : args[urlIndex + 1];
const publicDir = new URL("../public/", import.meta.url).pathname;

/**
 * The card restyle. Suppression is by class, so a layout change in the app
 * cannot silently produce a card full of clipped masthead.
 */
const CARD_CSS = `
	.masthead, .footer, .rail, .legend, .intro__summary, .lede, .tally, .skip-link { display: none !important; }
	main { padding: 0 !important; }
	body { background: #08090a; }
	.intro { padding-block: 40px 14px !important; gap: 6px !important; }
	.intro__title { font-size: 54px !important; line-height: 1.04 !important; max-width: none !important; }
	.wall { padding-block: 0 !important; }
	.wall__feature { display: none !important; }
	.grid { grid-template-columns: repeat(6, 1fr) !important; gap: 8px !important; }
	/* Captions off: a 190px tile cannot carry type, and a shrunken label
	   would misrepresent the design. The specimens are the message. */
	.tile__label { display: none !important; }
	.tile__plate { aspect-ratio: 1 / 1 !important; border-radius: 2px !important; }
	/* Twelve tiles fill two rows at six across and read as a specimen wall
	   rather than a cropped screenshot. */
	.tile:nth-child(n + 13) { display: none !important; }
	.intro__title, .tile__title { font-family: "Bricolage", sans-serif; }
`;

/** Wordmark + title card, for surfaces that want a brand image not a grid. */
async function captureCard(page, file, { grid = true } = {}) {
	await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
	await page.addStyleTag({ content: grid ? CARD_CSS : CARD_CSS.replace(/\.tile[\s\S]*?\n/g, "") });
	// Let webfonts settle so the headline is not captured in a fallback face.
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(600);
	await page.screenshot({ path: `${publicDir}${file}`, type: "png" });
	return file;
}

async function main() {
	try {
		await fetch(`${baseUrl}/`);
	} catch {
		console.error(`✖ no server at ${baseUrl} — start it with \`npm run dev\``);
		process.exit(1);
	}

	const browser = await chromium.launch();
	const written = [];

	const page = await browser.newPage({
		viewport: { width: 1200, height: 630 },
		deviceScaleFactor: 1,
		colorScheme: "dark",
	});
	written.push(await captureCard(page, "og.png"));

	// A taller variant for surfaces that prefer 4:5 or 1:1.
	const square = await browser.newPage({
		viewport: { width: 1200, height: 1200 },
		deviceScaleFactor: 1,
		colorScheme: "dark",
	});
	written.push(
		await captureCard(square, "og-square.png").catch((err) => {
			console.error(`  (skipped og-square.png: ${err.message.split("\n")[0]})`);
			return null;
		}),
	);

	await browser.close();

	const made = written.filter(Boolean);
	if (made.length === 0) {
		console.error("✖ nothing generated");
		process.exit(1);
	}
	for (const file of made) {
		if (!existsSync(`${publicDir}${file}`)) {
			console.error(`✖ ${file} was not written`);
			process.exit(1);
		}
	}
	console.log(`✔ generated ${made.join(", ")} from the running product`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
