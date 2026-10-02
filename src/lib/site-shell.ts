/**
 * The public shell's CMS-managed content: the primary navigation and the
 * homepage's opening note.
 *
 * ## Why this module exists
 *
 * Issue #17 said: *"Admin-editable copy/navigation belongs in EmDash rather
 * than hard-coded duplicate configuration where practical."* The shell was
 * built before that sentence was written, and it did the thing the sentence
 * forbids:
 *
 * ```ts
 * // src/layouts/Base.astro, before
 * const nav = [
 *   { href: "/", label: "Catalogue" },
 *   { href: "/verticals", label: "Verticals" },
 *   // …identical to `seed/seed.json` → `menus.primary.items`, which nothing read
 * ];
 * ```
 *
 * Two copies of one list, one of them inert. Editing the navigation in the
 * EmDash admin — the first thing anybody would try, and the reason the seed
 * declares a `primary` menu at all — changed nothing a reader could see. A
 * config file that looks editable and is not is worse than no config file.
 *
 * So the list moves here, it is read from EmDash, and the layout renders
 * whatever EmDash says. The `primary` menu in the seed is now what actually
 * decides the masthead, which is the only arrangement in which the admin edit
 * works.
 *
 * ## The fallback, and why it is not a second source of truth
 *
 * A database with no `primary` menu — a fresh D1 that has had the schema but
 * not the seed content applied, or a menu somebody deleted — must not take the
 * whole site down, because the masthead is on every page including the 404.
 * So there is a fallback, and it is deliberately bad at pretending to be real:
 *
 * - it is a **constant with no label of its own**: the three destinations are
 *   routes this application already requires to exist, not a curated set;
 * - it is marked in the DOM (`data-nav-source="fallback"`) so a human reading
 *   the page, a test, or a screenshot can tell;
 * - it is announced on the server, on every request, so the log says why;
 * - and {@link loadPrimaryNav} returns `source: "fallback"`, which is the
 *   whole point: the layout is required to say where the links came from rather
 *   than quietly substituting a list. `tests/site-shell.test.ts` fails if the
 *   live masthead is ever serving the fallback, and `scripts/check-nav.mjs`
 *   fails if the rendered nav does not equal the CMS menu.
 *
 * What the fallback deliberately does **not** do is keep its own copy of the
 * menu. It does not learn, drift, or grow into a list somebody maintains on the
 * side. The day EmDash answers, the CMS list is what renders.
 *
 * ## Vocabulary
 *
 * The masthead labels are EmDash's, so they are not re-derived from slugs here
 * and they are deliberately *not* run through `src/lib/vocabulary.ts` — that
 * module is for slugs this application owns, and a menu label is a person's
 * words. Term choice stays with the CMS.
 */
import { Effect } from "effect";
import { isSafeHref, type CacheHint } from "emdash";
import { EmDashContent, type MenuValue, type SectionValue } from "./effect/emdash.ts";
import { describeError, type EmDashError } from "./effect/errors.ts";

/** Where the shell's copy came from. The layout must not hide this. */
export type ShellSource = "cms" | "fallback";

export interface ShellLink {
	readonly href: string;
	readonly label: string;
	/** A link that leaves this site. Rendered with the ordinary markup. */
	readonly external: boolean;
}

export interface PrimaryNav {
	readonly links: ReadonlyArray<ShellLink>;
	readonly source: ShellSource;
	/**
	 * Why the fallback is in use, in one sentence, for a log line. `null` when
	 * the CMS answered — the healthy case has nothing to report.
	 */
	readonly note: string | null;
	/**
	 * EmDash's edge-cache hint for the menu, for `Astro.cache.set`.
	 *
	 * Present only when the CMS answered. This is what makes an admin edit
	 * actually reach a cached route: without it a page rendered before the edit
	 * keeps serving the old navigation, and the change looks like it did
	 * nothing — the exact failure this whole change exists to end.
	 */
	readonly cacheHint: CacheHint | undefined;
}

/** The name of the menu the masthead renders. One place, so it cannot drift. */
export const PRIMARY_MENU = "primary";

/** The slug of the section that supplies the homepage's opening note. */
export const INTRO_SECTION = "field-guide-intro";

/**
 * The destinations the shell cannot render without.
 *
 * Three, and the number is the point: this is not a shortened copy of the CMS
 * menu, it is the irreducible minimum — the wall, and the two pages that carry
 * an obligation (rights, and what the project is). A larger list would start
 * being a second opinion about what the navigation should contain, which is
 * exactly the duplication this module exists to end.
 *
 * `tests/site-shell.test.ts` asserts it stays at three and that it never offers
 * a destination the CMS menu does not also offer.
 */
export const FALLBACK_LINKS: ReadonlyArray<ShellLink> = [
	{ href: "/", label: "Catalogue", external: false },
	{ href: "/pages/licensing", label: "Licensing", external: false },
	{ href: "/pages/about", label: "About", external: false },
];

/** A menu item as the CMS stores it, reduced to what the shell renders. */
const isExternal = (href: string): boolean => /^(https?:)?\/\//i.test(href);

/**
 * Projects a CMS menu onto the links the shell renders.
 *
 * Pure, and the only place the transformation happens. Three decisions, each
 * with a reason:
 *
 * 1. **An unsafe href is dropped, not rendered.** `isSafeHref` is EmDash's own
 *    check and it is applied here rather than trusted upstream: a `javascript:`
 *    URL in a menu item is stored data, and this is the render boundary.
 * 2. **A blank label falls back to the href**, because a link with no text is
 *    invisible to a screen reader and unclickable by voice. Dropping it would
 *    also be defensible; showing the path is more useful.
 * 3. **`#`-prefixed hrefs are kept.** EmDash's `getMenu` already resolves
 *    content links to paths, so this is belt-and-braces for a custom item.
 *
 * Note what is *not* here: no label rewriting, no slug casing, no route
 * knowledge. A menu is a person's editorial decision about this site's
 * navigation, and the shell renders it.
 */
export function navFromMenu(menu: MenuValue | null): ReadonlyArray<ShellLink> {
	if (!menu) return [];
	const links: ShellLink[] = [];
	for (const item of menu.items) {
		const href = (item.url ?? "").trim();
		if (!href || !isSafeHref(href)) continue;
		links.push({
			href,
			label: item.label?.trim() || href,
			external: isExternal(href),
		});
	}
	return links;
}

/**
 * Reads the primary menu.
 *
 * The interesting decision is that a *failure* is not a failure. If EmDash is
 * unreachable, the timeout elapses, or the menu simply is not there, the shell
 * still has to render — an unreadable database must not take down every page
 * including the 404 and the search page.
 *
 * So this catches its own errors and reports them as `source: "fallback"` with
 * a `note` explaining which of the two things happened. That is a deliberate
 * exception to the rule `src/lib/catalogue.ts` follows, and the difference is
 * what the fallback cost: a missing possibility makes the wall *empty* and
 * says so, while a missing menu makes the masthead *short* and says so too. A
 * reader is misled by an empty catalogue; nobody is misled by three links where
 * there were five, and `check:nav` fails the build on that state.
 */
export function loadPrimaryNav(): Effect.Effect<PrimaryNav, never, EmDashContent> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const found = yield* emdash.menu(PRIMARY_MENU).pipe(
			Effect.map((result) => ({ ok: true as const, result })),
			Effect.catchTag("EmDashTransportError", (error) => Effect.succeed({ ok: false as const, error })),
			Effect.catchTag("CatalogueDecodeError", (error) => Effect.succeed({ ok: false as const, error })),
		);

		if (!found.ok) {
			return {
				links: FALLBACK_LINKS,
				source: "fallback" as const,
				note: `${PRIMARY_MENU} menu unreadable — ${describeError(found.error as EmDashError)}`,
				cacheHint: undefined,
			};
		}

		const links = navFromMenu(found.result.menu);
		if (links.length === 0) {
			return {
				links: FALLBACK_LINKS,
				source: "fallback" as const,
				note:
					found.result.menu === null
						? `no ${PRIMARY_MENU} menu in this database — the seed has not been applied, or the menu was deleted`
						: `the ${PRIMARY_MENU} menu has no usable items`,
				cacheHint: undefined,
			};
		}

		return { links, source: "cms" as const, note: null, cacheHint: found.result.cacheHint };
	});
}

/** The homepage's opening note, as Portable Text plus where it came from. */
export interface IntroNote {
	readonly blocks: ReadonlyArray<unknown>;
	readonly source: ShellSource;
	readonly note: string | null;
}

/**
 * The shipped copy, used when the section is absent.
 *
 * This is a `const` in a source file rather than a value in the CMS on purpose:
 * it is the last-resort rendering of a band, it is never edited as content, and
 * a test asserts the CMS section is what the site actually shows. If the two
 * ever disagree, the CMS wins — this only exists so a database without the
 * section renders a sentence rather than an empty band with an `<h1>` in
 * someone else's place.
 */
export const FALLBACK_INTRO_BLOCKS: ReadonlyArray<unknown> = [
	{
		_type: "block",
		_style: "normal",
		_key: "fallback-lede",
		markDefs: [],
		children: [
			{
				_type: "span",
				_key: "fallback-lede-span",
				marks: [],
				// Byte-identical to `seed/atlas.json` → `field-guide-intro`, so a
				// reader who lands on a database with no section and a reader who
				// lands on a healthy one see the same sentence.
				text: "Each plate is one distinct possibility rather than one file. Drill in for the technique, the build notes, a prompt scaffold and the rights.",
			},
		],
	},
];

/**
 * Reads the homepage's opening note from the CMS section.
 *
 * Same failure policy as the menu, for the same reason: the wall is the
 * product, and a homepage that 500s because a section is missing would be a
 * worse outcome than a homepage showing its shipped sentence. `note` says which
 * happened, so the log and the test can tell them apart.
 */
export function loadIntro(): Effect.Effect<IntroNote, never, EmDashContent> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const found = yield* emdash.section(INTRO_SECTION).pipe(
			Effect.map((section) => ({ ok: true as const, section })),
			Effect.catchTag("EmDashTransportError", (error) => Effect.succeed({ ok: false as const, error })),
			Effect.catchTag("CatalogueDecodeError", (error) => Effect.succeed({ ok: false as const, error })),
		);

		if (!found.ok) {
			return {
				blocks: FALLBACK_INTRO_BLOCKS,
				source: "fallback" as const,
				note: `intro section unreadable — ${describeError(found.error as EmDashError)}`,
			};
		}

		const section: SectionValue | null = found.section;
		const blocks = section?.content ?? [];
		if (blocks.length === 0) {
			return {
				blocks: FALLBACK_INTRO_BLOCKS,
				source: "fallback" as const,
				note:
					section === null
						? `no ${INTRO_SECTION} section in this database — the seed has not been applied, or the section was deleted`
						: `the ${INTRO_SECTION} section has no content`,
			};
		}

		return { blocks, source: "cms" as const, note: null };
	});
}

/** The path part of a href, without its fragment or query. */
const pathOf = (value: string): string => value.split(/[?#]/)[0] ?? value;

/**
 * Whether a link is the page the reader is already on.
 *
 * The rule is "this href, or something under it", with `/` special-cased
 * because `current.startsWith("//")` is never true and `""` would otherwise
 * match every route. Kept here rather than in the layout so the masthead, the
 * footer and any future secondary nav agree on what "current" means — which is
 * the whole reason `docs/VOCABULARY.md` exists.
 *
 * Both sides are reduced to a path first. `Astro.url.pathname` never carries a
 * fragment or a query, but a menu href routinely does
 * (`/pages/licensing#the-statuses`), and comparing the two raw would leave the
 * link unmarked as current on the page it scrolls to.
 */
export function isCurrentLink(current: string, href: string): boolean {
	const here = pathOf(current);
	const path = pathOf(href);
	if (path === "/") return here === "/";
	// An external or non-path destination is never the current page, and must
	// not be prefix-matched: `/possibilities` would otherwise claim
	// `https://example.com/possibilities/x`.
	if (!path.startsWith("/")) return false;
	return here === path || here.startsWith(`${path}/`);
}
