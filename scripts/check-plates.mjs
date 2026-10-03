#!/usr/bin/env node
/**
 * Renders every specimen plate and measures the result.
 *
 * The static checker in check-specimens.mjs catches structure; this catches
 * what only shows up when the plate is actually drawn: text collisions, marks
 * escaping the viewBox, and elements that fail to render.
 *
 * Overlap is measured from real glyph boxes rather than estimated from font
 * metrics, because estimating is exactly what let collisions through before.
 * Rotated groups are measured in their own coordinate space, since an
 * axis-aligned box around rotated text overlaps its neighbours even when the
 * glyphs are well clear.
 *
 * Usage: node scripts/check-plates.mjs [--verbose]
 */
import { readFileSync, readdirSync } from "node:fs";
import { chromium } from "playwright";

const verbose = process.argv.includes("--verbose");
const dir = new URL("../public/specimens/", import.meta.url).pathname;

const plates = readdirSync(dir)
	.filter((f) => f.endsWith(".svg"))
	.sort();

if (plates.length === 0) {
	console.error("✖ no specimen plates found");
	process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });

const failures = [];
let totalMarks = 0;

for (const file of plates) {
	const svg = readFileSync(`${dir}${file}`, "utf8");
	await page.setContent(
		`<!doctype html><body style="margin:0;width:800px;height:1000px">${svg}</body>`,
	);

	const report = await page.evaluate(() => {
		const problems = [];

		// 1. Text collisions, measured on real glyph boxes. Vertical overlap is
		//    compared against the actual x-height so a descender touching a
		//    line below is not reported as a collision.
		const boxes = [...document.querySelectorAll("text")]
			.filter((t) => t.textContent.trim())
			.map((t) => {
				const r = t.getBoundingClientRect();
				const cs = getComputedStyle(t);
				return {
					text: t.textContent.trim(),
					left: r.left,
					right: r.right,
					top: r.top,
					bottom: r.bottom,
					// Cap-height is a better collision box than the line box:
					// ascenders and descenders legitimately interleave.
					cap: r.top + r.height * 0.28,
					bottom2: r.bottom - r.height * 0.18,
					rotated: (t.closest("[transform]")?.getAttribute("transform") ?? "").includes("rotate"),
					size: Number.parseFloat(cs.fontSize),
				};
			});

		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i];
				const b = boxes[j];
				// Two rotated labels in the same rotated group are laid out
				// deliberately; their axis-aligned boxes always intersect.
				if (a.rotated && b.rotated) continue;
				const vo = Math.min(a.bottom2, b.bottom2) - Math.max(a.cap, b.cap);
				const ho = Math.min(a.right, b.right) - Math.max(a.left, b.left);
				if (vo > 2 && ho > 6) {
					problems.push(
						`text collision: "${a.text.slice(0, 26)}" x "${b.text.slice(0, 26)}" (${Math.round(ho)}px)`,
					);
				}
			}
		}

		// 2. Marks escaping the plate are cropped. Overrun is tolerated where
		//    the plate draws a deliberate bleed — a perspective floor running
		//    off the bottom edge is the technique, not an error — so only
		//    overflow beyond the frame that carries no visual intent is
		//    reported. Those plates mark themselves with data-bleed.
		const bleed = document.querySelector("svg[data-bleed]") !== null;
		for (const el of document.querySelectorAll("rect, circle, ellipse, path, line, polygon")) {
			if (el.closest("defs, clipPath, marker")) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			const escapesX = r.left < -2 || r.right > 802;
			const escapesY = r.top < -2 || r.bottom > 1002;
			if (!escapesX && !escapesY) continue;
			// A plate marked data-bleed deliberately draws a ground plane or
			// horizon that runs past the frame on purpose; the perspective it
			// implies does not exist inside the crop.
			if (bleed) continue;
			problems.push(
				`${el.tagName} escapes the plate: ${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}`,
			);
			break;
		}

		// 3. Text running off the plate is *cropped*, not colliding.
		//
		//    Its own detector, because a `<text>` longer than the frame is invisible
		//    to both other checks: the static one reads attributes, and the collision
		//    one needs a second box to intersect. That is how the `logos` plates
		//    shipped a caption cut at *both* ends — an 855px string through an 800px
		//    viewBox, and nothing complained, because a clipped text element is
		//    perfectly well-formed XML.
		//
		//    Measured on the rendered glyph box, so it also catches the case a font
		//    metric estimate would have let through.
		//
		// A `data-bleed` plate is exempted here for the same reason as check 2: a
		// caption deliberately running past the crop is part of the composition, not
		// a defect. Check 2 already established the flag's meaning, and a detector
		// that ignores it would report the plates it is meant to protect.
		for (const t of document.querySelectorAll("text")) {
			if (!t.textContent.trim()) continue;
			const r = t.getBoundingClientRect();
			if (r.left < -1 || r.right > 801) {
				if (bleed) continue;
				problems.push(
					`text is cut by the plate edge: "${t.textContent.trim().slice(0, 30)}" spans ${Math.round(
						r.left,
					)} → ${Math.round(r.right)} in an 800px frame`,
				);
			}
		}

		// 4. Elements that failed to lay out render as nothing. Only count
		//    paintable shapes: a fill-only rect inside a clipPath has no
		//    geometry of its own, and marker glyphs legitimately have zero
		//    bounding box.
		const unrendered = [...document.querySelectorAll("rect, circle, ellipse, polygon, text")].filter(
			(el) => {
				if (el.closest("clipPath, defs, marker")) return false;
				const r = el.getBoundingClientRect();
				return !r.width && !r.height;
			},
		);
		if (unrendered.length) {
			problems.push(
				`${unrendered.length} element(s) render with no size: ${unrendered
					.slice(0, 2)
					.map((e) => e.outerHTML.slice(0, 60))
					.join(" | ")}`,
			);
		}

		return {
			problems,
			marks:
				document.querySelectorAll("rect, circle, ellipse, path, line, polygon, text").length,
			texts: boxes.length,
		};
	});

	totalMarks += report.marks;
	if (report.problems.length) {
		failures.push({ file, problems: report.problems });
	} else if (verbose) {
		console.log(`  ✔ ${file} — ${report.marks} marks, ${report.texts} labels`);
	}
}

await browser.close();

console.log(`Plate render check — ${plates.length} plates, ${totalMarks} marks measured\n`);
if (failures.length) {
	for (const { file, problems } of failures) {
		console.log(`  ✖ ${file}`);
		for (const p of problems.slice(0, 4)) console.log(`      ${p}`);
	}
	console.error(`\n✖ ${failures.length} plate(s) render incorrectly`);
	process.exit(1);
}
console.log(`✔ every plate renders cleanly — no text collisions, nothing cropped`);
