/**
 * Exhaustive search/filter behaviour, driven against the live CMS.
 *
 * Search is the main discovery entry point once someone knows what they want,
 * so its edge cases matter more than the happy path: blank query, no matches,
 * a query that only matches documentation, and the filter that must agree with
 * the URL.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

let serverUp = false;
before(async () => {
	try {
		const res = await fetch(`${baseUrl}/`);
		serverUp = res.ok;
	} catch {
		serverUp = false;
	}
});

/** Skips rather than fails when no server is running, so unit tests stay usable. */
function live(name, fn) {
	test(name, async (t) => {
		if (!serverUp) {
			t.skip(`no server at ${baseUrl} — start with \`npm run dev\``);
			return;
		}
		await fn();
	});
}

const text = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("wall", () => {
	live("renders every seeded possibility", async () => {
		const html = await (await fetch(`${baseUrl}/`)).text();
		const tiles = (html.match(/class="tile__link"/g) ?? []).length;
		assert.ok(tiles >= 20, `expected the full wall, got ${tiles} tiles`);
	});

	live("every tile links to a detail route that resolves", async () => {
		const html = await (await fetch(`${baseUrl}/`)).text();
		const slugs = [...new Set([...html.matchAll(/href="\/possibilities\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
		assert.ok(slugs.length > 0, "no tiles on the wall");
		for (const slug of slugs) {
			const res = await fetch(`${baseUrl}/possibilities/${slug}`);
			assert.equal(res.status, 200, `/possibilities/${slug} → ${res.status}`);
		}
	});

	live("the vertical filter is reflected in the URL and the content", async () => {
		const all = await (await fetch(`${baseUrl}/`)).text();
		const games = await (await fetch(`${baseUrl}/?vertical=games`)).text();

		const allTiles = (all.match(/class="tile__link"/g) ?? []).length;
		const gamesTiles = (games.match(/class="tile__link"/g) ?? []).length;
		assert.ok(gamesTiles < allTiles, `filter did not reduce results: ${gamesTiles} vs ${allTiles}`);
		assert.ok(gamesTiles > 0, "filter removed everything");

		// Every remaining tile must belong to the requested vertical.
		const verticals = [...games.matchAll(/class="tile" data-vertical="([a-z0-9-]+)"/g)].map((m) => m[1]);
		assert.ok(verticals.length > 0, "no tiles with a vertical attribute");
		for (const v of new Set(verticals)) {
			assert.equal(v, "games", `filter leaked ${v}`);
		}
	});

	live("an unknown vertical falls back to the full wall rather than erroring", async () => {
		const res = await fetch(`${baseUrl}/?vertical=not-a-vertical`);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.ok((html.match(/class="tile__link"/g) ?? []).length > 0);
	});

	live("the tally reports zero verified sources rather than an estimate", async () => {
		const html = await (await fetch(`${baseUrl}/`)).text();
		// Astro appends a scoping attribute to class attributes, so match the
		// class token rather than the whole attribute.
		const tally = text(html.match(/<dl class="tally"[^>]*>([\s\S]*?)<\/dl>/)?.[1] ?? "");
		assert.match(tally, /Upstream sources verified\s*0/i);
	});
});

describe("detail pages", () => {
	live("show technique, build notes and a prompt scaffold", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		for (const heading of ["Technique", "Build notes", "Prompt scaffold", "Rights"]) {
			assert.ok(html.includes(heading), `missing section: ${heading}`);
		}
	});

	live("state the rights status in words, not colour alone", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		assert.match(html, /Reference only/i);
		// The disclaimer must be present, not just the status label.
		assert.match(text(html), /discovery does not grant rights/i);
	});

	live("show the representative origin", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		assert.match(html, /Generated specimen|Generated/);
	});

	live("list the examples for the possibility", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		assert.match(html, /class="examples\b/);
		// Count only the example items, not the section or its child parts.
		const items = (html.match(/<li class="example"/g) ?? []).length;
		assert.ok(items >= 1, "no example items rendered");
	});

	live("an unknown slug 404s rather than rendering an empty page", async () => {
		const res = await fetch(`${baseUrl}/possibilities/not-a-real-possibility`);
		assert.equal(res.status, 404);
	});

	live("offer related possibilities", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		assert.match(html, /Related possibilities/);
		const related = (html.match(/href="\/possibilities\/[a-z0-9-]+"/g) ?? []).length;
		assert.ok(related > 1, "no related links beyond the page itself");
	});
});

describe("search", () => {
	live("a blank query offers starting points instead of an error", async () => {
		const html = await (await fetch(`${baseUrl}/search`)).text();
		assert.equal(html.includes("No match"), false);
		assert.match(html, /Browse instead/);
	});

	live("finds a known term", async () => {
		const html = await (await fetch(`${baseUrl}/search?q=seam`)).text();
		assert.match(html, /possibilit(y|ies)/);
		assert.ok((html.match(/class="tile__link"/g) ?? []).length > 0, "no results for a known term");
	});

	live("reports no match honestly for a nonsense query", async () => {
		const html = await (await fetch(`${baseUrl}/search?q=zzzqqxnothing`)).text();
		assert.match(html, /No match for/);
		assert.ok((html.match(/class="tile__link"/g) ?? []).length === 0);
	});

	live("the result count matches what is listed", async () => {
		const html = await (await fetch(`${baseUrl}/search?q=seam`)).text();
		const countHtml = html.match(/<p class="count"[^>]*>([\s\S]*?)<\/p>/)?.[1];
		assert.ok(countHtml, "no result count rendered");
		const statedText = text(countHtml);
		// The summary names each kind separately ("3 possibilities · 1
		// collection"), so read each figure rather than summing to the first
		// integer — that would silently pass while the counts were wrong.
		const statedPossibilities = Number.parseInt(
			statedText.match(/(\d+)\s+possibilit/)?.[1] ?? "NaN",
			10,
		);
		const statedCollections = Number.parseInt(
			statedText.match(/(\d+)\s+collection/)?.[1] ?? "0",
			10,
		);
		assert.ok(
			Number.isFinite(statedPossibilities),
			`could not read a possibility count from: ${statedText}`,
		);

		// Collection hits carry an extra class, so count the specific variant
		// separately rather than double-counting the shared `hit` token.
		const listedPossibilities = (html.match(/<div class="hit"/g) ?? []).length;
		const listedCollections = (html.match(/<article class="hit hit--collection"/g) ?? []).length;

		assert.equal(
			statedPossibilities,
			listedPossibilities,
			`stated ${statedPossibilities} possibilities, listed ${listedPossibilities}`,
		);
		assert.equal(
			statedCollections,
			listedCollections,
			`stated ${statedCollections} collections, listed ${listedCollections}`,
		);
	});

	live("marks results noindex so query pages are not crawled", async () => {
		const html = await (await fetch(`${baseUrl}/search?q=seam`)).text();
		assert.match(html, /<meta name="robots" content="noindex, follow"/);
	});

	live("marks the blank search page noindex too", async () => {
		const html = await (await fetch(`${baseUrl}/search`)).text();
		assert.match(html, /noindex/);
	});
});

describe("collections", () => {
	live("lists every seeded collection", async () => {
		const html = await (await fetch(`${baseUrl}/collections`)).text();
		assert.ok((html.match(/class="collection"/g) ?? []).length >= 4);
	});

	live("a collection page shows its members", async () => {
		const html = await (await fetch(`${baseUrl}/collections/seams`)).text();
		assert.ok((html.match(/class="tile__link"/g) ?? []).length >= 3, "collection rendered no members");
	});

	live("an unknown collection 404s", async () => {
		const res = await fetch(`${baseUrl}/collections/not-real`);
		assert.equal(res.status, 404);
	});
});

describe("verticals", () => {
	live("shows every vertical with a count", async () => {
		const html = await (await fetch(`${baseUrl}/verticals`)).text();
		assert.ok((html.match(/class="row"/g) ?? []).length >= 10);
	});

	live("states that coverage is partial", async () => {
		const html = await (await fetch(`${baseUrl}/verticals`)).text();
		assert.match(text(html), /map of what is currently mapped/i);
	});
});

describe("editorial pages", () => {
	live("about renders its prose from the CMS", async () => {
		const html = await (await fetch(`${baseUrl}/pages/about`)).text();
		assert.match(html, /Possibilities, not files/);
	});

	live("licensing renders all four statuses", async () => {
		const html = await (await fetch(`${baseUrl}/pages/licensing`)).text();
		for (const status of ["Cleared", "Attribution required", "Review required", "Reference only"]) {
			assert.ok(html.includes(status), `missing status: ${status}`);
		}
	});

	live("table-of-contents anchors resolve to real headings", async () => {
		const html = await (await fetch(`${baseUrl}/pages/licensing`)).text();
		// Skip the skip-link, which is a deliberate #main target.
		const anchors = [...html.matchAll(/<a [^>]*href="#([^"]+)"/g)]
			.map((m) => m[1])
			.filter((id) => id !== "main");
		assert.ok(anchors.length >= 3, `no TOC anchors, found ${anchors.join(", ")}`);
		for (const id of anchors) {
			assert.ok(html.includes(`id="${id}"`), `TOC anchor #${id} has no matching heading`);
		}
	});

	live("an unknown page 404s", async () => {
		const res = await fetch(`${baseUrl}/pages/not-a-page`);
		assert.equal(res.status, 404);
	});
});

describe("404", () => {
	live("offers search rather than a dead end", async () => {
		const html = await (await fetch(`${baseUrl}/definitely-not-here`)).text();
		assert.match(html, /Nothing catalogued at this address/);
		assert.ok(html.includes('action="/search"'));
	});

	live("is marked noindex", async () => {
		const html = await (await fetch(`${baseUrl}/definitely-not-here`)).text();
		assert.match(html, /noindex/);
	});

	live("lists verticals as an alternative route", async () => {
		const html = await (await fetch(`${baseUrl}/definitely-not-here`)).text();
		assert.match(html, /Or start from a vertical/);
	});
});

describe("metadata", () => {
	live("every route has a unique title and description", async () => {
		const routes = [
			"/",
			"/verticals",
			"/collections",
			"/possibilities/density-gradient",
			"/pages/about",
		];
		const titles = new Set();
		for (const route of routes) {
			const html = await (await fetch(`${baseUrl}${route}`)).text();
			const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
			const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
			assert.ok(title, `no title on ${route}`);
			assert.ok(description, `no description on ${route}`);
			titles.add(title);
		}
		assert.equal(titles.size, routes.length, "duplicate titles");
	});

	live("canonical URLs are absolute", async () => {
		const html = await (await fetch(`${baseUrl}/`)).text();
		const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
		assert.ok(canonical?.startsWith("https://"), `canonical is not absolute: ${canonical}`);
	});

	live("OG and Twitter metadata is present", async () => {
		const html = await (await fetch(`${baseUrl}/`)).text();
		for (const property of ["og:title", "og:description", "og:image", "og:url"]) {
			assert.ok(html.includes(`property="${property}"`), `missing ${property}`);
		}
		assert.match(html, /name="twitter:card"/);
	});

	live("the detail page OG image is the specimen, not the default", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		assert.match(html, /og:image" content="[^"]*density-gradient\.svg/);
	});

	live("the favicon is a real file", async () => {
		const res = await fetch(`${baseUrl}/favicon.svg`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /svg/);
	});

	live("every route declares a language", async () => {
		for (const route of ["/", "/verticals", "/collections"]) {
			const html = await (await fetch(`${baseUrl}${route}`)).text();
			// Astro adds a scoping attribute, so match the attribute not the tag.
			assert.match(html, /<html [^>]*lang="en"/, `no lang on ${route}`);
		}
	});
});
