/**
 * Security response headers for the public catalogue (#53).
 *
 * ## What is already here, and why this file is not a bigger deal
 *
 * EmDash's auth middleware wraps every response in the Worker and already sets
 * `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
 * `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy`.
 * Verified with `curl -I` against the dev server, not assumed. So this file adds
 * the two that were genuinely absent, and nothing else.
 *
 * ## `Content-Security-Policy`
 *
 * Nothing set one on the public app. EmDash sets its own on `/_emdash` in
 * production, which is correct and is not ours to narrow. The absence matters
 * more here than it would on a static site, because the CMS admin session is a
 * **same-origin** `httpOnly` cookie on `assets.loftwah.com`: any script execution
 * anywhere on this origin can act as the signed-in editor. CSP is what turns
 * "somewhere on this origin" into "nowhere on this origin" for the one class of
 * bug it covers.
 *
 * Astro's own `security.csp` was tried first and **does not work in `astro dev`**
 * — `createSerializedManifest` hardcodes `shouldInjectCspMetaTags: false`
 * (`astro/dist/manifest/serialized.js:231`), so the policy is silently absent for
 * every local run and only appears in a build. A control that cannot be
 * demonstrated against a running server is a control that gets deleted, so the
 * policy is built here from `src/lib/security.ts` instead, where a request can
 * prove it. See that file for the directives and for the one `'unsafe-inline'`.
 *
 * ## `Strict-Transport-Security`
 *
 * Set on HTTPS requests only. The canonical origin is a Cloudflare custom domain
 * on HTTPS, so a browser that has seen it once should refuse the plaintext
 * version for good. Conditional rather than unconditional, so a plain-HTTP dev
 * server does not receive a header telling the browser to pin a scheme it is not
 * on. `preload` is deliberately omitted: adding a domain to the preload list is
 * irreversible for months and is an operator decision for the whole zone, not
 * something a layout should opt into.
 */
import { defineMiddleware } from "astro:middleware";
import { contentSecurityPolicy, setupWizardRefusal } from "./lib/security.ts";

/** The admin's own prefix. EmDash owns its headers; see the file comment. */
const EMDASH_PREFIX = "/_emdash";

/**
 * The EmDash first-run setup wizard, which is **unauthenticated by design**.
 *
 * `/api/setup` → `/api/setup/admin` → `/api/setup/admin/verify` walk an anonymous
 * visitor through creating the first administrator account, and each step's only
 * guard is "does a user exist yet". That is correct for a site nobody has
 * deployed and catastrophic for one where the first account has not been created
 * yet — which is the state `https://assets.loftwah.com` was in when this review
 * ran it. See `setupWizardRefusal` for the measurement and the way out.
 *
 * Off in a production build unless `EMDASH_ALLOW_SETUP` is `1` at build time. In
 * `astro dev` it stays on, because that is where setup actually runs.
 */
const SETUP_ALLOWED =
	import.meta.env.DEV || process.env.EMDASH_ALLOW_SETUP === "1";

/** The paths the wizard lives on. `/admin/setup` is the page; the rest are its API. */
const SETUP_PATHS = ["/_emdash/admin/setup", "/_emdash/api/setup"];

const isSetupPath = (pathname: string) =>
	SETUP_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

export const onRequest = defineMiddleware(async (context, next) => {
	// Before `next()`, so the wizard is never reached and the request never becomes
	// a question EmDash has to answer about who is allowed to ask.
	if (!SETUP_ALLOWED && isSetupPath(context.url.pathname)) {
		console.error(
			`setup: refused ${context.url.pathname} — the first-run wizard is disabled in a production build. ` +
				"If you are setting this site up for the first time, rebuild with EMDASH_ALLOW_SETUP=1, " +
				"and create the administrator account before exposing the origin.",
		);
		return setupWizardRefusal();
	}

	const response = await next();

	// EmDash's own surface, and its own headers. See the file comment.
	if (context.url.pathname.startsWith(EMDASH_PREFIX)) return response;

	const headers = response.headers;
	// Only if the route has not already set one. `/api/payload` and `/api/record`
	// send a *sandboxing* policy, which is strictly stronger than this one, and
	// `set` would silently replace it with a weaker page policy — a control
	// quietly undone by a later line is worse than no control.
	if (!headers.has("content-security-policy")) {
		headers.set("content-security-policy", contentSecurityPolicy());
	}

	if (context.url.protocol === "https:") {
		headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
	}

	return response;
});