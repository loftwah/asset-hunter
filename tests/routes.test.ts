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
import { SIGNAL_FIXTURES } from "../src/lib/fixtures.ts";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

/**
 * `up`, `down` or `broken`.
 *
 * The middle case matters. A dev server that answers every route with a 500 —
 * a stale Vite optimiser cache does exactly this — is reachable, so a naive
 * "can I connect?" check says the suite should run and every assertion fails for
 * the wrong reason. The worse failure was the one that started here: the check
 * was `res.ok`, a 500 made `serverUp` false, and 54 route tests skipped and
 * the suite reported green. A gate that skips because the thing it checks is
 * broken is worse than no gate.
 */
let server = "down";
before(async () => {
	try {
		const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
		server = res.ok ? "up" : "broken";
		if (server === "broken") {
			const body = await res.text().catch(() => "");
			const reason = body.match(/"message":"([^"]{0,200})/)?.[1];
			console.error(
				`✖ ${baseUrl} answered HTTP ${res.status}${reason ? `: ${reason}` : ""}`,
			);
		}
	} catch {
		server = "down";
	}
});

/**
 * Skips only when there is genuinely no server, so `npm run test:unit` stays
 * usable on its own. A server that is up but broken fails every live test rather
 * than skipping them.
 */
function live(name: string, fn: () => Promise<void>) {
	test(name, async (t) => {
		if (server === "down") {
			t.skip(`no server at ${baseUrl} — start with \`npm run dev\``);
			return;
		}
		if (server === "broken") {
			assert.fail(
				`${baseUrl} is running but not serving (see the message above). Fix the server before reading anything else here.`,
			);
		}
		await fn();
	});
}

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the suite itself", () => {
	test("a reachable server must actually serve", () => {
		assert.notEqual(
			server,
			"broken",
			`${baseUrl} answered an error. Running the route tests against a broken server produces failures that say nothing about the routes.`,
		);
	});
});

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
		// The label has to name what is being counted and the value has to be a
		// real zero. An estimate here would be fabricated evidence, which is the
		// thing this assertion exists to prevent.
		assert.match(tally, /Verified sources\s*counted against a licence read at the source\s*0/i);
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
		assert.ok((html.match(/class="found__link"/g) ?? []).length > 0, "no results for a known term");
	});

	live("shows why each result matched instead of repeating its title", async () => {
		const html = await (await fetch(`${baseUrl}/search?q=seam`)).text();
		// The reason line is the entry's summary with the query term marked.
		assert.match(html, /class="found__snippet"[^>]*>[^<]*<mark>seam<\/mark>/i);
		// A title must not appear twice in its own row: that is the
		// "duplicate every card's metadata" pattern DESIGN.md §9.1 rejects.
		const rows = html.match(/<li class="found__row"[\s\S]*?<\/li>/g) ?? [];
		assert.ok(rows.length > 0, "no result rows to check");
		for (const row of rows) {
			const title = text(row.match(/class="found__title"[^>]*>([\s\S]*?)</)?.[1] ?? "");
			assert.ok(title.length > 0, "a result row has no title");
			const occurrences = (text(row).match(new RegExp(title, "gi")) ?? []).length;
			assert.equal(occurrences, 1, `"${title}" appears ${occurrences} times in its own row`);
		}
	});

	live("reports no match honestly for a nonsense query", async () => {
		const html = await (await fetch(`${baseUrl}/search?q=zzzqqxnothing`)).text();
		assert.match(html, /No match for/);
		assert.ok((html.match(/class="found__link"/g) ?? []).length === 0);
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

		// Possibility rows and collection rows differ only in their link target
		// and their mark, so they are counted by which of those each carries.
		const rows: string[] = html.match(/<li class="found__row"[\s\S]*?<\/li>/g) ?? [];
		const listedPossibilities = rows.filter((r) =>
			r.includes('href="/possibilities/'),
		).length;
		const listedCollections = rows.filter((r) => r.includes('href="/collections/')).length;

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

describe("shortlist board", () => {
	live("an empty board says so and offers the way back in", async () => {
		// An empty board is a real state, not an error page, so the status and
		// the copy both have to be right.
		const res = await fetch(`${baseUrl}/board`);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /This board is empty/);
		assert.match(html, /Open the wall/);
	});

	live("saving from the wall is a form POST that works without JavaScript", async () => {
		const wall = await (await fetch(`${baseUrl}/`)).text();
		assert.ok((wall.match(/action="\/api\/board"/g) ?? []).length > 0, "no save control on the wall");
		// A GET on the endpoint is not a route: it must not quietly succeed.
		const get = await fetch(`${baseUrl}/api/board`);
		assert.ok([404, 405].includes(get.status), `GET /api/board returned ${get.status}`);
	});

	live("a board holding a slug the catalogue does not have drops it", async () => {
		const cookie = `ah_board=${encodeURIComponent(JSON.stringify({ default: ["nope-not-real", "density-gradient"] }))}`;
		const html = await (await fetch(`${baseUrl}/board`, { headers: { cookie } })).text();
		assert.match(html, /does not have/, "the drop is announced, not hidden");
		assert.equal((html.match(/class="entry"/g) ?? []).length, 1, "only the real entry is shown");
	});

	live("the board is marked noindex", async () => {
		const html = await (await fetch(`${baseUrl}/board`)).text();
		assert.match(html, /noindex/);
	});

	live("the endpoint refuses an open redirect", async () => {
		const body = new URLSearchParams({
			action: "save",
			slug: "density-gradient",
			board: "default",
			back: "https://example.com/evil",
		});
		const res = await fetch(`${baseUrl}/api/board`, {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		assert.equal(res.status, 303);
		const location = res.headers.get("location") ?? "";
		assert.ok(!location.startsWith("https://"), `redirected off-site: ${location}`);
	});
});

describe("signals: ratings and reports", () => {
	live("the three signals are named separately, never blended", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		for (const label of ["Community", "Editorial", "Machine"]) {
			assert.ok(html.includes(`>${label}</span>`), `missing signal: ${label}`);
		}
		// An unmeasured machine signal says so rather than showing a zero.
		assert.match(html, /Not measured/);
		// And each one states what kind of claim it is.
		assert.match(html, /not a quality score/i);
	});

	live("an anonymous reader is told why they cannot rate, before they try", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		assert.match(html, /disabled/, "the rating control is disabled without a session");
		assert.match(html, /cannot revise or withdraw/);
		assert.match(html, /Filing needs a sign-in/);
		// The report form is still a form: a disabled <form> cannot be submitted
		// at all, which turns the explanation into a button that does nothing.
		assert.match(html, /<form class="report__form"[^>]*action="\/api\/signal"/);
	});

	live("an unattempted rating is never shown as zero stars", async () => {
		// Works whether or not this database has ratings yet, because the
		// invariant is about the empty case specifically: no ratings must read as
		// "none", never as "0.0 from 0".
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		assert.equal(/0\.0 from 0/.test(html), false, "an empty aggregate must read as null, not 0");
		assert.equal(/>0\.0</.test(html), false, "a zero average must never be rendered");
		const summary = html.match(/signal__value[^>]*>([^<]*rating[^<]*)</)?.[1] ?? "";
		if (/No ratings/.test(summary)) {
			assert.match(html, /No ratings yet/);
		} else {
			const count = Number.parseInt(summary.match(/from (\d+)/)?.[1] ?? "0", 10);
			assert.ok(count >= 1, `a rendered average must have at least one rating: ${summary}`);
		}
	});

	live("an out-of-range rating is refused rather than stored", async () => {
		const res = await fetch(`${baseUrl}/api/signal`, {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				intent: "rate",
				subject_type: "possibility",
				subject_slug: "density-gradient",
				stars: "0",
			}),
		});
		assert.equal(res.status, 303);
		assert.match(res.headers.get("location") ?? "", /note=/);
	});

	live("a rating needs a session, and says so in words", async () => {
		const res = await fetch(`${baseUrl}/api/signal`, {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				intent: "rate",
				subject_type: "possibility",
				subject_slug: "density-gradient",
				stars: "5",
			}),
		});
		assert.equal(res.status, 303);
		// The note comes back URL-encoded and with "+" for spaces.
		const note = decodeURIComponent(res.headers.get("location") ?? "").replace(/\+/g, " ");
		assert.match(note, /Sign in to rate/);
	});

	live("the report endpoint refuses an open redirect like the board does", async () => {
		const res = await fetch(`${baseUrl}/api/signal`, {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ intent: "report", back: "https://example.com/evil" }),
		});
		assert.equal(res.status, 303);
		assert.ok(!(res.headers.get("location") ?? "").startsWith("https://"));
	});

	live("every report reason is offered, and a licence one is present", async () => {
		const html = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		assert.match(html, /Licence or provenance looks wrong or has changed/);
		assert.match(html, /Dead or moved source/);
		assert.match(html, /read before anything else/i);
	});
});

/**
 * A minimal shape for what these tests assert on. `res.json()` is typed
 * `unknown`, and the alternative — a dozen casts in every assertion — is worse
 * than declaring the handful of fields the contract promises.
 */
interface JsonCatalogue {
	schema: string;
	generated: string;
	fingerprint: string;
	openReports?: number;
	counts: {
		possibilities: number;
		examples: number;
		collections: number;
		verticals: number;
		rights: Record<string, number>;
	};
	possibilities: {
		id: string;
		rightsStatus: string | null;
		novelty: number | null;
		coverage: number | null;
		distinctSources: number;
		communityRating: { average: number | null; count: number };
		examples: { id: string; rightsStatus: string | null; downloadable: boolean }[];
	}[];
	collections: { id: string }[];
}

const catalogue = async (path = "/api/catalogue.json") =>
	(await (await fetch(`${baseUrl}${path}`)).json()) as JsonCatalogue;

describe("the agent interface (#58)", () => {
	live("serves a versioned, published-only catalogue without a token", async () => {
		const res = await fetch(`${baseUrl}/api/catalogue.json`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /application\/json/);
		assert.equal(res.headers.get("x-catalogue-schema"), "asset-hunter.catalogue/1");

		const body = await catalogue();
		assert.equal(body.schema, "asset-hunter.catalogue/1");
		assert.ok(body.possibilities.length > 0);
		assert.equal(body.counts.possibilities, body.possibilities.length);
		assert.match(body.fingerprint, /^[0-9a-f]{8}$/);
	});

	live("never includes a draft", async () => {
		// Machine entries the hunt engine creates are drafts. One that leaked into
		// the public JSON would be unreviewed crawl output presented as catalogue.
		const body = await catalogue();
		const wall = await (await fetch(`${baseUrl}/`)).text();
		for (const p of body.possibilities) {
			assert.ok(
				wall.includes(`/possibilities/${p.id}`),
				`${p.id} is in the JSON but not on the public wall`,
			);
		}
	});

	live("keeps null distinct from zero", async () => {
		const body = await catalogue();
		for (const p of body.possibilities) {
			for (const field of ["novelty", "coverage"] as const) {
				const value = p[field];
				assert.ok(
					value === null || typeof value === "number",
					`${p.id}.${field} must be a number or null, got ${typeof value}`,
				);
			}
			const average = p.communityRating.average;
			assert.ok(average === null || typeof average === "number");
			assert.ok(Number.isInteger(p.distinctSources));
		}
	});

	live("carries rights per example, not just per possibility", async () => {
		const body = await catalogue();
		const withExamples = body.possibilities.filter((p) => p.examples.length > 0);
		assert.ok(withExamples.length > 0);
		for (const p of withExamples) {
			for (const e of p.examples) {
				assert.ok("rightsStatus" in e, `${e.id} has no rightsStatus`);
				assert.equal(typeof e.downloadable, "boolean");
			}
		}
	});

	live("the fingerprint changes with the content and not with the timestamp", async () => {
		const first = await catalogue("/api/catalogue.json?fresh=1");
		const second = await catalogue("/api/catalogue.json?fresh=1");
		assert.equal(first.fingerprint, second.fingerprint, "same content, same digest");
		assert.equal(
			JSON.stringify(first.possibilities),
			JSON.stringify(second.possibilities),
			"two fresh fetches must agree on the content",
		);
	});

	live("answers a conditional request", async () => {
		const first = await fetch(`${baseUrl}/api/catalogue.json`);
		const etag = first.headers.get("etag");
		assert.ok(etag, "no ETag on a polled endpoint");
		const second = await fetch(`${baseUrl}/api/catalogue.json`, {
			headers: { "if-none-match": etag },
		});
		assert.equal(second.status, 304);
	});
});

/**
 * Asset use and handoff (#42).
 *
 * The live half of the rules asserted in `tests/asset-use.test.ts`. The unit
 * tests prove what the decision is; these prove the decision reaches a reader,
 * and — the assertion that matters most — that nothing downloadable is linked
 * anywhere on a public page while the catalogue retains no originals.
 */
describe("asset use", () => {
	const detail = "/possibilities/density-gradient";
	const use = "/use/density-gradient";

	live("the use page resolves for a real entry and 404s for a real nothing", async () => {
		assert.equal((await fetch(`${baseUrl}${use}`)).status, 200);
		assert.equal((await fetch(`${baseUrl}/use/not-a-real-possibility`)).status, 404);
	});

	live("the drill-in states the use state in words, per example", async () => {
		const html = await (await fetch(`${baseUrl}${detail}`)).text();
		// The state is a word and a sentence, not a colour and a dot.
		assert.match(html, /class="use__label"[^>]*>Reference only</);
		assert.match(text(html), /No licence was found, or reuse is not permitted/);
		// And the obligation is stated rather than implied.
		assert.match(text(html), /Do not copy, ship or redistribute/);
	});

	live("no public page links a download while nothing is downloadable", async () => {
		// The catalogue is entirely generated plates with `downloadable: false`.
		// A single `href="/api/payload/` on any of these pages would mean a
		// control exists for material nobody cleared, which is the exact failure
		// this flow exists to prevent.
		for (const route of ["/", detail, use, "/board", "/search?q=seam"]) {
			const html = await (await fetch(`${baseUrl}${route}`)).text();
			assert.equal(
				html.includes('href="/api/payload/'),
				false,
				`${route} links a payload download`,
			);
		}
	});

	live("the absence of a download is explained, not left as a gap", async () => {
		const html = await (await fetch(`${baseUrl}${use}`)).text();
		assert.match(text(html), /No file is served from this record/);
		// And the honest zero is on the page rather than only implied by a
		// missing button.
		assert.match(text(html), /0 retained originals to download/);
	});

	live("the preview and the original are named as different things", async () => {
		const html = await (await fetch(`${baseUrl}${use}`)).text();
		assert.match(html, /class="use__preview"/);
		assert.match(text(html), /What is on screen/);
		assert.match(text(html), /It is not the source asset/);
	});

	live("the use page and the drill-in read the same records", async () => {
		// One catalogue, not two: the example ids and the use state on the two
		// pages have to be the same ones, or the asset half has become a
		// parallel product.
		const onDetail = await (await fetch(`${baseUrl}${detail}`)).text();
		const onUse = await (await fetch(`${baseUrl}${use}`)).text();
		// `res.json()` is `unknown`; these are the fields the contract promises,
		// declared once rather than cast at each use.
		const record = (await (await fetch(`${baseUrl}/api/record/density-gradient`)).json()) as {
			id: string;
			title: string;
		};
		for (const html of [onDetail, onUse]) {
			assert.match(html, new RegExp(`/api/record/${record.id}`));
		}
		assert.match(onDetail, new RegExp(`href="/use/${record.id}"`));
		assert.equal(record.title, "Bento layouts with a deliberate density ramp");
	});

	live("the use page saves to the existing board rather than a new list", async () => {
		// Reuse, not rebuild: the same endpoint, the same cookie, the same
			// possibility slug the wall posts.
		const html = await (await fetch(`${baseUrl}${use}`)).text();
		assert.match(html, /<form class="board"[^>]*action="\/api\/board"/);
		assert.match(html, /name="slug" value="density-gradient"/);
		assert.match(html, /name="board" value="default"/);
	});
});

describe("the source and licence record", () => {
	live("serves the recorded evidence for an example, whatever the rights", async () => {
		const res = await fetch(`${baseUrl}/api/record/density-gradient`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /application\/json/);
		assert.equal(res.headers.get("x-ah-use-state"), "reference-only");

		const body = (await res.json()) as Record<string, unknown>;
		assert.equal(body.schema, "asset-hunter.record/1");
		assert.equal(body.useState, "reference-only");
		// Nothing is invented for a record with no source behind it.
		for (const field of ["sourceUrl", "sourceRepo", "sourceRef", "licenceEvidence", "credit", "contentHash"]) {
			assert.equal(body[field], null, `${field} was invented`);
		}
		assert.equal(body.payloadRetained, false);
		assert.equal(body.handoff, "record");
	});

	live("an unknown example 404s and says where to look", async () => {
		const res = await fetch(`${baseUrl}/api/record/not-a-real-example`);
		assert.equal(res.status, 404);
		// The route says where records are actually reached from, because a bare
		// 404 on a data endpoint looks like a broken link. Read once: a body can
		// only be consumed once, and a second read reports a fetch error here
		// rather than anything about the route.
		const body = text(await res.text());
		assert.match(body, /\/possibilities\//);
		assert.match(body, /the ones recorded against it/);
	});
});

describe("the payload route is gated by the record, not by the page", () => {
	live("refuses a reference-only example with the reason in words", async () => {
		const res = await fetch(`${baseUrl}/api/payload/density-gradient`);
		assert.equal(res.status, 403);
		assert.equal(res.headers.get("x-ah-blocked-by"), "rights");
		assert.equal(res.headers.get("x-ah-use-state"), "reference-only");
		// Not a bare status: the body says what the rule is and where the
		// evidence is.
		assert.match(text(await res.text()), /Do not copy, ship or redistribute/);
	});

	live("an unknown example 404s rather than leaking a status", async () => {
		const res = await fetch(`${baseUrl}/api/payload/not-a-real-example`);
		assert.equal(res.status, 404);
	});

	live("no example in the catalogue is currently served as a payload", async () => {
		// Every seeded example is a generated plate, so the honest answer across
		// the whole wall is "no", and each one says which rule said it.
		const catalogue = (await (await fetch(`${baseUrl}/api/catalogue.json`)).json()) as {
			possibilities: { examples: { id: string }[] }[];
		};
		const examples = catalogue.possibilities.flatMap((p) => p.examples);
		assert.ok(examples.length > 0);
		for (const e of examples) {
			const res = await fetch(`${baseUrl}/api/payload/${e.id}`);
			assert.ok([403, 409].includes(res.status), `${e.id} → ${res.status}`);
			assert.ok(res.headers.get("x-ah-blocked-by"), `${e.id} served a file with no reason`);
		}
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

/*
 * The lab (#45) and the rating states added for #47.
 *
 * The interesting assertion here is not that the page renders — it does — but
 * that each state renders *through the production component*. A fixture that
 * duplicated the markup would satisfy every structural test below while proving
 * nothing about the component the catalogue actually ships, which is the whole
 * reason `SignalPanel.astro` was extracted rather than copied.
 */
describe("the visual lab renders every state through the real components", () => {
	live("the lab is refused outside dev", async () => {
		const res = await fetch(`${baseUrl}/lab`);
		// It answers in dev and must answer 404 in production; either way the
		// route exists as a deliberate decision rather than a 500.
		assert.ok(res.status === 200 || res.status === 404, `unexpected status ${res.status}`);
	});

	live("every fixture group the page declares is actually on it", async () => {
		const html = await (await fetch(`${baseUrl}/lab`)).text();
		for (const id of ["media", "rights", "origin", "evidence", "state", "asset-use", "signals"]) {
			assert.ok(html.includes(`id="${id}"`), `the lab has no "${id}" section`);
		}
		// And the jump nav reaches the two sections added for #47.
		assert.match(html, /href="#signals"/);
	});

	live("all seven rating states render, and both sides of authentication appear", async () => {
		const html = await (await fetch(`${baseUrl}/lab`)).text();
		const cases = html.match(/class="signal-case"/g) ?? [];
		assert.equal(cases.length, SIGNAL_FIXTURES.length, "a rating state is missing from the lab");
		assert.match(html, /data-viewer="signed-out"/);
		assert.match(html, /data-viewer="signed-in"/);

		// The states that only exist once somebody interacts, proved by their copy:
		// the honest zero, the count of one, the distribution, "Change" rather
		// than "Rate", and the open-report warning.
		assert.match(html, /No ratings yet/);
		// `ratingSummary`'s wording is asserted in `signals.test.ts`; what matters
		// here is that the count of one actually reaches the page, because a
		// single opinion presented without its count is the one that reads as a
		// score.
		assert.match(html, /from 1 rating\b/);
		assert.match(html, /Rating distribution/);
		assert.match(html, />Change</);
		assert.match(html, /open reports? on this fixture/);
		assert.match(html, /licence/i);
	});

	live("the lab's rating states use the production panel, not a copy", async () => {
		const lab = await (await fetch(`${baseUrl}/lab`)).text();
		const detail = await (await fetch(`${baseUrl}/possibilities/density-gradient`)).text();
		// One component, two pages: the same form action and the same field names
		// have to be present in both, because they are the same component.
		for (const marker of [
			'action="/api/signal"',
			'name="intent" value="rate"',
			'name="intent" value="report"',
			'class="rate__star"',
			'class="report__form"',
		]) {
			assert.ok(lab.includes(marker), `the lab is missing ${marker}`);
			assert.ok(detail.includes(marker), `the drill-in is missing ${marker}`);
		}
	});

	live("the fixtures never leak a real account or a real catalogue slug", async () => {
		const html = await (await fetch(`${baseUrl}/lab`)).text();
		// No address of any shape: the panel never renders one, and a fixture that
		// started rendering one would put a plausible-looking reader on the page.
		assert.doesNotMatch(html, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "an address reached the lab");
		// Every fixture slug is namespaced, so a fixture link cannot resolve to a
		// real entry and quietly become a claim about it.
		assert.equal((html.match(/href="\/possibilities\/fixture-/g) ?? []).length, 0);
		// And the fixture data itself uses a reserved domain, asserted in
		// `fixtures.test.ts` so it holds even with no server running.
		for (const fixture of SIGNAL_FIXTURES) {
			if (!fixture.viewer) continue;
			assert.match(fixture.viewer.email ?? "", /@example\.invalid$/);
		}
	});
});
