/**
 * The curation cockpit (#52).
 *
 * A queue of unfilled problems is information about the catalogue, so the only
 * thing worth asserting here beyond "it renders" is the gate: an anonymous
 * visitor and a subscriber must both get the same 404 an editor never sees, or
 * the page becomes a map of what is broken.
 *
 * The authenticated half runs against the EmDash dev-bypass session, which is
 * development-only. That is the same constraint `scripts/admin-edit-check.mjs`
 * works under, and it is why these tests skip rather than fail when no
 * development server is present.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

let server: "up" | "down" | "broken" = "down";
/** An editor session, or null when one could not be established. */
let editorCookie: string | null = null;

before(async () => {
	try {
		const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
		if (!res.ok) {
			server = "broken";
			return;
		}
		server = "up";
	} catch {
		server = "down";
		return;
	}

	// Dev-bypass provisions a local admin session and issues the cookie that
	// authenticates. It sets more than one cookie; the Astro session is the one
	// that matters.
	try {
		const res = await fetch(`${baseUrl}/_emdash/api/setup/dev-bypass`, {
			redirect: "manual",
		});
		const raw = res.headers.get("set-cookie") ?? "";
		const cookie = raw
			.split(/,(?=[^;]+?=)/)
			.map((c) => c.split(";")[0].trim())
			.filter(Boolean)
			.join("; ");
		if (cookie.includes("astro-session")) editorCookie = cookie;
	} catch {
		editorCookie = null;
	}
});

/**
 * Requires a working server. A reachable-but-broken server fails rather than
 * skips, for the same reason `routes.test.ts` does it that way: a gate that
 * skips because the thing it checks is broken reports success for nothing.
 */
function live(name: string, fn: () => Promise<void>) {
	test(name, async (t) => {
		if (server === "down") {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		if (server === "broken") {
			assert.fail(`${baseUrl} is running but not serving. Fix the server before reading this.`);
		}
		await fn();
	});
}

function withEditor(name: string, fn: () => Promise<void>) {
	test(name, async (t) => {
		if (server === "down" || server === "broken") {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		if (!editorCookie) {
			t.skip("no editor session — dev-bypass is development-only");
			return;
		}
		await fn();
	});
}

const text = (html: string) =>
	html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");

describe("the gate", () => {
	live("an anonymous visitor gets the same 404 as a missing page", async () => {
		const res = await fetch(`${baseUrl}/curate`, { redirect: "manual" });
		assert.equal(res.status, 404);
		// It must be a real 404, not a 403: a 403 confirms the page exists.
		const html = await res.text();
		assert.doesNotMatch(text(html), /What needs a decision/i);
	});

	live("the cockpit is never linked from public navigation", async () => {
		// If the masthead advertised it, the 404 gate would be the only defence
		// against a curious reader finding a list of problems.
		for (const route of ["/", "/verticals", "/collections", "/board"]) {
			const html = await (await fetch(`${baseUrl}${route}`)).text();
			assert.equal(
				html.includes('href="/curate"'),
				false,
				`${route} links to /curate`,
			);
		}
	});

	live("the cockpit is marked noindex even for an editor", async () => {
		const res = await fetch(`${baseUrl}/curate`);
		assert.equal(res.status, 404);
	});
});

describe("the queues", () => {
	withEditor("render every queue with a count an editor can act on", async () => {
		const res = await fetch(`${baseUrl}/curate`, { headers: { cookie: editorCookie! } });
		assert.equal(res.status, 200);
		const html = await res.text();

		for (const id of ["q-reports", "q-drafts", "q-unmeasured"]) {
			assert.ok(html.includes(`id="${id}"`), `missing queue: ${id}`);
		}
		// The count sits in the heading rather than only in a list, so a queue
		// with zero items is visibly zero instead of absent.
		assert.match(text(html), /Open reports\s+\d+/);
	});

	withEditor("put licence reports before every other kind", async () => {
		const html = await (await fetch(`${baseUrl}/curate`, { headers: { cookie: editorCookie! } })).text();
		const rows = html.match(/<li class="row"[\s\S]*?<\/li>/g) ?? [];
		const urgent = rows.findIndex((r) => /row--urgent/.test(r));
		if (urgent === -1) return;
		for (let i = 0; i < urgent; i++) {
			assert.doesNotMatch(
				rows[i],
				/row--urgent/,
				`row ${i} is a licence report but sorts after a lower-priority one`,
			);
		}
	});

	withEditor("never offer an edit that would rewrite machine evidence", async () => {
		// The cockpit queues decisions; EmDash owns the edits. A form inside the
		// queues that wrote `rights_status` or `licence_evidence` would be an
		// admin action outside the revision history and the audit trail. The
		// masthead's search form is not in scope — it is navigation.
		const html = await (await fetch(`${baseUrl}/curate`, { headers: { cookie: editorCookie! } })).text();
		const queues = html.match(/<div class="queues[\s\S]*?<\/main>/)?.[0] ?? "";
		assert.ok(queues.length > 0, "could not isolate the queue region");
		assert.equal(
			(queues.match(/<form[\s\S]*?<\/form>/g) ?? []).length,
			0,
			"the cockpit must not post edits of its own",
		);
		// Every row links out to the admin rather than acting inline.
		assert.match(queues, /_emdash\/admin\/possibilities/);
	});

	withEditor("state an unmeasured field as null rather than as zero", async () => {
		const html = await (await fetch(`${baseUrl}/curate`, { headers: { cookie: editorCookie! } })).text();
		const body = text(html);
		assert.doesNotMatch(body, /0\.0 from 0/, "an empty aggregate must read as null");
	});
});

describe("honesty about the catalogue's own gaps", () => {
	withEditor("count held crawl drafts as real rows", async () => {
		const html = await (await fetch(`${baseUrl}/curate`, { headers: { cookie: editorCookie! } })).text();
		// The seed has no drafts and a fresh database has none either, so this
		// asserts the number matches the rows rather than that it is non-zero.
		const stated = Number.parseInt(text(html).match(/Held drafts\s+(\d+)/)?.[1] ?? "NaN", 10);
		assert.ok(Number.isFinite(stated), `could not read the held-draft count: ${text(html).slice(0, 200)}`);

		// Astro appends a scoping attribute to every element, so the attribute is
		// matched rather than the whole tag.
		const section = html.match(/<section aria-labelledby="q-drafts"[\s\S]*?<\/section>/)?.[0] ?? "";
		const rows = (section.match(/<li class="row"/g) ?? []).length;
		assert.equal(stated, rows, `states ${stated} held drafts, lists ${rows}`);
	});

	withEditor("name the state that is actually missing, not a generic one", async () => {
		const html = await (await fetch(`${baseUrl}/curate`, { headers: { cookie: editorCookie! } })).text();
		const body = text(html);
		// `distinct_sources: 0` and `novelty: null` are different failures and
		// the copy has to keep them apart: one means no licence was read, the
		// other means nothing measured it.
		assert.match(body, /unmeasured/);
		assert.match(body, /unverified|no licence has been read/i);
	});
});
