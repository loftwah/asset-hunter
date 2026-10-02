/**
 * The public shell reads EmDash (#17).
 *
 * Issue #17's substantive requirement was: *"Admin-editable copy/navigation
 * belongs in EmDash rather than hard-coded duplicate configuration where
 * practical."* It was not met. `seed/seed.json` declared a `primary` menu and
 * `src/layouts/Base.astro` declared an identical array, and nothing connected
 * them — so editing the menu in the EmDash admin, the first thing an owner would
 * try, changed nothing a reader could see.
 *
 * These tests assert that the duplication is gone and cannot come back. They
 * fall into three groups:
 *
 * 1. **The projections are right** — pure functions, so the interesting
 *    questions (what happens to a `javascript:` href, to a blank label, to a
 *    database with no menu) are answerable without a database.
 * 2. **The service boundary is right** — the shell is substitutable, so a
 *    fallback can be proven reachable without breaking anything.
 * 3. **The duplication is structurally gone** — assertions against the source
 *    and the seed, which is what makes this a *regression* gate rather than a
 *    snapshot of today's behaviour.
 *
 * The live check that the masthead equals the CMS menu is
 * `scripts/check-nav.mjs`, because it needs a running server and a database.
 * What it cannot do is prove the literal has not been re-added, which is what
 * group 3 is for.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { Effect, Layer } from "effect";

import { EmDashContent, type MenuValue, type SectionValue } from "../src/lib/effect/emdash.ts";
import { CatalogueDecodeError, EmDashTransportError } from "../src/lib/effect/errors.ts";
import { GALLERY_SHOTS } from "../src/lib/gallery.ts";
import {
	FALLBACK_INTRO_BLOCKS,
	FALLBACK_LINKS,
	INTRO_SECTION,
	PRIMARY_MENU,
	isCurrentLink,
	loadIntro,
	loadPrimaryNav,
	navFromMenu,
} from "../src/lib/site-shell.ts";

const root = new URL("../", import.meta.url).pathname;

/**
 * A CMS that answers with whatever the test hands it.
 *
 * `menu` and `section` are part of the same service as `collection`/`entry`, so
 * a stub that omits them would not typecheck — which is the point of putting
 * the shell's reads on the existing boundary instead of inventing a second one.
 */
const stub = (options: {
	menu?: () => Effect.Effect<{ menu: MenuValue | null; cacheHint: undefined }, never>;
	section?: () => Effect.Effect<SectionValue | null, never>;
	failMenu?: Effect.Effect<never, EmDashTransportError>;
	failSection?: Effect.Effect<never, CatalogueDecodeError>;
}): Layer.Layer<EmDashContent> =>
	Layer.succeed(
		EmDashContent,
		EmDashContent.of({
			collection: () =>
				Effect.succeed({ entries: [], nextCursor: null, cacheHint: undefined }),
			entry: () => Effect.succeed({ entry: null, cacheHint: undefined }),
			// A failure wins over an answer, so a test can say "the database is
			// down" without also having to describe what it would have said.
			menu: () =>
				options.failMenu ??
				(options.menu ? options.menu() : Effect.succeed({ menu: null, cacheHint: undefined })),
			section: () => options.failSection ?? (options.section ? options.section() : Effect.succeed<SectionValue | null>(null)),
		}),
	);

const aMenu = (items: ReadonlyArray<{ id: string; label: string; url: string }>): MenuValue => ({
	id: "menu-1",
	name: PRIMARY_MENU,
	label: "Primary",
	locale: "en",
	items: items.map((item) => ({ ...item, children: [] })),
});

/* -------------------------------------------------------------------------- */
/* The projection                                                              */
/* -------------------------------------------------------------------------- */

describe("navFromMenu", () => {
	test("renders exactly what the CMS said, in the order it said it", () => {
		const links = navFromMenu(
			aMenu([
				{ id: "1", label: "Catalogue", url: "/" },
				{ id: "2", label: "Verticals", url: "/verticals" },
			]),
		);
		assert.deepEqual(
			links.map((l) => l.label),
			["Catalogue", "Verticals"],
		);
		// The label is the CMS's, verbatim. `src/lib/vocabulary.ts` is for slugs
		// this application owns; a menu label is a person's words and running it
		// through a casing table is how "UI" becomes "Ui" on one surface.
		assert.equal(links[0]?.label, "Catalogue");
	});

	test("an unsafe href is dropped rather than rendered", () => {
		// A menu is CMS content, so a URL in it is stored data, and this is the
		// render boundary. `javascript:` reaching an `href` is a stored XSS.
		const links = navFromMenu(
			aMenu([
				{ id: "1", label: "Fine", url: "/collections" },
				{ id: "2", label: "Not fine", url: "javascript:alert(1)" },
				{ id: "3", label: "Also not fine", url: "data:text/html,<script>" },
			]),
		);
		assert.deepEqual(
			links.map((l) => l.href),
			["/collections"],
		);
	});

	test("a blank label falls back to the href, so the link is still usable", () => {
		// Dropping it would also be defensible. Showing the path is more useful:
		// a link with no text is invisible to a screen reader.
		const links = navFromMenu(aMenu([{ id: "1", label: "   ", url: "/gallery" }]));
		assert.equal(links[0]?.label, "/gallery");
	});

	test("an external destination is marked, so the shell can say so", () => {
		const links = navFromMenu(
			aMenu([
				{ id: "1", label: "Source", url: "https://github.com/loftwah/asset-hunter" },
				{ id: "2", label: "Catalogue", url: "/" },
			]),
		);
		assert.equal(links[0]?.external, true);
		assert.equal(links[1]?.external, false);
	});

	test("no menu is no links, which is not the same as a broken menu", () => {
		assert.deepEqual(navFromMenu(null), []);
	});
});

/* -------------------------------------------------------------------------- */
/* The fallback policy                                                         */
/* -------------------------------------------------------------------------- */

describe("the fallback is a fallback, not a second source of truth", () => {
	test("a database with no menu serves the minimum and says so", async () => {
		const nav = await Effect.runPromise(Effect.provide(loadPrimaryNav(), stub({})));
		assert.equal(nav.source, "fallback");
		assert.deepEqual(
			nav.links.map((l) => l.href),
			FALLBACK_LINKS.map((l) => l.href),
		);
		// The note is what an operator reads in the log. A fallback that is not
		// named is a quiet steady state, which is the thing being prevented.
		assert.match(nav.note ?? "", /no primary menu in this database/);
	});

	test("an unreadable database serves the minimum and says so", async () => {
		// The masthead is on every page, including the 404. A D1 outage must not
		// turn a slow database into a site that returns 500.
		const nav = await Effect.runPromise(
			Effect.provide(
				loadPrimaryNav(),
				stub({
					failMenu: Effect.fail(
						new EmDashTransportError({ operation: "read menu primary", detail: "D1 is down" }),
					),
				}),
			),
		);
		assert.equal(nav.source, "fallback");
		assert.match(nav.note ?? "", /could not reach EmDash/);
	});

	test("a menu that exists but has no usable items is a fallback, not an empty masthead", async () => {
		const nav = await Effect.runPromise(
			Effect.provide(
				loadPrimaryNav(),
				stub({
					menu: () =>
						Effect.succeed({
							menu: aMenu([{ id: "1", label: "x", url: "javascript:alert(1)" }]),
							cacheHint: undefined,
						}),
				}),
			),
		);
		assert.equal(nav.source, "fallback");
		assert.match(nav.note ?? "", /no usable items/);
	});

	test("a healthy database is the CMS, with nothing to report", async () => {
		const nav = await Effect.runPromise(
			Effect.provide(
				loadPrimaryNav(),
				stub({
					menu: () =>
						Effect.succeed({
							menu: aMenu([
								{ id: "1", label: "Catalogue", url: "/" },
								{ id: "2", label: "Shots", url: "/gallery" },
							]),
							cacheHint: undefined,
						}),
				}),
			),
		);
		assert.equal(nav.source, "cms");
		assert.equal(nav.note, null);
		assert.deepEqual(
			nav.links.map((l) => l.label),
			["Catalogue", "Shots"],
		);
	});

	test("the menu's cache hint travels with it, so an edit can purge the route", async () => {
		// The reason the read is `getMenuWithCacheHint` and not `getMenu`. A
		// navigation that is CMS-managed but not cache-aware is CMS-managed only
		// until the first cached render, after which an admin edit reaches
		// nobody — which is the failure this whole change exists to end, wearing
		// a different hat.
		const cacheHint = { tags: ["emdash:menu:primary"] } as never;
		const nav = await Effect.runPromise(
			Effect.provide(
				loadPrimaryNav(),
				stub({
					menu: () =>
						Effect.succeed({
							menu: aMenu([{ id: "1", label: "Catalogue", url: "/" }]),
							cacheHint,
						}),
				}),
			),
		);
		assert.equal(nav.source, "cms");
		assert.equal(nav.cacheHint, cacheHint);
		// And a fallback carries none: there is no CMS entry to invalidate.
		const fallback = await Effect.runPromise(Effect.provide(loadPrimaryNav(), stub({})));
		assert.equal(fallback.cacheHint, undefined);
	});

	test("the fallback stays at the irreducible minimum", () => {
		// Three: the wall, the rights page, the about page. A larger list starts
		// being a second opinion about what the navigation should contain, which
		// is the duplication this whole change removes. The cap is the enforcement.
		assert.equal(FALLBACK_LINKS.length, 3);
		assert.deepEqual(
			FALLBACK_LINKS.map((l) => l.href),
			["/", "/pages/licensing", "/pages/about"],
		);
	});

	test("the fallback never offers a destination the CMS menu does not", async () => {
		// Read from the seed, so this is a property of the real menu rather than
		// of a fixture. A fallback that invents a route is a second source of
		// truth wearing a smaller hat.
		const seed = JSON.parse(readFileSync(`${root}seed/seed.json`, "utf8"));
		const menu = seed.menus.find((m: { name: string }) => m.name === PRIMARY_MENU);
		assert.ok(menu, "the seed declares no primary menu");
		const cms = new Set<string>(menu.items.map((i: { url: string }) => i.url));
		for (const link of FALLBACK_LINKS) {
			assert.ok(cms.has(link.href), `fallback offers ${link.href}, which the CMS menu does not`);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* The intro note                                                              */
/* -------------------------------------------------------------------------- */

describe("the wall intro is CMS content", () => {
	const aSection = (text: string): SectionValue => ({
		id: "section-1",
		slug: INTRO_SECTION,
		title: "Field guide",
		content: [
			{ _type: "block", style: "normal", children: [{ _type: "span", text }] },
		],
	});

	test("the section's own words are what render", async () => {
		const intro = await Effect.runPromise(
			Effect.provide(
				loadIntro(),
				stub({ section: () => Effect.succeed(aSection("Edited in the admin.")) }),
			),
		);
		assert.equal(intro.source, "cms");
		assert.equal(intro.note, null);
		assert.match(JSON.stringify(intro.blocks), /Edited in the admin\./);
	});

	test("a database with no section renders the built-in sentence and says so", async () => {
		const intro = await Effect.runPromise(Effect.provide(loadIntro(), stub({})));
		assert.equal(intro.source, "fallback");
		assert.match(intro.note ?? "", /no field-guide-intro section in this database/);
		assert.match(JSON.stringify(intro.blocks), /Each plate is one distinct possibility/);
	});

	test("an empty section is a fallback rather than an empty band", async () => {
		// An intro band with no sentence under the h1 is a hole, and a hole reads
		// as "the CMS is broken" rather than "there is nothing to say".
		const intro = await Effect.runPromise(
			Effect.provide(
				loadIntro(),
				stub({
					section: () =>
						Effect.succeed({
							id: "section-1",
							slug: INTRO_SECTION,
							title: "Field guide",
							content: [],
						}),
				}),
			),
		);
		assert.equal(intro.source, "fallback");
		assert.match(intro.note ?? "", /has no content/);
	});

	test("a section that will not decode is a fallback with the reason attached", async () => {
		const intro = await Effect.runPromise(
			Effect.provide(
				loadIntro(),
				stub({
					failSection: Effect.fail(
						new CatalogueDecodeError({ subject: `section ${INTRO_SECTION}`, detail: "Expected string" }),
					),
				}),
			),
		);
		assert.equal(intro.source, "fallback");
		assert.match(intro.note ?? "", /did not match the catalogue contract/);
	});

	test("the fallback sentence is a literal, not content that looks editable", () => {
		// It is a `const` in source, deliberately, and it is never what the site
		// shows when the database is healthy. Asserting that keeps it that way:
		// a CMS field nothing reads is worse than no field, and so is a shipped
		// default that quietly becomes the real one.
		assert.match(JSON.stringify(FALLBACK_INTRO_BLOCKS), /Each plate is one distinct possibility/);
	});
});

/* -------------------------------------------------------------------------- */
/* Which page is this                                                          */
/* -------------------------------------------------------------------------- */

describe("isCurrentLink", () => {
	test("the root matches only the root", () => {
		// `current.startsWith("/")` is true for every route, so a naive prefix
		// rule marks every page as being on the home link.
		assert.equal(isCurrentLink("/", "/"), true);
		assert.equal(isCurrentLink("/verticals", "/"), false);
		assert.equal(isCurrentLink("/pages/about", "/"), false);
	});

	test("a section link is current on itself and on anything under it", () => {
		assert.equal(isCurrentLink("/pages/licensing", "/pages/licensing"), true);
		assert.equal(isCurrentLink("/pages/licensing#the-statuses", "/pages/licensing"), true);
		assert.equal(isCurrentLink("/possibilities/density-gradient", "/possibilities"), true);
		// And a prefix that is not a path boundary is not a match:
		// `/collectionsx` is not inside `/collections`.
		assert.equal(isCurrentLink("/collectionsx", "/collections"), false);
	});

	test("a fragment or query does not affect the match", () => {
		assert.equal(isCurrentLink("/search", "/search?q=seam"), true);
		assert.equal(isCurrentLink("/pages/licensing", "/pages/licensing#the-statuses"), true);
	});

	test("an external link is never the current page", () => {
		assert.equal(isCurrentLink("/", "https://github.com/loftwah/asset-hunter"), false);
	});
});

/* -------------------------------------------------------------------------- */
/* The duplication is structurally gone                                       */
/* -------------------------------------------------------------------------- */

/** The destinations the shipped seed's primary menu declares, in order. */
const seedMenuHrefs = (): string[] => {
	const seed = JSON.parse(readFileSync(`${root}seed/seed.json`, "utf8"));
	const menu = seed.menus.find((m: { name: string }) => m.name === PRIMARY_MENU);
	return (menu?.items ?? []).map((i: { url: string }) => i.url);
};

describe("the hard-coded navigation has not come back", () => {
	const base = readFileSync(`${root}src/layouts/Base.astro`, "utf8");

	test("the layout declares no navigation array", () => {
		// The failure this exists to prevent is a literal list of nav items in
		// the layout. A source assertion catches it the moment it is written,
		// which a behavioural test cannot: a duplicated list renders identically
		// to the CMS one right up until somebody edits the menu.
		assert.doesNotMatch(
			base,
			/const\s+nav\s*=\s*\[/,
			"Base.astro declares a navigation array. The nav is CMS content — read it with loadPrimaryNav().",
		);
		// And the specific shape it had.
		assert.doesNotMatch(
			base,
			/href:\s*"\/verticals"[\s\S]{0,200}href:\s*"\/collections"/,
			"Base.astro re-declares the menu items. The nav is CMS content.",
		);
	});

	test("the layout reads the menu through the shell module", () => {
		assert.match(base, /import\s+\{[^}]*loadPrimaryNav/);
		// Not a bare `getMenu` call either: a read that bypasses the Effect
		// boundary has no timeout, no retry and no typed failure.
		assert.doesNotMatch(base, /from\s+"emdash"/);
	});

	test("the layout marks where the navigation came from", () => {
		// `data-nav-source` is the attribute a test and a human both read. A
		// fallback that is not marked in the DOM is a fallback nobody can see.
		assert.match(base, /data-nav-source=\{nav\.source\}/);
	});

	test("the footer's utility column does not repeat the menu", () => {
		// The footer's "Catalogue" column *is* the menu, so an admin edit moves
		// both. Its other columns are structural links that have to be there
		// whatever the menu says. A destination in both renders twice in the
		// footer, which is the duplication this change exists to remove — the
		// gallery was in both for a while.
		const project = base.match(/<h2 class="tag">Project<\/h2>\s*<ul>([\s\S]*?)<\/ul>/)?.[1];
		assert.ok(project, "the footer's Project column is missing");
		const declared = seedMenuHrefs();
		for (const href of [...project.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) {
			assert.ok(
				!declared.includes(href),
				`the footer lists ${href}, which the CMS menu also carries — it would render twice`,
			);
		}
		// And the structural link that must never be missing, because it is the
		// rights explanation: an obligation is not an editor's decision.
		const rights = base.match(/<h2 class="tag">Rights<\/h2>\s*<ul>([\s\S]*?)<\/ul>/)?.[1];
		assert.ok(rights?.includes('href="/pages/licensing"'));
	});
});

describe("the shipped seed declares the navigation the site reads", () => {
	const seed = JSON.parse(readFileSync(`${root}seed/seed.json`, "utf8"));
	const menu = seed.menus.find((m: { name: string }) => m.name === PRIMARY_MENU);

	test("there is a primary menu and it has items", () => {
		assert.ok(menu, "seed/seed.json declares no primary menu — the masthead has nothing to read");
		assert.ok(menu.items.length > 0, "the primary menu is empty");
	});

	test("every menu item is a safe href and has a label", () => {
		for (const item of menu.items) {
			assert.ok(item.label?.trim(), `menu item ${item.url} has no label`);
			assert.match(
				item.url,
				/^(\/(?![/\\])|#|https?:|mailto:|tel:)/,
				`menu item ${item.url} is not a safe href`,
			);
		}
	});

	test("every internal menu target is a route that exists or a page that is seeded", () => {
		// `/`, `/verticals` and `/collections` are routes in `src/pages`.
		// `/pages/<slug>` is resolved from CMS content, so its target has to be a
		// seeded page rather than a file.
		const routes = new Set(["/", "/verticals", "/collections", "/board", "/gallery"]);
		const pages = new Set<string>(
			seed.content.pages.map((p: { slug: string }) => p.slug),
		);
		for (const item of menu.items) {
			const url: string = item.url;
			if (!url.startsWith("/")) continue;
			if (url.startsWith("/pages/")) {
				const slug = url.slice("/pages/".length);
				assert.ok(pages.has(slug), `menu points at /pages/${slug}, which is not a seeded page`);
				continue;
			}
			assert.ok(routes.has(url), `menu points at ${url}, which is not a route`);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* The gallery shows the product, and says so                                 */
/* -------------------------------------------------------------------------- */

describe("the gallery is real captures of the product", () => {
	test("every declared image is a file that exists", () => {
		// The same reasoning as `tests/seed.test.ts`'s fixture check. A manifest
		// naming a missing image is worse than no gallery: the page looks
		// finished and shows an empty frame.
		const missing = GALLERY_SHOTS.filter((shot) => !existsSync(`${root}public${shot.file}`));
		assert.deepEqual(
			missing.map((s) => s.file),
			[],
			"run `npm run capture:reference` against a dev server to produce the gallery images",
		);
	});

	test("each image is the capture of a route the site serves", () => {
		// A capture is evidence, and evidence of a route that 404s is worse than
		// none. `tests/routes.test.ts` fetches them over HTTP; this is the cheap
		// half that runs with no server.
		for (const shot of GALLERY_SHOTS) {
			assert.ok(shot.route.startsWith("/"), `${shot.file} names a non-path route ${shot.route}`);
			assert.ok(shot.caption.length > 40, `${shot.file} has a caption too thin to be an alt text`);
			assert.ok(shot.width > 0 && shot.height > 0, `${shot.file} has no intrinsic size`);
		}
	});

	test("the gallery images come from the same capture pass as the reference set", () => {
		// Byte-identical, not merely similar. A second screenshot pass differs by
		// a webfont that finished loading a frame later, and then the public page
		// is showing a composition the design review does not contain.
		const pairs: Record<string, string> = {
			"wall.png": "wall--1280.png",
			"drill-in.png": "detail--1280.png",
			"search.png": "search--1280.png",
			"licensing.png": "licensing--1280.png",
			"phone.png": "wall-mobile--390.png",
		};
		for (const shot of GALLERY_SHOTS) {
			const source = pairs[shot.file.replace("/gallery/", "")];
			assert.ok(source, `${shot.file} is not one of the declared capture copies`);
			const gallery = readFileSync(`${root}public${shot.file}`);
			const reference = readFileSync(`${root}reference/${source}`);
			assert.deepEqual(
				[...gallery],
				[...reference],
				`public/${shot.file} differs from reference/${source} — re-run \`npm run capture:reference\``,
			);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* The quick start says only what is true                                     */
/* -------------------------------------------------------------------------- */

describe("the quick start does not teach a command that does not exist", () => {
	const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
	const atlas = JSON.parse(readFileSync(`${root}seed/atlas.json`, "utf8"));
	const quickstart = atlas.pages.find((p: { slug: string }) => p.slug === "quickstart");
	assert.ok(quickstart, "seed/atlas.json declares no quickstart page");

	/**
	 * Every `npm run <script>` the page names, in order of appearance.
	 *
	 * A quick start is the one page where a plausible-looking command is a
	 * silent failure: somebody copies it, it errors, and nothing tells them the
	 * script was renamed. So the assertion is against `package.json`, which is
	 * the only authority on what this repository can run.
	 */
	const commands = (): string[] =>
		[...JSON.stringify(quickstart.body).matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]);

	test("every command it names is a script this repository has", () => {
		const named = [...new Set(commands())];
		assert.ok(named.length >= 5, `only ${named.length} commands on the quick start`);
		for (const script of named) {
			assert.ok(pkg.scripts[script], `the quick start names \`npm run ${script}\`, which package.json does not define`);
		}
	});

	test("it does not promise the hunt is part of serving the site", () => {
		// The issue's acceptance criterion: core local hunt operation does not
		// depend on public hosting. Saying otherwise here would be the kind of
		// claim this project does not make anywhere else.
		const copy = quickstart.body
			.map((b: { children?: { text?: string }[] }) => (b.children ?? []).map((c) => c.text ?? "").join(""))
			.join(" ");
		assert.match(copy, /does not write to the CMS/);
		assert.match(copy, /never decides what the public catalogue shows/);
	});
});

/* -------------------------------------------------------------------------- */
/* Service substitution is real, not a type-only promise                      */
/* -------------------------------------------------------------------------- */

describe("the shell's reads are substitutable like every other CMS read", () => {
	test("loadPrimaryNav runs against a substituted CMS, with no database", async () => {
		const nav = await Effect.runPromise(
			Effect.provide(
				loadPrimaryNav(),
				stub({
					menu: () =>
						Effect.succeed({
							menu: aMenu([{ id: "1", label: "Only link", url: "/" }]),
							cacheHint: undefined,
						}),
				}),
			),
		);
		assert.equal(nav.links.length, 1);
		assert.equal(nav.links[0]?.label, "Only link");
	});

	test("both shell reads resolve from the same service the catalogue uses", async () => {
		// The enforcement is the type signature: `loadPrimaryNav` and
		// `loadIntro` name `EmDashContent` in their `R` channel, so the stub
		// above satisfies both, and a shell read that had grown its own service
		// would not compile here.
		const both = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const nav = yield* loadPrimaryNav();
					const intro = yield* loadIntro();
					return { nav, intro };
				}),
				stub({}),
			),
		);
		assert.equal(both.nav.source, "fallback");
		assert.equal(both.intro.source, "fallback");
	});
});
