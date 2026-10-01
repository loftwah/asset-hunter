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

	// Placeholders from interrupted authoring.
	if (/placeholder|TODO|FIXME|Lorem ipsum/i.test(src)) problems.push("contains placeholder text");

	if (problems.length) {
		failures.push({ file, problems });
	} else {
		checked.push({ file, size, viewBox });
	}
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
