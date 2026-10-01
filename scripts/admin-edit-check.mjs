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
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const baseUrl = args[args.indexOf("--url") + 1] ?? "http://localhost:4321";
const slug = args[args.indexOf("--slug") + 1] ?? "density-gradient";
const MARKER = "admin-edit-check";

/**
 * The seeded tagline for `slug`, used only to heal a database that an earlier
 * interrupted run left holding a marker. `seed/atlas.json` is the readable
 * source of truth for catalogue copy, so it is the right thing to restore from
 * — restoring the marker itself would be a no-op.
 */
const seededTagline = () => {
	const atlas = JSON.parse(
		readFileSync(new URL("../seed/atlas.json", import.meta.url), "utf8"),
	);
	const entry = (atlas.possibilities ?? []).find((p) => p.id === slug);
	return entry?.tagline ?? "";
};

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

/**
 * The value this check writes, and the one it puts back.
 *
 * Held outside the try block so the restore runs even when a step between the
 * write and the restore throws: a check that can leave its own marker in the
 * content is worse than no check, because the next reader cannot tell test
 * residue from real copy.
 */
let restore = null;
let original = "";

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
		original = readBody.data.item.data.tagline ?? "";
		if (original.startsWith(MARKER)) {
			// The value we would restore is our own residue, so restore the
			// seeded copy instead and say that is what happened.
			const seeded = seededTagline();
			console.error(
				`  ! ${slug} held "${original}" from an earlier interrupted run — restoring the seeded tagline instead`,
			);
			original = seeded || original;
		}
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

		const put = async (data) =>
			fetch(`${baseUrl}/_emdash/api/content/possibilities/${slug}`, {
				method: "PUT",
				headers,
				body: JSON.stringify({ data }),
			});
		const publish = () =>
			fetch(`${baseUrl}/_emdash/api/content/possibilities/${slug}/publish`, {
				method: "POST",
				headers,
			});

		const write = await put({ tagline: marker });
		const writeBody = await write.json().catch(() => null);
		step(
			"edit through the EmDash content API",
			write.ok && writeBody?.success === true,
			`HTTP ${write.status}`,
		);
		// Armed immediately after the write, before anything else can fail.
		restore = async () => {
			const res = await put({ tagline: original });
			await publish();
			return res;
		};

		// --- 5. Publish -------------------------------------------------------
		const published = await publish();
		step("publish through the EmDash content API", published.ok, `HTTP ${published.status}`);

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
		const putBack = await restore?.();
		await publish();
		restore = null;
		let restored = false;
		for (let attempt = 0; attempt < 5 && !restored; attempt++) {
			const html = await publicText(`/possibilities/${slug}`);
			restored = !html.includes(marker) && html.includes(original.slice(0, 24));
			if (!restored) await new Promise((r) => setTimeout(r, 400));
		}
		step(
			"original value restored",
			restored && putBack?.ok === true,
			restored ? "verified on public page" : "NOT restored — run again to retry",
		);
	});
} catch (err) {
	console.error(`\n✖ ${err.message}`);
	step("setup", false, err.message);
} finally {
	// Last-resort cleanup. Reaching here means a step threw between the write
	// and the restore, so the content is still holding this run's marker.
	if (restore) {
		try {
			await restore();
			console.log("  ↩ restored after an earlier failure");
		} catch (err) {
			console.error(
				`\n✖ could not restore ${slug}: ${err.message}\n  Set its tagline back to "${original}" by hand.`,
			);
			process.exitCode = 1;
		}
	}
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
	console.error(`✖ ${failed.length} check(s) failed — the admin edit path does not reach the public product`);
	process.exit(1);
}
console.log("✔ EmDash admin edits reach the public product");
