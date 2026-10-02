/**
 * `visibility` is honoured by every public read (#37).
 *
 * This is a silent-failure test, not a feature test. `visibility` is written by
 * the engine (`engine/src/merge.ts` creates every machine entry `draft`),
 * declared in the schema, and documented in `docs/ARCHITECTURE.md` — and until
 * this test existed, *nothing in `src/` read it*. EmDash's own `status` filter
 * is publish state, not curation, so an entry a curator had set to `hidden`
 * stayed on the wall, in search, in the JSON contract and in the feed.
 *
 * The live half therefore hides a real seeded entry, proves it disappears from
 * every public surface, and restores it. If it cannot restore, it says so
 * loudly rather than leaving the catalogue short an entry.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

/** The entry the live tests hide. Seeded, so a fresh database has it. */
const SLUG = "density-gradient";

let server: "up" | "down" | "broken" = "down";
let editorCookie: string | null = null;

const headers = () => ({
	cookie: editorCookie!,
	"X-EmDash-Request": "1",
	"content-type": "application/json",
});

/** Restores the entry's real fields. Held at module scope so `after` can use it. */
let restore: (() => Promise<void>) | null = null;

before(async () => {
	try {
		const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
		if (!res.ok) return void (server = "broken");
		server = "up";
	} catch {
		return void (server = "down");
	}

	try {
		const res = await fetch(`${baseUrl}/_emdash/api/setup/dev-bypass`, {
			redirect: "manual",
		});
		const cookie = (res.headers.get("set-cookie") ?? "")
			.split(/,(?=[^;]+?=)/)
			.map((c) => c.split(";")[0].trim())
			.filter(Boolean)
			.join("; ");
		if (cookie.includes("astro-session")) editorCookie = cookie;
	} catch {
		editorCookie = null;
	}

	if (!editorCookie) return;

	// Read the entry and arm the restore before anything can fail, so an
	// interrupted run leaves a restorable record rather than a hidden entry.
	const read = await fetch(`${baseUrl}/_emdash/api/content/possibilities/${SLUG}`, {
		headers: headers(),
	});
	if (!read.ok) return;
	const body = (await read.json()) as {
		data?: { item?: { data?: Record<string, unknown> }; _rev?: string };
	};
	const original = body.data?.item?.data;
	if (!original) return;
	const rev0 = body.data?._rev ?? null;

	// Self-heal a database left hidden by an interrupted run. The alternative is
	// that every subsequent run fails its own baseline assertion and reads as a
	// broken filter rather than as residue from the last attempt — which is the
	// failure mode `scripts/admin-edit-check.mjs` exists to avoid, and the same
	// lesson applies here.
	if (original.visibility !== "published") {
		await fetch(`${baseUrl}/_emdash/api/content/possibilities/${SLUG}`, {
			method: "PUT",
			headers: headers(),
			body: JSON.stringify({ data: { ...original, visibility: "published" }, _rev: rev0 }),
		});
		await fetch(`${baseUrl}/_emdash/api/content/possibilities/${SLUG}/publish`, {
			method: "POST",
			headers: headers(),
		});
	}
	// The revision token is re-read on every restore rather than captured once.
	// EmDash returns 409 when the token is stale, and every write here moves it —
	// so a captured token is guaranteed to be wrong by the second write, which is
	// how a check that restores its own change ends up leaving the change behind.
	restore = async () => {
		const fresh = await fetch(`${baseUrl}/_emdash/api/content/possibilities/${SLUG}`, {
			headers: headers(),
		});
		const current = (await fresh.json()) as {
			data?: { item?: { data?: Record<string, unknown> }; _rev?: string };
		};
		const rev = current.data?._rev ?? rev0;
		const put = await fetch(`${baseUrl}/_emdash/api/content/possibilities/${SLUG}`, {
			method: "PUT",
			headers: headers(),
			body: JSON.stringify({ data: { ...original, visibility: "published" }, _rev: rev }),
		});
		await fetch(`${baseUrl}/_emdash/api/content/possibilities/${SLUG}/publish`, {
			method: "POST",
			headers: headers(),
		});
		if (!put.ok) throw new Error(`restore failed: HTTP ${put.status}`);
	};
});

after(async () => {
	if (!restore) return;
	try {
		await restore();
	} catch (err) {
		console.error(
			`\n✖ could not restore ${SLUG}: ${err instanceof Error ? err.message : String(err)}\n` +
				`  Set its visibility back to "published" in the admin.`,
		);
		process.exitCode = 1;
	}
});

function live(name: string, fn: () => Promise<void>) {
	test(name, async (t) => {
		if (server === "down") {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		if (server === "broken") {
			assert.fail(`${baseUrl} is running but not serving. Fix the server before reading this.`);
		}
		if (!editorCookie) {
			t.skip("no editor session — dev-bypass is development-only");
			return;
		}
		await fn();
	});
}

const get = (path: string) => fetch(`${baseUrl}${path}`, { redirect: "manual" });

describe("isPubliclyVisible", () => {
	test("published and absent are visible", () => {
		// Absent means the field predates it. Defaulting absent to hidden would
		// empty the catalogue the first time this shipped, because the seed's own
		// entries carry no value on older databases.
		assert.equal(isPubliclyVisible("published"), true);
		assert.equal(isPubliclyVisible(null), true);
		assert.equal(isPubliclyVisible(undefined), true);
	});

	test("draft and hidden are not", () => {
		assert.equal(isPubliclyVisible("draft"), false);
		assert.equal(isPubliclyVisible("hidden"), false);
	});

	test("an unrecognised value is not permission", () => {
		// Same direction as `flagValue`: a typo is not consent. If `hidden` were
		// misspelled in the CMS, the entry must disappear rather than appear.
		assert.equal(isPubliclyVisible("Hidden"), false);
		assert.equal(isPubliclyVisible("HIDDEN"), false);
		assert.equal(isPubliclyVisible("hideen"), false);
		assert.equal(isPubliclyVisible("archived"), false);
		assert.equal(isPubliclyVisible(""), false);
	});
});

describe("a withdrawn entry disappears from every public surface", () => {
	live("is absent from the wall, search, the feed, the JSON contract and the drill-in", async () => {
		// Baseline: it is public before the test touches anything. A run that
		// "passes" because the entry was already missing proves nothing.
		const before = await get("/");
		assert.match(await before.text(), new RegExp(`/possibilities/${SLUG}`), "not on the wall to begin with");

		// Hide it.
		const read = await fetch(`${baseUrl}/_emdash/api/content/possibilities/${SLUG}`, {
			headers: headers(),
		});
		const body = (await read.json()) as {
			data?: { item?: { data?: Record<string, unknown> }; _rev?: string };
		};
		const data = { ...body.data!.item!.data, visibility: "hidden" };
		const put = await fetch(`${baseUrl}/_emdash/api/content/possibilities/${SLUG}`, {
			method: "PUT",
			headers: headers(),
			body: JSON.stringify({ data, _rev: body.data?._rev ?? null }),
		});
		assert.ok(put.ok, `hide failed: HTTP ${put.status}`);
		const published = await fetch(
			`${baseUrl}/_emdash/api/content/possibilities/${SLUG}/publish`,
			{ method: "POST", headers: headers() },
		);
		assert.ok(published.ok, `publish failed: HTTP ${published.status}`);

		// Every surface.
		const wallHtml = await (await get("/")).text();
		assert.equal(wallHtml.includes(`/possibilities/${SLUG}`), false, "still on the wall");

		const search = await (await get("/search?q=density")).text();
		assert.equal(
			search.includes(`/possibilities/${SLUG}`),
			false,
			"still in search results",
		);

		const feed = await (await get("/rss.xml")).text();
		assert.equal(feed.includes(SLUG), false, "still in the feed");

		const json = (await (await get("/api/catalogue.json")).json()) as {
			possibilities: { id: string }[];
			counts: { possibilities: number };
		};
		assert.equal(
			json.possibilities.some((p) => p.id === SLUG),
			false,
			"still in the JSON contract",
		);
		// The stated count must not still be counting it. A contract that filters
		// the list but not the count tells a consumer there are more than there are.
		assert.equal(json.counts.possibilities, json.possibilities.length);

		const detail = await get(`/possibilities/${SLUG}`);
		assert.equal(detail.status, 404, "the drill-in still serves a withdrawn entry");

		const verticals = await (await get("/verticals")).text();
		assert.equal(verticals.includes(`/possibilities/${SLUG}`), false, "still in /verticals");
	});

	live("is back when the curator un-hides it", async () => {
		// The armed `restore` from `before` is already the whole un-hide: it
		// re-reads the revision and writes the original record back. Re-arming a
		// second copy here would only duplicate the one thing that has to be right.
		await restore?.();

		// Poll rather than assume. Publishing is synchronous in local D1, but a
		// cached route or a request lifecycle can lag by one request — the same
		// reason `scripts/admin-edit-check.mjs` polls instead of reading once.
		let back = false;
		for (let attempt = 0; attempt < 5 && !back; attempt++) {
			const wall = await (await get("/")).text();
			back = wall.includes(`/possibilities/${SLUG}`);
			if (!back) await new Promise((r) => setTimeout(r, 400));
		}
		assert.ok(back, "did not come back after 5 attempts");
		const detail = await get(`/possibilities/${SLUG}`);
		assert.equal(detail.status, 200);
	});
});

describe("the seed is honest about visibility", () => {
	test("every seeded possibility declares published", async () => {
		// The seed is the source of truth. If it wrote `hidden` or left the field
		// out, the first deploy would publish an empty wall or hide real entries —
		// and neither failure names itself.
		const { readFileSync } = await import("node:fs");
		const seed = JSON.parse(
			readFileSync(new URL("../seed/seed.json", import.meta.url), "utf8"),
		) as { content?: { possibilities?: { data?: { visibility?: string } }[] } };
		const wrong = (seed.content?.possibilities ?? []).filter(
			(p) => p.data?.visibility !== "published",
		);
		assert.deepEqual(
			wrong.map((p) => (p as { id?: string }).id),
			[],
			"seeded possibilities must declare visibility: published",
		);
	});
});

// Imported last so the module-level `before` hook is registered against a stable
// module graph; the pure helpers have no runtime dependency.
import { isPubliclyVisible } from "../src/lib/catalogue.ts";
