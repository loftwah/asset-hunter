/**
 * The brand mark has exactly one source of truth, and this is what proves it.
 *
 * The mark used to be drawn twice — inline in `Wordmark.astro` and again by hand
 * in `public/favicon.svg` — so the copies could drift and nothing would notice.
 * They had already drifted: the committed `apple-touch-icon.png` had lost the
 * inner ring. A shared module that nothing compares is two files with extra
 * steps, so every test here compares something against the module:
 *
 *  1. `Wordmark.astro` may not carry geometry of its own.
 *  2. every committed SVG is byte-identical to what the module generates.
 *  3. the favicon's *shape list* equals the shape list the masthead renders.
 *  4. no brand SVG can execute or reach outside itself.
 *  5. the docs state the numbers the code uses.
 *
 * None of this needs a server, so it runs in `npm run test` with no dev server
 * up. The raster icons are the exception: proving a PNG still shows the mark
 * means measuring pixels, which is `npm run brand:check`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BRAND_ICONS,
	BRAND_SVGS,
	MASKABLE_SCALE,
} from "../src/lib/brand/assets.ts";
import {
	MARK_BOX,
	MARK_CLEAR_SPACE,
	MARK_INK,
	MARK_MIN_SIZE_PX,
	clearSpaceSvg,
	markShapes,
	markSvg,
} from "../src/lib/brand/mark.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8");

/**
 * Every shape element in an SVG file, as comparable attribute maps.
 *
 * Attribute *order* is not part of the identity of a shape, and the serialiser
 * is free to order them however it likes, so comparison is order-insensitive.
 * Numeric strings are compared as strings because that is what the file
 * contains; `1.5` and `1.50` are the same mark and a real hand-edit produces a
 * different number, not a differently-spelled one.
 */
function shapesIn(src: string): { tag: string; attrs: Record<string, string> }[] {
	return [...src.matchAll(/<(circle|path|rect)\b([^>]*)\/?>/g)].map(([, tag, body]) => ({
		tag,
		attrs: Object.fromEntries(
			[...body.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]),
		),
	}));
}

const ALL_BRAND_SVGS = [...BRAND_SVGS.map((a) => a.file), ...BRAND_ICONS.map((a) => a.file)];

describe("the mark has one source of truth", () => {
	test("Wordmark.astro draws no geometry of its own", () => {
		const src = read("src/components/Wordmark.astro");
		// The component must take its shapes from the module.
		assert.match(
			src,
			/from "\.\.\/lib\/brand\/mark\.ts"/,
			"Wordmark.astro must import the mark from src/lib/brand/mark.ts",
		);
		assert.match(src, /markShapes\(/, "Wordmark.astro must call markShapes()");

		// Only the template is scanned. The frontmatter is TypeScript, and a
		// comment is allowed to *mention* `<circle>` while explaining why it must
		// never appear in the markup.
		const frontmatter = /^---\n[\s\S]*?\n---/.exec(src)?.[0] ?? "";
		const template = src.slice(frontmatter.length);

		// A `<circle>` or `<path>` in the template is the second copy coming back.
		const drawn = template.match(/<(circle|path|rect|ellipse|line|polygon)\b/g) ?? [];
		assert.deepEqual(
			drawn,
			[],
			`Wordmark.astro draws ${drawn.join(", ")} by hand. The geometry belongs in src/lib/brand/mark.ts.`,
		);

		// Nor may it inline coordinates as attributes.
		assert.equal(
			/\b(cx|cy|r|d)="/.test(template),
			false,
			"Wordmark.astro carries inline coordinates. The geometry belongs in src/lib/brand/mark.ts.",
		);
	});

	test("the favicon is the same shape list the masthead renders", () => {
		const favicon = BRAND_ICONS.find((icon) => icon.file === "public/favicon.svg");
		assert.ok(favicon, "public/favicon.svg must be declared in src/lib/brand/assets.ts");

		const inFile = shapesIn(read(favicon.file));
		const [ground, ...drawn] = inFile;

		assert.equal(ground.tag, "rect", "the favicon's first element must be its opaque ground");
		assert.equal(ground.attrs.fill, favicon.ground);

		const expected = markShapes(favicon.detail, favicon.ink);
		assert.deepEqual(
			drawn,
			expected,
			`public/favicon.svg draws ${drawn.length} shape(s) and the masthead draws ${expected.length}. They have diverged — run: npm run brand:build`,
		);
	});

	test("every committed SVG is byte-identical to what the module generates", () => {
		for (const asset of BRAND_SVGS) {
			assert.ok(existsSync(join(root, asset.file)), `${asset.file} is missing`);
			const expected =
				asset.kind === "diagram"
					? clearSpaceSvg(asset.label)
					: markSvg({
							detail: asset.detail,
							ink: asset.ink,
							ground: asset.ground,
							size: asset.size,
							label: asset.label,
							...(asset.maskable ? { scale: MASKABLE_SCALE } : {}),
						});
			assert.equal(
				read(asset.file),
				expected,
				`${asset.file} has drifted from src/lib/brand/ — run: npm run brand:build`,
			);
		}
	});

	test("the two forms share one lozenge and differ only in what survives 16px", () => {
		const full = markShapes("full");
		const compact = markShapes("compact");

		// The lozenge is the thing being located; it has to be recognisably the
		// same shape in both forms or the icon form is a different mark. It is
		// the only path that is *filled* rather than stroked, so match on that
		// rather than on position.
		const lozenge = (shapes: ReturnType<typeof markShapes>) =>
			shapes.find((s) => s.tag === "path" && s.attrs.fill !== "none")?.attrs.d;
		const fullLozenge = lozenge(full);
		const compactLozenge = lozenge(compact);
		assert.ok(fullLozenge && compactLozenge, "both forms need a filled lozenge");
		for (const d of [fullLozenge, compactLozenge]) {
			// M <top> <right> <bottom> <left> Z, centred on 12,12 — a lozenge, not
			// a circle or a square. A hand-drawn replacement would not be this.
			assert.match(d!, /^M12 [\d.]+ [\d.]+ 12 12 [\d.]+ [\d.]+ 12Z$/, `lozenge "${d}" is not centred`);
		}

		// Nothing in the icon form may be semi-transparent: a 42%-opacity ring
		// dithers to a muddy brick at 16px and reads as a different colour.
		for (const shape of compact) {
			assert.equal(shape.attrs.opacity, undefined, `the icon form must not use opacity (${shape.attrs.d ?? "circle"})`);
		}
	});
});

describe("a brand asset that can execute is a security problem, not a branding one (#53)", () => {
	test("no committed brand SVG carries script, handlers or external references", () => {
		for (const file of ALL_BRAND_SVGS) {
			if (!file.endsWith(".svg")) continue;
			assert.ok(existsSync(join(root, file)), `${file} is missing`);
			const src = read(file);

			for (const [what, pattern] of [
				["a <script> element", /<script\b/i],
				["an inline event handler", /\son[a-z]+\s*=/i],
				["a url() reference", /url\s*\(/i],
				["an external href", /\b(xlink:)?href\s*=/i],
				["an <image> element", /<image\b/i],
				["a <foreignObject>", /<foreignObject\b/i],
				["an animation", /<animate\b|<set\b/i],
				["an external entity", /<!ENTITY/i],
				["a doctype", /<!DOCTYPE/i],
			] as const) {
				assert.equal(pattern.test(src), false, `${file} contains ${what}`);
			}
		}
	});

	test("every SVG the app serves is accessible and has a usable viewBox", () => {
		for (const file of ALL_BRAND_SVGS) {
			if (!file.endsWith(".svg")) continue;
			const src = read(file);
			assert.match(src, /role="img"/, `${file} needs role="img"`);
			assert.match(src, /aria-label="[^"]+"/, `${file} needs an aria-label`);
			// The clear-space diagram is a document, not a placement asset, so it
			// draws on a wider canvas; everything that gets placed uses the grid.
			if (file === "brand/clear-space.svg") continue;
			assert.match(
				src,
				new RegExp(`viewBox="0 0 ${MARK_BOX} ${MARK_BOX}"`),
				`${file} must use the mark's ${MARK_BOX}-unit grid`,
			);
		}
	});
});

describe("the icon set is installable and the files it names exist", () => {
	test("every manifest icon resolves to a committed file", () => {
		const manifest = JSON.parse(read("public/site.webmanifest"));
		const declared = manifest.icons.map((i: { src: string }) => i.src.replace(/^\//, ""));
		for (const src of declared) {
			assert.ok(existsSync(join(root, "public", src)), `site.webmanifest names /${src}, which does not exist`);
		}

		// Chrome will not offer to install without a 192px and a 512px raster.
		// The manifest had neither, which is a real install bug this fixes.
		for (const size of [192, 512]) {
			assert.ok(
				declared.includes(`icon-${size}.png`),
				`site.webmanifest needs a ${size}px icon for Chrome's install criteria`,
			);
		}
		assert.ok(
			declared.includes("icon-maskable-512.png"),
			"site.webmanifest needs a maskable icon or Android crops the mark",
		);
	});

	test("the manifest's colours are the canvas token, not a hand-typed hex", () => {
		const manifest = JSON.parse(read("public/site.webmanifest"));
		assert.equal(manifest.theme_color, MARK_INK.canvas);
		assert.equal(manifest.background_color, MARK_INK.canvas);
	});
});

describe("the brand inks are the DESIGN.md tokens and have not been invented", () => {
	const css = read("src/styles/global.css");

	test("every ink in the mark vocabulary is declared in global.css", () => {
		for (const [name, value] of Object.entries(MARK_INK)) {
			assert.match(
				css,
				new RegExp(`--${name}:\\s*${value}\\s*;`),
				`MARK_INK.${name} is ${value}, which is not --${name} in src/styles/global.css`,
			);
		}
	});

	test("the mark's inks are exactly the three tokens the design allows", () => {
		assert.deepEqual(Object.keys(MARK_INK).sort(), ["canvas", "ember", "ink"]);
	});
});

describe("DESIGN.md states the numbers the geometry uses", () => {
	const design = read("DESIGN.md");

	test("clear space and minimum size are written down, not tribal knowledge", () => {
		assert.match(
			design,
			new RegExp(`clear[- ]space[^\\n]*\\b${MARK_CLEAR_SPACE}\\b`, "i"),
			`DESIGN.md must state the ${MARK_CLEAR_SPACE}-unit clear space (MARK_CLEAR_SPACE)`,
		);
		for (const [form, px] of Object.entries(MARK_MIN_SIZE_PX)) {
			assert.match(
				design,
				new RegExp(`\\b${px}px\\b[^\\n]*\\b${form}\\b|\\b${form}\\b[^\\n]*\\b${px}px\\b`, "i"),
				`DESIGN.md must state the ${form} form's ${px}px minimum (MARK_MIN_SIZE_PX)`,
			);
		}
	});

	test("the mark variants are documented where the token table already is", () => {
		// §9.4 is the brand-token mapping; a variant nobody wrote down is a
		// variant nobody is allowed to use.
		assert.match(design, /## 9\.4 Brand tokens/);
		for (const file of ["mark-compact.svg", "mark-ink.svg", "mark-canvas.svg"]) {
			assert.ok(design.includes(file), `DESIGN.md §9.4 must name ${file}`);
		}
	});
});
