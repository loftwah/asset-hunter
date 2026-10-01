#!/usr/bin/env node
/**
 * Environment doctor.
 *
 * Reports what is installed, what is configured, and — the distinction that
 * matters most for this project — whether EmDash is merely installed or
 * actually integrated and used.
 *
 * "EmDash configured" must mean the public catalogue is served through it, not
 * that the dependency resolves. That distinction is the whole point of this
 * report.
 *
 * Usage: node scripts/doctor.mjs [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const asJson = process.argv.includes("--json");
const root = new URL("../", import.meta.url).pathname;

const checks = [];
let group = "";

function section(name) {
	group = name;
}

function check(name, ok, detail = "", hint = "") {
	checks.push({ group, name, ok, detail, hint });
}

function read(path) {
	const full = `${root}${path}`;
	return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function pkgVersion(name) {
	try {
		const out = execFileSync("npm", ["ls", name, "--depth=0", "--json"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const parsed = JSON.parse(out);
		return parsed.dependencies?.[name]?.version ?? null;
	} catch {
		return null;
	}
}

// --- Runtime ---------------------------------------------------------------

section("Runtime");

const [major] = process.versions.node.split(".").map(Number);
check("Node 22 or newer", major >= 22, `Node ${process.versions.node}`, "Install Node 22+");

const npm = (() => {
	try {
		return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
})();
check("npm available", Boolean(npm), npm ?? "not found");

check(
	"dependencies installed",
	existsSync(`${root}node_modules/emdash`),
	existsSync(`${root}node_modules`) ? "node_modules present" : "node_modules missing",
	"Run: npm install",
);

// --- EmDash ----------------------------------------------------------------

section("EmDash");

const emdashVersion = pkgVersion("emdash");
check("emdash package installed", Boolean(emdashVersion), emdashVersion ?? "not installed", "Run: npm install");

const astroConfig = read("astro.config.mjs") ?? "";
const astroIntegration =
	/from\s+["']emdash\/astro["']/.test(astroConfig) && /emdash\(\{/.test(astroConfig);
check(
	"Astro integration registered",
	astroIntegration,
	astroIntegration ? "emdash/astro in astro.config.mjs" : "not found in astro.config.mjs",
	"See .agents/skills/building-emdash-site",
);

const d1 = /d1\(\{\s*binding:\s*["']DB["']/.test(astroConfig);
const r2 = /r2\(\{\s*binding:\s*["']MEDIA["']/.test(astroConfig);
check("D1 database adapter", d1, d1 ? 'd1({ binding: "DB" })' : "missing");
check("R2 storage adapter", r2, r2 ? 'r2({ binding: "MEDIA" })' : "missing");

const serverOutput = /output:\s*["']server["']/.test(astroConfig);
check(
	"server-rendered output",
	serverOutput,
	serverOutput ? 'output: "server"' : "not set",
	"CMS content is dynamic; getStaticPaths cannot work",
);

// --- Cloudflare ------------------------------------------------------------

section("Cloudflare");

const wrangler = read("wrangler.jsonc") ?? "";
check("wrangler config present", Boolean(wrangler), wrangler ? "wrangler.jsonc" : "missing");
check("D1 binding declared", /d1_databases/.test(wrangler));
check("R2 binding declared", /r2_buckets/.test(wrangler));
check("worker entry exists", existsSync(`${root}src/worker.ts`), "src/worker.ts");
check("nodejs_compat flag", /nodejs_compat/.test(wrangler), "required by the EmDash worker");
check(
	"migrations directory configured",
	/migrations_dir/.test(wrangler) || existsSync(`${root}migrations`),
	/migrations_dir/.test(wrangler) ? "migrations_dir set" : "not configured",
);

const cloudflareVersion = pkgVersion("@astrojs/cloudflare");
check(
	"Cloudflare adapter installed",
	Boolean(cloudflareVersion),
	cloudflareVersion ?? "not installed",
);

// --- Content model ---------------------------------------------------------

section("Content model");

const seedRaw = read("seed/seed.json");
if (!seedRaw) {
	check("seed present", false, "seed/seed.json missing", "Run: npm run seed:build");
} else {
	let seed = null;
	try {
		seed = JSON.parse(seedRaw);
		check("seed parses", true, `${(seedRaw.length / 1024).toFixed(0)} KB`);
	} catch (err) {
		check("seed parses", false, err.message);
	}
	if (seed) {
		const slugs = (seed.collections ?? []).map((c) => c.slug);
		for (const required of ["possibilities", "examples", "collections", "pages"]) {
			check(`collection: ${required}`, slugs.includes(required), required);
		}
		const possibilities = seed.content?.possibilities ?? [];
		check("catalogue content seeded", possibilities.length > 0, `${possibilities.length} possibilities`);
		check("taxonomy: vertical", (seed.taxonomies ?? []).some((t) => t.name === "vertical"));
	}
}

check(
	"generated types committed",
	existsSync(`${root}emdash-env.d.ts`),
	existsSync(`${root}emdash-env.d.ts`) ? "emdash-env.d.ts" : "missing",
	"Regenerate with: npm run emdash types",
);

const atlas = read("seed/atlas.json");
check("atlas source present", Boolean(atlas), atlas ? "seed/atlas.json" : "missing");

// --- Specimens -------------------------------------------------------------

section("Specimens");

const specimensDir = `${root}public/specimens`;
if (!existsSync(specimensDir)) {
	check("specimen directory", false, "public/specimens missing");
} else {
	const { readdirSync } = await import("node:fs");
	const plates = readdirSync(specimensDir).filter((f) => f.endsWith(".svg"));
	check("specimen plates", plates.length > 0, `${plates.length} plates`);
	if (atlas) {
		const ids = JSON.parse(atlas).possibilities.map((p) => p.id);
		const missing = ids.filter((id) => !plates.includes(`${id}.svg`));
		check("every possibility has a plate", missing.length === 0, missing.length ? missing.join(", ") : "all present");
	}
}

// --- Dev server ------------------------------------------------------------

section("Live server");

let serverUp = false;
try {
	const res = await fetch("http://localhost:4321/", { redirect: "manual" });
	serverUp = res.ok;
} catch {
	serverUp = false;
}
check("dev server responding", serverUp, serverUp ? "http://localhost:4321" : "not running", "Run: npm run dev");

if (serverUp) {
	const admin = await fetch("http://localhost:4321/_emdash/admin", { redirect: "manual" });
	const gated = [302, 401, 403].includes(admin.status);
	check(
		"EmDash admin route present and gated",
		gated,
		`HTTP ${admin.status}`,
		"Should redirect to login, not be open",
	);

	const home = await (await fetch("http://localhost:4321/")).text();
	const tiles = (home.match(/class="tile__link"/g) ?? []).length;
	check("public wall serves catalogue data", tiles > 0, `${tiles} tiles rendered`);

	// The decisive question: is the catalogue served by EmDash, or by something
	// parked beside it?
	const catalogueSrc = read("src/lib/catalogue.ts") ?? "";
	const usesEmdash = /from\s+["']emdash["']/.test(catalogueSrc);
	check("catalogue reads through EmDash", usesEmdash, usesEmdash ? "src/lib/catalogue.ts" : "no emdash import");

	check(
		"EmDash integration smoke",
		existsSync(`${root}scripts/emdash-smoke.mjs`),
		"Run: npm run smoke",
	);
}

// --- Report ----------------------------------------------------------------

const groups = [...new Set(checks.map((c) => c.group))];
const failed = checks.filter((c) => !c.ok);

if (asJson) {
	console.log(JSON.stringify({ checks, failed: failed.length }, null, "\t"));
} else {
	console.log("Asset Hunter doctor\n");
	for (const g of groups) {
		console.log(`${g}`);
		for (const c of checks.filter((x) => x.group === g)) {
			console.log(`  ${c.ok ? "✔" : "✖"} ${c.name}${c.detail ? `  ${c.detail}` : ""}`);
			if (!c.ok && c.hint) console.log(`      → ${c.hint}`);
		}
		console.log("");
	}
	console.log(`${checks.length - failed.length}/${checks.length} checks passed`);

	if (failed.some((c) => c.group === "EmDash")) {
		console.log(
			"\nEmDash is installed but not integrated. The public catalogue must be served\nthrough EmDash — a dependency that resolves is not proof the product uses it.",
		);
	}
	if (serverUp) {
		console.log("\nEmDash is installed AND integrated. Confirm usage with: npm run smoke");
	}
}

process.exit(failed.length ? 1 : 0);
