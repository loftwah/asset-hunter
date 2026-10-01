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
});
