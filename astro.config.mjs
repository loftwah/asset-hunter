import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

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
		}),
	],
	devToolbar: { enabled: false },
	site: "https://assets.loftwah.com",
	/**
	 * Vite's dependency optimiser cannot pre-bundle a few of EmDash's runtime
	 * dependencies — `modern-tar` resolves through Node builtins that do not
	 * exist in workerd. Left to the optimiser they produce a stale
	 * `deps_ssr` chunk reference and every route 500s with a confusing
	 * "optimize deps" error until `node_modules/.vite` is deleted by hand.
	 * Excluding them lets Vite serve them through the normal module graph.
	 */
	vite: {
		optimizeDeps: {
			exclude: ["emdash", "@emdash-cms/admin", "@emdash-cms/cloudflare"],
			include: [],
		},
		ssr: {
			external: ["modern-tar"],
		},
	},
});
