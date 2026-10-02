import { execFileSync } from "node:child_process";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

/**
 * Which commit this bundle is, decided before the bundle is written.
 *
 * #81 found the deployed site serving code three commits behind `main` while
 * `main` had already fixed nine accessibility defects, and nothing in the
 * product said what it was serving. So the build says so itself, and the value
 * has to be decided here — `vite.define` substitutes constants at bundle time,
 * and a value read at request time would be the *runtime's* commit, which is
 * not a thing.
 *
 * The three answers are deliberately different:
 *
 * - **clean tree** — `HEAD` is exactly what is being shipped.
 * - **dirty tree** — `HEAD` *plus* uncommitted changes. The commit id alone
 *   would be a lie, so the fact is published alongside it and the UI says
 *   "plus uncommitted changes" rather than printing a bare sha that reads like
 *   certainty.
 * - **no git at all** — a source tarball, a CI export, a Docker image. The
 *   build still has to serve, so `commit` is `null` and the reason is recorded.
 *   Never the package version, which would look like evidence and is not.
 *
 * `ASSET_HUNTER_COMMIT` overrides all of it, so a release build can pin a tag
 * instead of whatever `HEAD` was when the machine happened to run it.
 */
function gitProvenance() {
	const pinned = process.env.ASSET_HUNTER_COMMIT;
	if (pinned && /^[0-9a-f]{7,40}$/.test(pinned)) {
		return { commit: pinned, dirty: "false" };
	}
	try {
		const commit = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error("unparseable HEAD");
		// `--porcelain` counts untracked files too, which is correct: an untracked
		// file is code the build will ship and nobody can name by commit.
		const status = execFileSync("git", ["status", "--porcelain"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { commit, dirty: status.trim().length === 0 ? "false" : "true" };
	} catch {
		return { commit: "unknown", dirty: "unknown" };
	}
}

const provenance = gitProvenance();
const builtAt = process.env.ASSET_HUNTER_BUILT_AT ?? new Date().toISOString();

// Asset Hunter is an EmDash site. The public catalogue is CMS-managed through
// EmDash (schema, content, media, admin) and served by Astro on Cloudflare
// Workers with D1 for structured data and R2 for media.
//
// Hunt-engine internals (crawl state, provenance evidence, fingerprints) stay
// outside this app; see docs/ARCHITECTURE.md for the boundary and the
// publish/sync contract that feeds EmDash content.
export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			/**
			 * The public origin users type, with no path.
			 *
			 * Declared here rather than left to `EMDASH_SITE_URL` because this is
			 * what production setup reads before it will run at all: the setup
			 * route refuses with `SITE_URL_REQUIRED` when it cannot resolve a
			 * configured origin, and a secret set with `wrangler secret put` is
			 * not visible through the `process.env` path EmDash reads on Workers.
			 * Config is read at build time, so it is present on the first request
			 * to a fresh deployment rather than one deploy later.
			 *
			 * Without it the catalogue deploys and then renders an empty wall,
			 * because the seed's content is only applied by the setup step.
			 */
			siteUrl: "https://assets.loftwah.com",
		}),
	],
	devToolbar: { enabled: false },
	site: "https://assets.loftwah.com",
	/**
	 * Vite's dependency optimiser cannot pre-bundle a few of this app's runtime
	 * dependencies, and when it tries, every route 500s with a confusing
	 * "optimize deps" error until `node_modules/.vite` is deleted by hand.
	 *
	 * - `modern-tar` resolves through Node builtins that do not exist in workerd.
	 * - EmDash's own packages are excluded because they are the integration this
	 *   project is built on and must be loaded through the normal module graph.
	 * - `effect` is excluded for the same reason class: it is a large, carefully
	 *   tree-shaken library that the optimiser's single-chunk pre-bundle defeats,
	 *   and it must run *inside* workerd rather than in a Node-shaped wrapper. #62.
	 *
	 * Excluding them lets Vite serve them through the normal module graph.
	 */
	vite: {
		/**
		 * Build provenance, substituted as constants by name.
		 *
		 * Written as three separate `define` entries rather than one JSON blob
		 * because each has to be read as a literal key somewhere: `env[key]` and
		 * `import.meta.env[key]` are not replaced by a bundler, so a dynamic
		 * lookup would quietly resolve to `undefined` and the version stamp would
		 * claim nothing at all. `src/lib/build-info.ts` reads each key literally.
		 */
		define: {
			"import.meta.env.ASSET_HUNTER_COMMIT": JSON.stringify(provenance.commit),
			"import.meta.env.ASSET_HUNTER_DIRTY": JSON.stringify(provenance.dirty),
			"import.meta.env.ASSET_HUNTER_BUILT_AT": JSON.stringify(builtAt),
		},
		/**
		 * The optimiser cache, relocated on request.
		 *
		 * The default is `node_modules/.vite`, which is shared by every dev
		 * server rooted at the same `node_modules` — a worktree whose
		 * `node_modules` is a symlink, or two checkouts on one machine. Those
		 * servers then write each other's `_metadata.json`, and the failure is
		 * the same class as the `optimizeDeps` problem above: a route that 500s
		 * with
		 *
		 *   No cached compile metadata found for …/EmDashImage.astro
		 *
		 * until the cache is deleted by hand — which, with a shared directory,
		 * is somebody else's problem rather than yours.
		 *
		 * `AH_VITE_CACHE_DIR` points one server at its own directory. Unset, the
		 * behaviour is unchanged.
		 */
		cacheDir: process.env.AH_VITE_CACHE_DIR,
		optimizeDeps: {
			exclude: ["emdash", "@emdash-cms/admin", "@emdash-cms/cloudflare", "effect"],
			include: [],
		},
		ssr: {
			external: ["modern-tar"],
		},
	},
});
