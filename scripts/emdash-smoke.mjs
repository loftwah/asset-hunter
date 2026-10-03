#!/usr/bin/env node
/**
 * Proves the public catalogue is actually served by EmDash, rather than merely
 * having the dependency installed.
 *
 * This is the check that fails if someone adds a parallel data source beside
 * EmDash, or if the public route stops reading CMS content. It asserts against
 * a running server:
 *   1. the EmDash integration is registered in astro.config
 *   2. D1 and R2 bindings are configured
 *   3. the EmDash admin route is reachable (and gated, not open)
 *   4. the EmDash schema exists in the seed
 *   5. the public wall renders records that came from EmDash, matched by slug
 *   6. no local catalogue fixture is shipped as a fallback data source
 *
 * Usage: node scripts/emdash-smoke.mjs [--url http://localhost:4321]
 * Exit code 1 on any failure.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const baseUrl = urlIndex === -1 ? "http://localhost:4321" : args[urlIndex + 1];
const root = new URL("../", import.meta.url).pathname;

const results = [];
const record = (name, ok, detail = "") => results.push({ name, ok, detail });

function readIfExists(path) {
	const full = `${root}${path}`;
	return existsSync(full) ? readFileSync(full, "utf8") : null;
}

// --- 1 & 2: integration and bindings ----------------------------------------

const astroConfig = readIfExists("astro.config.mjs") ?? "";
record(
	"astro.config registers the EmDash integration",
	/emdash\(/.test(astroConfig) && /from\s+["']emdash\/astro["']/.test(astroConfig),
	/emdash\(\{/.test(astroConfig) ? "emdash() present" : "emdash() not found",
);

record(
	"D1 binding configured",
	/d1\(\{\s*binding:\s*["']DB["']/.test(astroConfig),
	'astro.config: d1({ binding: "DB" })',
);

record(
	"R2 media binding configured",
	/r2\(\{\s*binding:\s*["']MEDIA["']/.test(astroConfig),
	'astro.config: r2({ binding: "MEDIA" })',
);

const wrangler = (readIfExists("wrangler.jsonc") ?? "") + (readIfExists("wrangler.local.jsonc") ?? "");
record("wrangler declares D1", /d1_databases/.test(wrangler), "wrangler d1_databases");
record("wrangler declares R2", /r2_buckets/.test(wrangler), "wrangler r2_buckets");
record("worker entry exists", Boolean(readIfExists("src/worker.ts")), "src/worker.ts");

// --- 4: schema --------------------------------------------------------------

const seed = readIfExists("seed/seed.json");
if (!seed) {
	record("seed present", false, "seed/seed.json missing");
} else {
	let parsed = null;
	try {
		parsed = JSON.parse(seed);
	} catch (err) {
		record("seed parses", false, err.message);
	}
	if (parsed) {
		const slugs = (parsed.collections ?? []).map((c) => c.slug);
		record(
			"seed declares the catalogue collections",
			["possibilities", "examples", "collections", "pages"].every((s) => slugs.includes(s)),
			`collections: ${slugs.join(", ") || "none"}`,
		);
		const content = parsed.content ?? {};
		const possibilities = content.possibilities ?? [];
		record("seed has catalogue content", possibilities.length > 0, `${possibilities.length} possibilities`);

		// Honesty invariant: a generated plate must never be labelled upstream.
		const mislabelled = possibilities.filter(
			(p) => p.data?.representative_origin === "upstream" && String(p.data?.specimen ?? "").includes("specimens/"),
		);
		record(
			"no repo-shipped specimen is labelled upstream",
			mislabelled.length === 0,
			mislabelled.length ? mislabelled.map((p) => p.slug).join(", ") : "origins consistent with media",
		);
	}
}

// --- 6: no parallel data source --------------------------------------------

/**
 * A JSON/TS catalogue under src/ or data/ that is not the seed would be a
 * shadow catalogue. Only the seed and its source atlas are legitimate.
 */
const shadowSources = [];
for (const dir of ["src", "data", "lib"]) {
	const full = `${root}${dir}`;
	if (!existsSync(full)) continue;
	const walk = (path, depth = 0) => {
		if (depth > 5) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const p = `${path}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(p, depth + 1);
			} else if (
				/\.(json|jsonl)$/.test(entry.name) &&
				!/package(-lock)?\.json$/.test(entry.name) &&
				!/tsconfig\.json$/.test(entry.name)
			) {
				shadowSources.push(p.replace(root, ""));
			}
		}
	};
	walk(full);
}
record(
	"no shadow catalogue data source",
	shadowSources.length === 0,
	shadowSources.length ? shadowSources.join(", ") : "none found under src/, data/, lib/",
);

record(
	"catalogue reads go through EmDash",
	/getEmDashCollection\(/.test(readIfExists("src/lib/catalogue.ts") ?? "") &&
		/from\s+["']emdash["']/.test(readIfExists("src/lib/catalogue.ts") ?? ""),
	"src/lib/catalogue.ts imports emdash",
);

// --- 3 & 5: live server -----------------------------------------------------

async function probe(pathname, init) {
	const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual", ...init });
	return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

let serverUp = false;
try {
	await probe("/");
	serverUp = true;
} catch {
	record("dev server reachable", false, `${baseUrl} did not respond — start it with \`npm run dev\``);
}

if (serverUp) {
	record("dev server reachable", true, baseUrl);

	// Admin must exist and must not be open to anonymous visitors.
	const admin = await probe("/_emdash/admin");
	const adminGated = [302, 401, 403].includes(admin.status);
	record(
		"EmDash admin route responds and is gated",
		adminGated,
		`HTTP ${admin.status}${admin.location ? ` → ${admin.location}` : ""}`,
	);

	/*
	 * The setup wizard must **not** be reachable in production.
	 *
	 * EmDash's first-run wizard is unauthenticated: `/_emdash/api/setup` walks any
	 * anonymous visitor through creating the first administrator, and the CMS session
	 * is a same-origin `httpOnly` cookie — so whoever walks it owns the content, the
	 * media and the users. `src/middleware.ts` therefore refuses it in a production
	 * build unless the build opted in with `EMDASH_ALLOW_SETUP=1`, which is the
	 * documented first-deploy-only flag (`docs/DEPLOY.md`, `docs/SECURITY.md` §1).
	 *
	 * This check used to assert the opposite — `200` or `302` — which meant the
	 * smoke run was reporting the security fix from #53 as a *failure*. A gate that
	 * demands the vulnerability is a gate that would have blocked the fix that
	 * closed it.
	 *
	 * So: a production deployment must 404 here. Reaching the wizard is not a
	 * missing feature; it is an unowned site.
	 */
	const setup = await probe("/_emdash/admin/setup");
	record(
		"the unauthenticated setup wizard is closed in production",
		setup.status === 404,
		`HTTP ${setup.status}${setup.status === 404 ? "" : " — the wizard is open on an owned site"}`,
	);
	record(
		"setup status is itself closed",
		/[Nn]ot found/.test(setup.body) || setup.status === 404,
		`HTTP ${setup.status}`,
	);

	// The decisive check: the public wall must serve CMS records.
	const home = await probe("/");
	record(
		"public wall renders EmDash content",
		home.status === 200 && /class="tile__link"/.test(home.body),
		`HTTP ${home.status}, ${(home.body.match(/class="tile__link"/g) ?? []).length} tiles`,
	);

	// Every tile must link to a detail route that also renders from EmDash.
	const slugs = [...home.body.matchAll(/href="\/possibilities\/([a-z0-9-]+)"/g)]
		.map((m) => m[1])
		.filter((v, i, a) => a.indexOf(v) === i)
		.slice(0, 3);
	for (const slug of slugs) {
		const detail = await probe(`/possibilities/${slug}`);
		const served =
			detail.status === 200 &&
			/*
			 * `/class="plate"/` stopped matching when the drill-in's plate became
			 * sticky, because the class is now emitted as `class="plate
			 * plate--sticky"`. The check had been failing on every detail route
			 * since, and three green-looking runs did not catch it — a smoke check
			 * that reports a shape nobody renders is worse than no smoke check,
			 * because it trains a reader to ignore red.
			 *
			 * So it matches the class *token*, which is what it meant all along.
			 */
			/class="[^"]*\bplate\b/.test(detail.body) &&
			/class="[^"]*\bsection__title\b/.test(detail.body);
		record(`detail route serves "${slug}"`, served, `HTTP ${detail.status}`);
	}

	const collections = await probe("/collections");
	record(
		"collections route serves CMS content",
		collections.status === 200 && /class="collection"/.test(collections.body),
		`HTTP ${collections.status}`,
	);

	const search = await probe("/search?q=seam");
	record(
		"search uses EmDash full-text",
		search.status === 200 && /class="count"/.test(search.body),
		`HTTP ${search.status}`,
	);

	const notFound = await probe("/definitely-not-a-page");
	record(
		"unknown routes return 404",
		notFound.status === 404,
		`HTTP ${notFound.status}`,
	);
}

// --- Report -----------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`EmDash integration smoke — ${baseUrl}\n`);
for (const r of results) {
	console.log(`  ${r.ok ? "✔" : "✖"} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log("");
if (failed.length) {
	console.error(`✖ ${failed.length} check(s) failed`);
	process.exit(1);
}
console.log(`✔ all ${results.length} checks passed — the public catalogue is served by EmDash`);
