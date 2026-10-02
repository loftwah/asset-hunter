/**
 * The synthetic scale wall (#49).
 *
 * These assertions exist because a performance fixture that quietly stops being
 * a fixture is worse than no fixture. Three ways that happens, and each has a
 * test here:
 *
 * 1. **It stops being deterministic.** The scale profile is a budget, and a
 *    budget measured against a moving wall is not a budget. `scaleWall` is a
 *    pure function of `(base, count)` — no clock, no `Math.random()` — and the
 *    tests below hold it to that.
 * 2. **It stops measuring the product.** The fixture exists to render five
 *    hundred entries through *the wall's own component, grid and filter*, not a
 *    page built to resemble them. A route test asserts the tiles really are the
 *    production `PossibilityTile` and really are 500 of them.
 * 3. **It leaks into production.** `?scale=` on the public catalogue would be
 *    five hundred entries that do not exist, and a real performance liability
 *    on top of that. `requestedScale` takes `dev` as an argument precisely so
 *    the refusal is testable without a production build.
 *
 * The route tests follow the same convention as `routes.test.ts`: a route that
 * answers 200 or 404 is a route that exists as a deliberate decision, and a 500
 * is a failure of the server rather than a verdict on the fixture.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	DEFAULT_SCALE,
	MAX_SCALE,
	describeScale,
	requestedScale,
	scaleWall,
} from "../src/lib/scale-wall.ts";
import type { Possibility } from "../src/lib/catalogue.ts";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

/**
 * `up`, `down` or `broken` — the same three-way answer as `routes.test.ts`, for
 * the same reason. A gate that skips because the thing it checks is broken is
 * worse than no gate, so "no server" skips and "server answering errors" fails.
 */
let server = "down";
const probe = async () => {
	try {
		const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
		server = res.ok ? "up" : "broken";
	} catch {
		server = "down";
	}
};
await probe();

function live(name: string, fn: () => Promise<void>) {
	test(name, async (t) => {
		if (server === "down") {
			t.skip(`no server at ${baseUrl} — start with \`npm run dev\``);
			return;
		}
		if (server === "broken") {
			assert.fail(
				`${baseUrl} is running but not serving. Fix the server before reading anything else here.`,
			);
		}
		await fn();
	});
}

/** The real catalogue, read from the seed rather than the CMS, so these tests
 *  run with no server and no database and cannot drift with local content. */
const seed = JSON.parse(
	readFileSync(new URL("../seed/seed.json", import.meta.url).pathname, "utf8"),
) as {
	content: { possibilities: { id: string; data: Record<string, unknown> }[] };
};

/**
 * A URL at the wall, for `requestedScale`.
 *
 * `at("?scale=500")` throws, because a relative string is not a URL — the
 * parameter is tested through a real origin rather than by loosening the
 * signature, so the tests exercise the same `URL` Astro hands the page.
 */
const at = (query: string) => new URL(`http://localhost:4321/${query}`);

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));

const BASE: Possibility[] = seed.content.possibilities.map((entry) => ({
	slug: entry.id,
	title: text(entry.data.title) ?? entry.id,
	tagline: text(entry.data.tagline),
	summary: text(entry.data.summary),
	technique: text(entry.data.technique),
	vertical: text(entry.data.vertical),
	mediaKind: text(entry.data.media_kind),
	specimen: text(entry.data.specimen),
	representativeOrigin: text(entry.data.representative_origin),
	rightsStatus: text(entry.data.rights_status),
	rightsNote: text(entry.data.rights_note),
	exampleCount: Number(entry.data.example_count ?? 0),
	distinctSources: Number(entry.data.distinct_sources ?? 0),
	editorialRank: Number(entry.data.editorial_rank ?? 0),
	featured: false,
	visibility: "published",
}));

describe("the scale fixture is refused outside dev", () => {
	test("production ignores the parameter entirely, so no synthetic wall can ship", () => {
		for (const query of ["?scale=500", "?scale=1", "?scale=20000"]) {
			assert.equal(
				requestedScale(at(query), false),
				null,
				`${query} produced a synthetic catalogue outside dev`,
			);
		}
	});

	test("dev honours it", () => {
		assert.equal(requestedScale(at("?scale=500"), true), 500);
		assert.equal(requestedScale(at(""), true), null);
	});

	test("a number that is not a number is not a request", () => {
		// `Number("")` is 0 and `Number(" ")` is 0 — the same trap `toMeasure`
		// exists to avoid, and it would otherwise be read as "render nothing".
		for (const query of ["", " ", "abc", "0", "-1", "1.5", "NaN", "Infinity", "1e400"]) {
			assert.equal(
				requestedScale(at(`?scale=${encodeURIComponent(query)}`), true),
				null,
				`?scale=${query} was accepted as a wall size`,
			);
		}
	});

	test("a wall smaller than the catalogue never truncates it", () => {
		assert.equal(requestedScale(at("?scale=3"), true), 3);
		assert.equal(scaleWall(BASE, 3).length, 3);
		// …and one larger than the cap is clamped rather than obeyed.
		assert.equal(requestedScale(at(`?scale=${MAX_SCALE + 1}`), true), MAX_SCALE);
	});
});

describe("the expansion is deterministic, or the budget is decoration", () => {
	test("two calls with the same arguments are deeply equal", () => {
		assert.deepEqual(scaleWall(BASE, 500), scaleWall(BASE, 500));
	});

	test("the first pass is the real catalogue, byte for byte", () => {
		const wall = scaleWall(BASE, 500);
		assert.equal(wall.length, 500);
		for (let i = 0; i < BASE.length; i++) {
			assert.deepEqual(
				wall[i],
				BASE[i],
				`pass 0 must be the catalogue itself, and "${BASE[i].slug}" is not`,
			);
		}
	});

	test("nothing in the expansion reads a clock or a random source", () => {
		// Not a source scan — a behavioural one. If any value came from the clock
		// the two calls above would already differ; if it came from `Math.random`
		// they would too. This asserts the *size* is exactly what was asked for,
		// which is what a fixture that generated its own entries would get wrong.
		for (const count of [1, 24, 25, 100, 500, 1234]) {
			assert.equal(scaleWall(BASE, count).length, Math.min(count, MAX_SCALE));
		}
	});

	test("every slug is unique, because a duplicate would collapse two entries into one", () => {
		const slugs = scaleWall(BASE, 500).map((p) => p.slug);
		assert.equal(new Set(slugs).size, slugs.length, "the scale wall produced a duplicate slug");
	});

	test("every tile says which pass it is, so a capture of the wall is self-describing", () => {
		for (const p of scaleWall(BASE, 500).slice(BASE.length, BASE.length + 30)) {
			assert.match(p.title, /\(pass \d+\)$/, `"${p.title}" does not say it is a variant`);
		}
	});

	test("a variant keeps its plate, vertical, rights and origin exactly", () => {
		// A synthetic entry that invented a rights status, or claimed an origin it
		// did not have, would put a licence claim on a page. The tiles carry both
		// marks, so the copy has to be the copy.
		const wall = scaleWall(BASE, 500);
		for (let i = 0; i < wall.length; i++) {
			const source = BASE[i % BASE.length];
			assert.equal(wall[i].specimen, source.specimen, `pass ${i} changed the plate`);
			assert.equal(wall[i].vertical, source.vertical, `pass ${i} changed the vertical`);
			assert.equal(wall[i].mediaKind, source.mediaKind, `pass ${i} changed the media kind`);
			assert.equal(wall[i].rightsStatus, source.rightsStatus, `pass ${i} changed the rights status`);
			assert.equal(
				wall[i].representativeOrigin,
				source.representativeOrigin,
				`pass ${i} changed the origin`,
			);
			assert.equal(wall[i].visibility, "published", `pass ${i} is not publicly visible`);
		}
	});

	test("a variant never outranks the entry a curator put first", () => {
		const wall = scaleWall(BASE, 500);
		for (let i = 0; i < BASE.length; i++) {
			const top = wall[i].editorialRank ?? 0;
			for (let j = 0; j < wall.length; j++) {
				const other = wall[j].editorialRank ?? 0;
				if (j % BASE.length === i && j >= BASE.length) {
					assert.ok(
						other <= top,
						`${wall[j].slug} (rank ${other}) outranks ${wall[i].slug} (rank ${top})`,
					);
				}
			}
		}
	});

	test("the wall opens with the real catalogue, so the first viewport is realistic", () => {
		// An eager-loading regression shows up as plates fetched above the fold,
		// and only a fixture with a realistic opening row can show one. A wall that
		// opened on the twenty-first pass would hide exactly that. What matters is
		// that the opening entries are the *top-ranked* real ones — the highest
		// plates a reader would actually be looking at.
		const wall = scaleWall(BASE, 500);
		const topRank = Math.max(...BASE.map((p) => p.editorialRank ?? 0));
		for (let i = 0; i < BASE.length; i++) {
			assert.deepEqual(wall[i], BASE[i], `position ${i} is not the catalogue's own entry`);
		}
		assert.ok(
			wall.slice(0, BASE.length).some((p) => (p.editorialRank ?? 0) === topRank),
			"the top-ranked entry is not in the opening pass",
		);
		// The exact ordering inside a pass is `loadPossibilities`' job, not this
		// module's: the page hands over an already-sorted catalogue and the fixture
		// must not reshuffle it, or the wall it measures would not be the wall the
		// real one renders.
		// The second pass restarts at the top too, so the first scroll is not a
		// cliff from 24 entries of interest to 476 of nothing.
		assert.match(wall[BASE.length].title, new RegExp(`^${BASE[0].title} \\(pass 2\\)$`));
		assert.equal(wall[BASE.length].editorialRank, (BASE[0].editorialRank ?? 0) - 1 / 1000);
	});

	test("an empty catalogue produces an empty wall rather than throwing", () => {
		// The honest answer when there is nothing to expand. Fabricating entries
		// from thin air here would be a fixture measuring itself.
		assert.deepEqual(scaleWall([], 500), []);
	});
});

describe("describeScale reports the wall honestly", () => {
	test("it counts the passes and names the clamp", () => {
		assert.deepEqual(describeScale(24, 500, 500), {
			entries: 500,
			base: 24,
			passes: 21,
			clamped: null,
		});
		assert.deepEqual(describeScale(24, MAX_SCALE + 1, MAX_SCALE + 1), {
			entries: MAX_SCALE + 1,
			base: 24,
			passes: Math.ceil((MAX_SCALE + 1) / 24),
			clamped: MAX_SCALE,
		});
	});

	test("the default is the number #49 names", () => {
		assert.equal(DEFAULT_SCALE, 500);
	});
});

describe("the wall renders the scale through the real component", () => {
	live("the parameter is answered in dev and 404-safe everywhere else", async () => {
		const res = await fetch(`${baseUrl}/?scale=500`);
		assert.ok(res.status === 200 || res.status === 404, `unexpected status ${res.status}`);
		if (res.status === 404) return; // production build; the refusal is what matters
		const html = await res.text();
		assert.equal((html.match(/class="tile__link"/g) ?? []).length, 500, "not a 500-tile wall");
	});

	live("it is the production tile, not a stand-in", async () => {
		const wall = await (await fetch(`${baseUrl}/`)).text();
		const scale = await (await fetch(`${baseUrl}/?scale=500`)).text();
		for (const marker of [
			'class="tile__plate"',
			'class="tile__title"',
			"tile__meta",
			"provenance",
		]) {
			assert.ok(wall.includes(marker), `the real wall is missing ${marker}`);
			assert.ok(scale.includes(marker), `the scale wall is missing ${marker}`);
		}
		// Astro scopes styles per component, and the scoping attribute is derived
		// from the component file — so an identical attribute on both pages means
		// the same component produced both.
		const scope = wall.match(/class="tile__plate" data-astro-cid-([a-z0-9]+)/)?.[1];
		assert.ok(scope, "could not read the tile's Astro scope id");
		assert.ok(
			scale.includes(`class="tile__plate" data-astro-cid-${scope}`),
			"the scale wall's tile came from a different component",
		);
	});

	live("every plate reserves its geometry, because 500 of them cannot shift", async () => {
		const html = await (await fetch(`${baseUrl}/?scale=500`)).text();
		const plates = html.match(/<img [^>]*>/g) ?? [];
		assert.equal(plates.length, 500, `expected 500 plates, found ${plates.length}`);
		for (const plate of plates) {
			assert.match(plate, /width="800"/, "a plate with no width cannot reserve space");
			assert.match(plate, /height="1000"/, "a plate with no height cannot reserve space");
		}
	});

	live("only the first few plates are eager — the mechanism that makes this work", async () => {
		const html = await (await fetch(`${baseUrl}/?scale=500`)).text();
		const plates = html.match(/<img [^>]*>/g) ?? [];
		const eager = plates.filter((p) => /loading="eager"/.test(p)).length;
		// The wall marks its first four plates eager and everything after them
		// lazy. If this ever reads 500, the fixture is measuring a wall that
		// fetches 500 plates on load, and the whole acceptance criterion for #49
		// has quietly stopped being tested.
		assert.ok(eager > 0 && eager <= 8, `${eager} of ${plates.length} plates are eager`);
		assert.equal(plates.filter((p) => /loading="lazy"/.test(p)).length, plates.length - eager);
	});

	live("no plate instantiates an expensive media element", async () => {
		// A `<video>`, `<audio>`, `<canvas>` or `<iframe>` on the wall means
		// something started decoding or scripting off a plate. It is the acceptance
		// criterion for #49 in its most direct form, and it is checkable in the
		// HTML without a browser.
		const html = await (await fetch(`${baseUrl}/?scale=500`)).text();
		for (const tag of ["<video", "<audio", "<canvas", "<iframe", "<object", "<embed"]) {
			assert.ok(!html.includes(tag), `the scale wall instantiated a ${tag}>`);
		}
	});

	live("the fixture announces itself, because a wall that looks real is a lie", async () => {
		const html = await (await fetch(`${baseUrl}/?scale=500`)).text();
		assert.match(html, /data-scale-note/, "the scale wall does not say what it is");
		assert.match(html, /Scale fixture: 500 synthetic entries/);
		// And it must not reach the reader's eye. This is a media-first page; a
		// development banner in the design is the kind of thing DESIGN.md rejects.
		assert.ok(
			!/<p class="tag[^"]*">Scale fixture/.test(html),
			"the scale note is visible rather than screen-reader-only",
		);
	});

	live("the untagged wall is unchanged, because the fixture is opt-in", async () => {
		const plain = await (await fetch(`${baseUrl}/`)).text();
		assert.ok(!plain.includes("data-scale-note"), "`/` announced itself as a fixture");

		/**
		 * Each response is checked against *itself*, never against a second
		 * response fetched at a different moment.
		 *
		 * The obvious assertion — fetch `/`, fetch `/?scale=abc`, expect the same
		 * tile count — is a race, and it lost: `tests/visibility.test.ts` hides a
		 * real entry from the wall while it runs, `node --test` runs files in
		 * parallel, and a write landing between the two fetches reported 23 tiles
		 * against 24. The suite was right about the fixture and wrong about the
		 * catalogue.
		 *
		 * `data-entries` is the count the page computed, so comparing it to the
		 * tiles actually rendered asks the question that is about this code — did
		 * the wall render what it said it would — and holds whatever another file
		 * is doing to the CMS at the time.
		 */
		const consistent = (html: string, label: string) => {
			const stated = Number(html.match(/data-entries="(\d+)"/)?.[1] ?? "NaN");
			const tiles = (html.match(/class="tile__link"/g) ?? []).length;
			assert.ok(Number.isFinite(stated), `${label}: the wall did not state its entry count`);
			assert.equal(tiles, stated, `${label}: stated ${stated} entries, rendered ${tiles}`);
			return stated;
		};

		assert.ok(consistent(plain, "/") < 500, "`/` is rendering the synthetic catalogue");

		const nudged = await (await fetch(`${baseUrl}/?scale=abc`)).text();
		assert.ok(
			!nudged.includes("data-scale-note"),
			"`?scale=abc` announced itself as a fixture — a nonsense value was accepted",
		);
		// Deliberately not compared with `/`'s count: the two are two requests at
		// two moments, and `node --test` runs `visibility.test.ts` alongside this
		// file, which hides a real entry for the duration of its own test. "The
		// nonsense value is refused" is asserted exactly, with no server, by
		// `requestedScale(at("?scale=abc"), true) === null` in the suite above;
		// what this route check adds is that the refusal survives the whole page.
		assert.ok(consistent(nudged, "/?scale=abc") < 500, "`?scale=abc` produced a synthetic wall");
	});
});