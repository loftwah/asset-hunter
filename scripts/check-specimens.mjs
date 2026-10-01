#!/usr/bin/env node
/**
 * Validates every specimen plate as well-formed XML with a usable viewBox and
 * accessible label. Specimens are the catalogue's primary media, so a malformed
 * plate is a broken product tile, not a cosmetic issue.
 *
 * Usage: node scripts/check-specimens.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("../public/specimens/", import.meta.url).pathname;
const failures = [];
const checked = [];

const SVG_TAGS = new Set([
	"svg", "g", "defs", "rect", "circle", "ellipse", "line", "path", "polygon",
	"polyline", "text", "tspan", "linearGradient", "radialGradient", "stop",
	"clipPath", "mask", "pattern", "filter", "feGaussianBlur", "feOffset",
	"feBlend", "feColorMatrix", "feComposite", "feMerge", "feMergeNode",
	"feFlood", "feTurbulence", "feDisplacementMap", "use",
	"symbol", "marker", "title", "desc", "image", "textPath", "style",
]);

let files = [];
try {
	files = readdirSync(DIR).filter((f) => f.endsWith(".svg"));
} catch {
	console.error(`✖ specimen directory not found: ${DIR}`);
	process.exit(1);
}

for (const file of files.sort()) {
	const path = join(DIR, file);
	const src = readFileSync(path, "utf8");
	const size = statSync(path).size;
	const problems = [];

	if (!src.trimStart().startsWith("<svg")) problems.push("does not start with <svg>");
	if (!/<\/svg>\s*$/.test(src)) problems.push("missing closing </svg>");
	if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(src)) problems.push("missing svg namespace");

	const viewBox = src.match(/viewBox="([^"]+)"/)?.[1];
	if (!viewBox) {
		problems.push("missing viewBox");
	} else {
		const nums = viewBox.split(/[\s,]+/).map(Number);
		if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
			problems.push(`malformed viewBox "${viewBox}"`);
		} else if (nums[2] <= 0 || nums[3] <= 0) {
			problems.push("viewBox has non-positive dimensions");
		}
	}

	const label = src.match(/aria-label="([^"]+)"/)?.[1];
	if (!label) problems.push("missing aria-label");

	if (!/role="img"/.test(src)) problems.push("missing role=\"img\"");

	// Unknown tags would silently render nothing.
	for (const m of src.matchAll(/<([a-zA-Z][\w:-]*)/g)) {
		if (!SVG_TAGS.has(m[1])) problems.push(`unknown element <${m[1]}>`);
	}

	// Attributes must be `name="value"` or `name='value'`. A missing space
	// between two attributes — `fill="#a"fill="#b"` — is malformed XML that
	// browsers refuse to render at all, which is the worst failure a plate can
	// have because it looks correct in the source.
	for (const m of src.matchAll(/\s([a-zA-Z-]+)="[^"]*"([a-zA-Z][\w:-]*=)/g)) {
		problems.push(`missing space between attributes: ...${m[0].slice(0, 40)}`);
	}

	// Duplicate attributes on one element: the second is ignored, so the plate
	// renders with the wrong colour.
	for (const tag of src.matchAll(/<[a-zA-Z][^>]*>/g)) {
		const names = [...tag[0].matchAll(/\s([a-zA-Z-]+)=/g)].map((m) => m[1]);
		const seen = new Set();
		for (const n of names) {
			if (seen.has(n)) problems.push(`duplicate attribute "${n}" on ${tag[0].slice(0, 50)}`);
			seen.add(n);
		}
	}

	// Placeholders from interrupted authoring.
	if (/placeholder|TODO|FIXME|Lorem ipsum/i.test(src)) problems.push("contains placeholder text");

	// Overlapping text is the characteristic authoring mistake in these plates
	// and is invisible until the plate is seen at wall size, so it is checked
	// rather than trusted to review. `text-anchor` is honoured, because the
	// plates deliberately place a left and a right-anchored label on one
	// baseline to bracket a figure.
	problems.push(...findTextCollisions(src));

	if (problems.length) {
		failures.push({ file, problems });
	} else {
		checked.push({ file, size, viewBox });
	}
}

/**
 * Detects `<text>` elements that visually collide.
 *
 * Plate annotations are hand-placed, so the recurring mistake is two labels on
 * the same baseline running into each other — which renders as gibberish at
 * wall size and looks fine in the source. Monospace advance is approximated
 * from the font-size, which is close enough to catch a real overlap without
 * flagging tight-but-legible spacing.
 */
function findTextCollisions(src) {
	const problems = [];
	const items = [];
	// Cumulative translate from enclosing <g transform="translate(x,y)">.
	// The plates group repeated panels this way, so a text element's true
	// position is its local coordinates plus every ancestor offset — without
	// this, every grouped label looks like it sits at y≈0 and collides.
	let offsetX = 0;
	let offsetY = 0;
	const stack = [];

	const tagRe = /<(\/?)(g|text)\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
	let m;
	while ((m = tagRe.exec(src)) !== null) {
		const [, closing, tag, attrs, selfClosing] = m;
		if (closing === "/") {
			if (tag === "g" && stack.length) {
				const prev = stack.pop();
				offsetX = prev.x;
				offsetY = prev.y;
			}
			continue;
		}
		if (tag === "g") {
			const translate = attrs.match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/);
			const dx = translate ? Number.parseFloat(translate[1]) : 0;
			const dy = translate ? Number.parseFloat(translate[2]) : 0;
			stack.push({ x: offsetX, y: offsetY });
			offsetX += dx;
			offsetY += dy;
			continue;
		}
		// A <text> element.
		const close = src.indexOf("</text>", tagRe.lastIndex);
		const content = close === -1 ? "" : src.slice(tagRe.lastIndex, close);
		tagRe.lastIndex = close === -1 ? tagRe.lastIndex : close;
		const y = Number.parseFloat(attrs.match(/\by="([\d.]+)"/)?.[1] ?? "NaN");
		const x = Number.parseFloat(attrs.match(/\bx="([\d.]+)"/)?.[1] ?? "NaN");
		const size = Number.parseFloat(attrs.match(/\bfont-size="([\d.]+)"/)?.[1] ?? "16");
		const anchor = attrs.match(/text-anchor="([^"]+)"/)?.[1] ?? "start";
		if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
		const absY = y + offsetY;
		const absX = x + offsetX;
		// Approximate advance for the monospace stack used on the plates.
		const width = content.length * size * 0.6;
		const start = anchor === "end" ? absX - width : anchor === "middle" ? absX - width / 2 : absX;
		items.push({ y: absY, x: absX, start, end: start + width, text: content.trim() });
	}

	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const a = items[i];
			const b = items[j];
			// Same baseline band.
			if (Math.abs(a.y - b.y) > 14) continue;
			const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
			// 24px of intrusion into the neighbouring label. Anything less is
			// tight spacing, which these plates use deliberately.
			if (overlap > 24) {
				problems.push(
					`text "${a.text.slice(0, 24)}" overlaps "${b.text.slice(0, 24)}" at y=${a.y} by ~${Math.round(overlap)}px`,
				);
			}
		}
	}
	return problems.slice(0, 4);
}

/**
 * Structural check: walk the tag stream with a stack so nesting and closure are
 * both verified. A raw `/>` count is not sufficient — `/>` also occurs inside
 * path data and attribute values.
 */
function checkBalance(src) {
	const problems = [];
	const stack = [];
	const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g;
	let m;
	while ((m = tagRe.exec(src)) !== null) {
		const [, closing, name, , selfClosing] = m;
		if (selfClosing === "/") continue;
		if (closing === "/") {
			const open = stack.pop();
			if (open === undefined) problems.push(`stray closing tag </${name}>`);
			else if (open !== name) problems.push(`closing </${name}> does not match open <${open}>`);
		} else {
			stack.push(name);
		}
	}
	if (stack.length) problems.push(`unclosed: ${stack.join(", ")}`);
	return problems;
}

for (const { file } of [...failures.map((f) => ({ file: f.file })), ...checked.map((c) => ({ file: c.file }))]) {
	const src = readFileSync(join(DIR, file), "utf8");
	const problems = checkBalance(src);
	if (problems.length) {
		const found = failures.find((f) => f.file === file);
		if (found) found.problems.push(...problems);
		else failures.push({ file, problems });
	}
}

if (failures.length) {
	console.error(`✖ ${failures.length} specimen plate(s) invalid:\n`);
	for (const { file, problems } of failures) {
		console.error(`  ${file}`);
		for (const p of problems) console.error(`    - ${p}`);
	}
	process.exit(1);
}

const total = checked.reduce((n, c) => n + c.size, 0);
console.log(`✔ ${checked.length} specimen plates valid (${(total / 1024).toFixed(0)} KB total, avg ${(total / checked.length / 1024).toFixed(1)} KB)`);
