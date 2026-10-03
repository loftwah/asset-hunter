/**
 * `GET /api/version.json` — which commit is this deployment (#81).
 *
 * Issue #81 is the reason this file exists. The deployed site was serving code
 * from three commits behind `main`, and nine accessibility defects were live at
 * `assets.loftwah.com` — 195 controls under the 44px floor — while `main` had
 * already fixed every one of them, for several commits. Nobody noticed, because
 * nothing the product served said what it *was*.
 *
 * This endpoint is the cheap check. `node scripts/visual-qa.mjs --url …` and any
 * deploy gate can read one small JSON object and know immediately whether the
 * public site is the code the branch claims, without parsing HTML, taking a
 * screenshot, or trusting a screenshot either.
 *
 * ## Why it does not need to be an Effect
 *
 * There is no I/O here. The answer was computed at build time by
 * `astro.config.mjs` and substituted into the bundle as constants, so reading it
 * is arithmetic on three strings. Building an Effect for that would be
 * ceremony; the Effect boundary exists for work that can fail against something
 * outside this process, and this cannot. See `docs/EFFECT_STYLE.md`.
 *
 * ## Cache headers
 *
 * `no-store`, deliberately. A cached version endpoint is a version endpoint that
 * eventually lies: a CDN or browser that keeps the old body answers the exact
 * question it exists to answer wrongly, and the failure looks like "the deploy
 * never happened" when the deploy is fine. The body is ~200 bytes.
 */
import type { APIRoute } from "astro";
import { buildInfo, buildSentence, isCommitish } from "../../lib/build-info.ts";

/** Named so a client can branch on the contract rather than on a URL. */
export const VERSION_SCHEMA = "asset-hunter.version/1";

export const GET: APIRoute = () => {
	const info = buildInfo();

	const body = {
		schema: VERSION_SCHEMA,
		...info,
		// The short form is what a human compares; the long form is what a script
		// compares. Printing the short form and asking someone to trust it is how
		// a 7-character abbreviation becomes the whole verification.
		short: info.commit === null ? null : info.commit.slice(0, 7),
		// Same value the page's `<meta>` carries, so a reader looking at
		// view-source and an agent looking at this endpoint cannot disagree.
		meta: buildSentence(info),
		// Present so a client can tell "this build is from a tree nobody could name"
		// from "this build predates the endpoint". Absent rather than false.
		...(isCommitish(info.commit) ? {} : { repository: null }),
	};

	return new Response(JSON.stringify(body, null, "\t"), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store, max-age=0",
			"x-asset-hunter-version": VERSION_SCHEMA,
			// The commit is the whole payload and there is no user content in it, so
			// it is safe to expose to any origin — this is not the catalogue.
			"access-control-allow-origin": "*",
			"x-content-type-options": "nosniff",
		},
	});
};

export const prerender = false;
