#!/usr/bin/env node
/**
 * Proves the public masthead is the EmDash menu, and that editing it in the
 * admin changes the site.
 *
 * This is the check #17 needed and did not have. The bug it exists for:
 *
 * ```ts
 * // src/layouts/Base.astro
 * const nav = [
 *   { href: "/", label: "Catalogue" },
 *   // …identical to `menus.primary.items` in the seed, which nothing read
 * ];
 * ```
 *
 * Two lists, one of them inert, so the menu an editor could see in the admin
 * had no effect on the site. `tests/site-shell.test.ts` proves the *literal* is
 * gone, which is the structural half. This proves the other half — that what
 * the CMS says is what a reader is served, demonstrated by changing it and
 * watching the page.
 *
 * It is deliberately the same shape as `admin-edit-check.mjs`: write through
 * EmDash, read the public route, restore, and fail loudly if the restore did
 * not take. A check that can leave its own marker in the navigation is worse
 * than no check, so the restore is armed immediately after the write and runs
 * from a `finally`.
 *
 * Requires a dev server with a database (the dev-bypass session is
 * development-only).
 *
 * Usage:
 *   node scripts/check-nav.mjs [--url http://localhost:4321] [--label "Shots"]
 */
const args = process.argv.slice(2);
const value = (flag, fallback) => {
	const i = args.indexOf(flag);
	return i === -1 ? fallback : args[i + 1];
};
const baseUrl = value("--url", "http://localhost:4321");
const menuName = value("--menu", "primary");

/**
 * The label written by the edit step.
 *
 * Deliberately unlikely as a real navigation label, and unique per run, so the
 * assertion is observing this check's own edit rather than a coincidental match
 * on the seeded copy.
 */
const MARKER = `nav-check ${Date.now().toString(36)}`;

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
		// X-EmDash-Request is EmDash's same-origin CSRF proof.
		headers: { cookie, "X-EmDash-Request": "1", "content-type": "application/json" },
	});
}

const publicHtml = async (path) => (await fetch(`${baseUrl}${path}`)).text();

/**
 * The primary nav's links, read out of the rendered page.
 *
 * Scoped to the element the layout marks with `data-nav-source`, so this reads
 * the masthead and not the footer's copy of the same menu or a link inside the
 * page body. That is also what proves the marker attribute exists: a layout
 * that stopped declaring it would make this `null`, and the check would fail
 * rather than quietly start reading the wrong element.
 */
async function renderedNav(path = "/") {
	const html = await publicHtml(path);
	const source = html.match(/data-nav-source="([^"]+)"/)?.[1] ?? null;
	const block = html.match(/<nav class="nav[^"]*"[^>]*data-nav-source="[^"]*"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
	const links = [...block.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
		href: m[1],
		label: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
	}));
	return { source, links, html };
}

/**
 * Restores a label. Held outside the try block so it runs even when a step
 * between the write and the restore throws.
 */
let restore = null;
let original = null;
let itemId = null;

try {
	await withSession(async ({ headers }) => {
		// --- 1. The menu API is reachable with an EmDash session ---------------
		const menuRes = await fetch(`${baseUrl}/_emdash/api/menus/${menuName}`, { headers });
		const menuBody = await menuRes.json().catch(() => null);
		const items = menuBody?.data?.items ?? [];
		step(
			"the primary menu is readable through the EmDash API",
			menuRes.ok && menuBody?.success === true && items.length > 0,
			`HTTP ${menuRes.status}, ${items.length} item(s)`,
		);
		if (!items.length) {
			console.error(
				`\n✖ no items in the ${menuName} menu. This check cannot edit a menu that does not exist — ` +
					`apply the seed (curl "${baseUrl}/_emdash/api/setup/dev-bypass") and try again.`,
			);
			process.exitCode = 1;
			return;
		}

		// --- 2. Anonymous access is refused ------------------------------------
		const anon = await fetch(`${baseUrl}/_emdash/api/menus/${menuName}`);
		step(
			"anonymous access to the menus API is refused",
			anon.status === 401,
			`HTTP ${anon.status}`,
		);

		// --- 3. The public masthead is serving the CMS menu --------------------
		const before = await renderedNav();
		step(
			"the masthead declares where its links came from",
			before.source !== null,
			`data-nav-source="${before.source}"`,
		);
		step(
			"the masthead is serving the CMS menu, not a fallback",
			before.source === "cms",
			before.source === "cms"
				? `${before.links.length} link(s)`
				: `the site is serving the built-in fallback (${before.links.length} link(s)) — check the server log`,
		);

		// Every link the page shows has to be one the CMS menu declares. This is
		// the assertion that would have caught the original bug: a duplicated
		// list renders identically until an editor changes the menu, and then
		// this is the line that notices.
		const cmsHrefs = new Set(
			items.filter((i) => !i.parentId).map((i) => i.customUrl ?? ""),
		);
		const unaccounted = before.links.filter((l) => !cmsHrefs.has(l.href));
		step(
			"every masthead link is declared in the CMS menu",
			unaccounted.length === 0,
			unaccounted.length === 0
				? `${before.links.length} matched`
				: `not in the menu: ${unaccounted.map((l) => `${l.label} → ${l.href}`).join(", ")}`,
		);

		// --- 4. Edit one label through EmDash ---------------------------------
		// The last top-level item, so the change is visible in the strip's tail
		// rather than hidden behind the brand at the start.
		const target = items.filter((i) => !i.parentId).at(-1);
		itemId = target.id;
		original = target.label;
		step("a top-level menu item to edit", Boolean(original), `${itemId}: "${original}"`);

		const put = (label) =>
			fetch(`${baseUrl}/_emdash/api/menus/${menuName}/items/${itemId}`, {
				method: "PUT",
				headers,
				body: JSON.stringify({ label }),
			});

		const write = await put(MARKER);
		const writeBody = await write.json().catch(() => null);
		step(
			"edit a menu label through the EmDash API",
			write.ok && writeBody?.success === true,
			`HTTP ${write.status}`,
		);
		// Armed immediately after the write, before anything else can fail.
		restore = async () => put(original);

		// --- 5. The public masthead reflects it -------------------------------
		// Poll rather than assume: a cached route or a request lifecycle can lag
		// by one request even on local D1.
		let seen = false;
		for (let attempt = 0; attempt < 5 && !seen; attempt++) {
			const { links } = await renderedNav();
			seen = links.some((l) => l.label === MARKER);
			if (!seen) await new Promise((r) => setTimeout(r, 400));
		}
		step("the public masthead shows the edited label", seen, seen ? MARKER : "absent after 5 attempts");

		// A menu edit that is not also reflected in the footer means two
		// navigations exist, which is the duplication again in a different place.
		const footer = await publicHtml("/");
		step("the footer reflects the same edit", footer.includes(MARKER));

		// --- 6. Restore -------------------------------------------------------
		const putBack = await restore?.();
		restore = null;
		let restored = false;
		for (let attempt = 0; attempt < 5 && !restored; attempt++) {
			const { links } = await renderedNav();
			restored = !links.some((l) => l.label === MARKER) && links.some((l) => l.label === original);
			if (!restored) await new Promise((r) => setTimeout(r, 400));
		}
		step(
			"the original label is restored",
			restored && putBack?.ok === true,
			restored ? "verified on the public masthead" : "NOT restored — run again to retry",
		);
	});
} catch (err) {
	console.error(`\n✖ ${err.message}`);
	step("setup", false, err.message);
} finally {
	if (restore) {
		try {
			await restore();
			console.log("  ↩ restored after an earlier failure");
		} catch (err) {
			console.error(
				`\n✖ could not restore menu item ${itemId}: ${err.message}\n  Set its label back to "${original}" by hand.`,
			);
			process.exitCode = 1;
		}
	}
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
	console.error(
		`✖ ${failed.length} check(s) failed — the public masthead is not the EmDash ${menuName} menu`,
	);
	process.exit(1);
}
console.log(`✔ the public masthead is the EmDash ${menuName} menu, and editing it changes the site`);
