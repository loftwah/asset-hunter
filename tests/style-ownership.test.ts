/**
 * A page's `<style>` must not reach into a component's classes (#79).
 *
 * #79 was found by a fold gate, not by a rule: extracting `Crumbs` made Astro
 * scope both the markup and the page's rules to different `data-astro-cid` values,
 * so `:global`-less `.crumbs` became dead code. The header grew 26px, the first
 * plate moved from 74% to 81% of the fold at 844×390, and `check:visual` failed.
 *
 * Nothing warned. A selector that no longer matches is not an error in CSS, and a
 * component extraction is exactly the change that produces one. The only thing that
 * catches it is measuring the page.
 *
 * ## Why a source scan rather than a measurement
 *
 * The gate is necessary but late: it fails on a *consequence* (a plate below the
 * fold), at one width, and only for consequences that happen to be gated. This
 * catches the cause instead, at the moment it is written, for every page and every
 * component — including the ones with no gate and the ones where the consequence
 * is a few pixels nobody will ever notice.
 *
 * The rule it enforces is the one Astro's scoping implies: a page may style its own
 * markup freely, and a class a component owns may only be targeted deliberately,
 * through `:global()`.
 *
 * `:global()` is the escape hatch and is not a smell. Three rules use it and each
 * carries a comment saying why — `collections/[slug]` needs the trail to span two
 * grid columns, and both drill-in and use page need the use block full-width. Those
 * are page-level layout decisions about a child's box, which is precisely what
 * `:global()` is for. So the scan reports them, and the *reason* is that the
 * comments must be there.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const src = join(root, "src");

function astroFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) astroFiles(full, out);
		else if (entry.name.endsWith(".astro")) out.push(full);
	}
	return out;
}

/** Classes a component renders. Markup only — `<style>` contents are excluded. */
function classesInMarkup(text: string): Set<string> {
	const out = new Set<string>();
	for (const block of text.replace(/<style[\s\S]*?<\/style>/g, "").matchAll(/class="([^"]*)"/g)) {
		for (const token of block[1].split(/\s+/)) {
			// Skip Astro's class:list expressions and any interpolation.
			if (token && !token.includes("{") && !token.includes("$")) out.add(token);
		}
	}
	return out;
}

/**
 * Class selectors a file's `<style>` blocks mention.
 *
 * Returned as `selector → whether it is wrapped in `:global()`, because that flag
 * is the whole distinction: `.crumbs` is dead code and `:global(.crumbs)` is a
 * decision.
 */
function classSelectorsInStyles(text: string): Array<{ selector: string; global: boolean }> {
	const out: Array<{ selector: string; global: boolean }> = [];
	for (const block of text.matchAll(/<style[\s\S]*?<\/style>/g)) {
		/*
		 * CSS comments are stripped first, and that is not a detail.
		 *
		 * A comment explaining *why* a rule is `:global()` almost always quotes the
		 * selector it is about — this file's own subject is a comment reading "a
		 * plain `.crumbs` selector in a page's `<style>` no longer matches it". So a
		 * scanner that reads comments reports the deliberate, correct
		 * `:global(.crumbs)` as a violation, because the prose mentions `.crumbs`
		 * without the wrapper.
		 *
		 * Which is an amusing instance of the failure this test exists to catch: the
		 * scanner was right about the rule and wrong about the code, for the same
		 * reason the real bug was invisible — a string that looks like a selector is
		 * not a selector.
		 */
		const css = block[0].replace(/\/\*[\s\S]*?\*\//g, "");
		for (const m of css.matchAll(/:global\(\s*\.([\w-]+)\s*\)|\.([\w-]+)/g)) {
			if (m[1]) out.push({ selector: m[1], global: true });
			else if (m[2]) out.push({ selector: m[2], global: false });
		}
	}
	return out;
}

const pages = [
	...astroFiles(join(src, "pages")),
	...astroFiles(join(src, "layouts")),
];
const components = astroFiles(join(src, "components"));

const componentClasses = new Map<string, string[]>();
for (const file of components) {
	for (const cls of classesInMarkup(readFileSync(file, "utf8"))) {
		const owners = componentClasses.get(cls) ?? [];
		owners.push(file.slice(root.length));
		componentClasses.set(cls, owners);
	}
}

const relative = (f: string) => f.slice(root.length);

describe("a page's stylesheet does not reach into a component's classes", () => {
	test("every page-scoped rule that names a component class is :global()", () => {
		const offences: string[] = [];

		for (const page of pages) {
			const text = readFileSync(page, "utf8");
			const own = classesInMarkup(text);
			for (const { selector, global } of classSelectorsInStyles(text)) {
				if (global) continue;
				const owners = componentClasses.get(selector);
				if (!owners) continue;
				// The page may also use the class in its own markup, in which case
				// the rule is about its own copy and scoping is correct.
				if (own.has(selector)) continue;
				offences.push(
					`${relative(page)}: .${selector} is rendered by ${owners.join(", ")}, not by this page`,
				);
			}
		}

		assert.deepEqual(
			offences,
			[],
			[
				"these rules match nothing: Astro scopes the page's rules and the",
				"component's markup to different hashes, so a plain class selector",
				"reaching into a component is dead code that changes layout without a diff.",
				"Wrap it in :global() if the page really needs to reach into the child's box,",
				"or move the rule into the component.",
			].join("\n"),
		);
	});

	test("every :global() that reaches into a component says why", () => {
		/*
		 * The escape hatch is allowed, but not silently.
		 *
		 * `:global(.crumbs)` on its own is indistinguishable from the dead rule it
		 * replaced — a reader cannot tell whether someone knew the scoping rule or
		 * got lucky. So the comment has to be there, and #79's own failure is the
		 * argument: the rule that *did* need `:global()` had exactly this comment,
		 * which is the only reason it was recognisable as deliberate when the
		 * extraction broke it.
		 */
		const unexplained: string[] = [];

		for (const page of pages) {
			const text = readFileSync(page, "utf8");
			const own = classesInMarkup(text);
			for (const { selector, global } of classSelectorsInStyles(text)) {
				if (!global) continue;
				if (!componentClasses.has(selector)) continue;
				if (own.has(selector)) continue;

				/*
				 * Look for a comment immediately above the rule.
				 *
				 * "Above" rather than "somewhere in the file", and bounded: the window is
				 * the text between the *end of the last comment before the rule* and the
				 * rule itself, and it must be whitespace only. An earlier version
				 * accepted any `/*` in the previous 400 characters, which meant any page
				 * with a comment anywhere nearby passed — including one with a
				 * `:global()` and no explanation at all, which is the case the check is
				 * for.
				 *
				 * Requiring nothing but whitespace between them also rejects a comment
				 * that belongs to the *previous* rule, which is the other way this check
				 * can pass for the wrong reason.
				 */
				/*
				 * Every occurrence, not just the first, and occurrences inside comments
				 * are prose rather than rules.
				 *
				 * `indexOf` checked only the first `:global(.x)`-shaped string in a file,
				 * which let two things through. A selector named inside a comment —
				 * this repository's pages explain their own scoping in prose, so
				 * `.example > :global(.use)` appears in a *sentence* on the use page —
				 * was treated as an unexplained rule when the file has no such rule.
				 * And a second genuine rule in the same file would never be checked at
				 * all.
				 *
				 * So it walks the occurrences, skipping any inside a comment block, and
				 * accepts when one of the real ones is directly preceded by a comment.
				 */
				const needle = `:global(.${selector})`;
				let hasComment = false;
				for (let at = text.indexOf(needle); at !== -1; ) {
					const before = text.slice(0, at);
					const lastOpen = before.lastIndexOf("/*");
					const lastClose = before.lastIndexOf("*/");
					if (lastOpen > lastClose) {
						/*
						 * Inside a comment: prose, not a rule. Skip the whole block.
						 *
						 * Necessary rather than tidy. These pages explain their own scoping
						 * in the comment directly above the rule, so the selector string
						 * appears twice — once quoted in the explanation and once as the rule
						 * — and counting both would let the explanation vouch for the very
						 * rule it explains.
						 */
						const close = text.indexOf("*/", at);
						at = close === -1 ? -1 : text.indexOf(needle, close);
						continue;
					}
					/*
					 * Immediately above, allowing only the ancestor chain.
					 *
					 * Two earlier versions were wrong in opposite directions, and either
					 * alone ships a check that passes for the wrong reason.
					 *
					 * "A comment within 400 characters" accepts any file with a comment
					 * nearby — including one with an unexplained `:global()`. And "only
					 * whitespace between" rejects the drill-in's real rule, because the
					 * text between its comment and the selector is `.example > ` — the
					 * selector's own ancestor, part of the rule rather than a separate
					 * declaration.
					 *
					 * So the gap may hold the ancestor chain and nothing else. `{` and `}`
					 * are excluded, and those are the rule boundaries: a `}` in the gap
					 * means a previous rule closed there, which is the case where the
					 * comment belongs to the rule above rather than to this one.
					 */
					if (lastClose === -1) {
						at = text.indexOf(needle, at + needle.length);
						continue;
					}
					if (/^[\s:>+~.#\w[\]="'-]*$/.test(before.slice(lastClose + 2))) {
						hasComment = true;
						break;
					}
					at = text.indexOf(needle, at + needle.length);
				}
				if (!hasComment) {
					unexplained.push(
						`${relative(page)}: :global(.${selector}) has no comment saying why`,
					);
				}
			}
		}

		assert.deepEqual(unexplained, [], unexplained.join("; "));
	});

	test("the scan can see components at all", () => {
		// A scan that finds nothing because it found no files is a check that passed
		// because it had nothing to look at — the failure mode #47 exists to prevent,
		// and the one this file is otherwise about.
		assert.ok(
			components.length >= 5,
			`only ${components.length} component(s) found under src/components; the scan is not looking where it thinks`,
		);
		assert.ok(
			componentClasses.size >= 20,
			`only ${componentClasses.size} component class(es) indexed; the scan is not seeing markup`,
		);
		assert.ok(
			pages.length >= 10,
			`only ${pages.length} page(s) scanned; the scan is not looking where it thinks`,
		);
	});
});