#!/usr/bin/env node
/**
 * Proves the EmDash admin edit path actually reaches the public product.
 *
 * This is the decisive check for the project's central invariant: an edit made
 * through EmDash must be visible on the public site. A dependency that
 * resolves is not proof, and neither is a page that renders seed content — this
 * writes through the CMS API, publishes, reads the public route, and restores
 * the original value.
 *
 * Requires a dev server with a database (the dev-bypass session is
 * development-only, so this cannot run against production).
 *
 * Usage: node scripts/admin-edit-check.mjs [--url http://localhost:4321]
 *        [--slug density-gradient]
 */
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const baseUrl = args[args.indexOf("--url") + 1] ?? "http://localhost:4321";
const slug = args[args.indexOf("--slug") + 1] ?? "density-gradient";
const MARKER = "admin-edit-check";

const results = [];
const step = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`  ${ok ? "✔" : "✖"} ${name}${detail ? `  (${detail})` : ""}`);
};

async function withSession(fn) {
	// dev-bypass provisions a local admin session. It sets two cookies; the
	// session cookie is the one that authenticates.
	const res = await fetch(`${baseUrl}/_emdash/api/setup/dev-bypass`, { redirect: "manual" });
	if (!res.ok) throw new Error(`dev-bypass returned ${res.status}`);
	const raw = res.headers.get("set-cookie") ?? "";
	const cookie = raw
		.split(/,(?=[^;]+?=)/)
		.map((c) => c.split(";")[0].trim())
		.filter(Boolean)
		.join("; ");
	if (!cookie.includes("astro-session")) throw new Error("no session cookie issued");
	return fn({
		cookie,
		// X-EmDash-Request is EmDash's same-origin CSRF proof. Without it every
		// state-changing request is rejected with CSRF_REJECTED.
		headers: { cookie, "X-EmDash-Request": "1", "content-type": "application/json" },
	});
}

const publicText = async (path) => (await (await fetch(`${baseUrl}${path}`)).text()).replace(/\s+/g, " ");

try {
	await withSession(async ({ headers }) => {
		// --- 1. The CMS API is reachable with the EmDash session --------------
		const list = await fetch(`${baseUrl}/_emdash/api/content/possibilities?limit=1`, { headers });
		const listBody = await list.json().catch(() => null);
		step(
			"EmDash content API is reachable with an EmDash session",
			list.ok && listBody?.success === true,
			`HTTP ${list.status}`,
		);

		// --- 2. Read the current value ---------------------------------------
		const read = await fetch(`${baseUrl}/_emdash/api/content/possibilities/${slug}`, { headers });
		const readBody = await read.json().catch(() => null);
		if (!read.ok || readBody?.success !== true) {
			step("read target entry through the CMS", false, `HTTP ${read.status}`);
			return;
		}
		const original = readBody.data.item.data.tagline ?? "";
		step("read target entry through the CMS", true, `${slug}`);

		// --- 3. Anonymous access is refused ----------------------------------
		const anon = await fetch(`${baseUrl}/_emdash/api/content/possibilities?limit=1`);
		const anonBody = await anon.json().catch(() => ({}));
		step(
			"anonymous access to the content API is refused",
			anon.status === 401 || anonBody?.error?.code === "NOT_AUTHENTICATED",
			`HTTP ${anon.status}`,
		);

		// --- 4. Write through EmDash -----------------------------------------
		// A marker unique to this run guarantees we are observing our own edit
		// and not a coincidental match on the seeded copy.
		const marker = `${MARKER} ${createHash("sha256")
			.update(`${slug}${Date.now()}`)
			.digest("hex")
			.slice(0, 8)}`;

		const put = await fetch(`${baseUrl}/_emdash/api/content/possibilities/${slug}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ data: { tagline: marker } }),
		});
		const putBody = await put.json().catch(() => null);
		step(
			"edit through the EmDash content API",
			put.ok && putBody?.success === true,
			`HTTP ${put.status}`,
		);

		// --- 5. Publish -------------------------------------------------------
		const publish = await fetch(
			`${baseUrl}/_emdash/api/content/possibilities/${slug}/publish`,
			{ method: "POST", headers },
		);
		step("publish through the EmDash content API", publish.ok, `HTTP ${publish.status}`);

		// --- 6. The public product reflects it --------------------------------
		// Poll rather than assume: publishing is synchronous in local D1, but a
		// cached route or a request lifecycle could lag by one request.
		let seen = false;
		for (let attempt = 0; attempt < 5 && !seen; attempt++) {
			const html = await publicText(`/possibilities/${slug}`);
			seen = html.includes(marker);
			if (!seen) await new Promise((r) => setTimeout(r, 400));
		}
		step("public page shows the EmDash edit", seen, seen ? "marker found" : "marker absent after 5 attempts");

		// --- 7. The wall reflects it too -------------------------------------
		// The wall reads the same collection, so a change visible only on the
		// detail page would mean the two paths disagree.
		const wall = await publicText("/");
		step("wall reflects the same edit", wall.includes(marker));

		// --- 8. Restore -------------------------------------------------------
		const restore = await fetch(`${baseUrl}/_emdash/api/content/possibilities/${slug}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ data: { tagline: original } }),
		});
		await fetch(`${baseUrl}/_emdash/api/content/possibilities/${slug}/publish`, {
			method: "POST",
			headers,
		});
		let restored = false;
		for (let attempt = 0; attempt < 5 && !restored; attempt++) {
			const html = await publicText(`/possibilities/${slug}`);
			restored = !html.includes(marker) && html.includes(original.slice(0, 24));
			if (!restored) await new Promise((r) => setTimeout(r, 400));
		}
		step("original value restored", restored && restore.ok, restored ? "verified on public page" : "not restored");
	});
} catch (err) {
	console.error(`\n✖ ${err.message}`);
	step("setup", false, err.message);
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
	console.error(`✖ ${failed.length} check(s) failed — the admin edit path does not reach the public product`);
	process.exit(1);
}
console.log("✔ EmDash admin edits reach the public product");
