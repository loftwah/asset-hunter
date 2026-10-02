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
		optimizeDeps: {
			exclude: ["emdash", "@emdash-cms/admin", "@emdash-cms/cloudflare", "effect"],
			include: [],
		},
		ssr: {
			external: ["modern-tar"],
		},
	},
});
