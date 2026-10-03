/**
 * The public app's security boundary (#53).
 *
 * Everything in this file is a pure function over strings and headers, and that
 * is the whole point: the rules it holds are the ones an attacker reaches with
 * a form post, a query string and a cookie jar, so each of them has to be
 * readable and testable without a server, a CMS or a browser.
 *
 * Four groups, one per decision a request makes before anything is written:
 *
 * 1. **Is this request ours?** {@link sameOrigin} is the check the two public
 *    POST endpoints make themselves, rather than trusting a framework default
 *    that one line of config can turn off. It is deliberately conservative: a
 *    browser always sends `Sec-Fetch-Site` *or* `Origin` on a same-origin
 *    navigation form post, and either being absent means the caller is not a
 *    browser — so those are refused rather than waved through, because the only
 *    reason to post to `/api/signal` from a non-browser is automation.
 * 2. **Where may a redirect go?** {@link safeReturnPath}. The old check
 *    (`startsWith("/") && !startsWith("//")`) is kept and then *proved* against
 *    the WHATWG URL parser, because `"/\\evil.com"` passes it and resolves
 *    off-origin once `new URL()` sees it.
 * 3. **What may become a link?** {@link safeMediaSrc} and {@link safeHttpUrl}.
 * 4. **What may be printed?** {@link fence} — the engine's transcript rule, and
 *    the one control on this page that exists for machines rather than people.
 */

/* -------------------------------------------------------------------------- */
/* 1. Same-origin                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What a request's own headers say about where it came from.
 *
 * The narrowest shape that answers the question, so a caller can pass anything
 * header-shaped (an `Astro.cookies`-bearing `Request`, or a plain object in a
 * test) without this module depending on the framework.
 */
export interface CrossOriginEvidence {
	readonly headers: Pick<Headers, "get">;
	/** The origin this deployment answers on. */
	readonly origin: string;
}

/** `Sec-Fetch-Site` values that mean "this did not come from another site". */
const SAME_SITE_VALUES = new Set(["same-origin", "none"]);

export type SameOriginVerdict =
	| { readonly sameOrigin: true }
	| { readonly sameOrigin: false; readonly why: string };

/**
 * Whether a state-changing request was made by this site.
 *
 * Three independent proofs are accepted, and any of them being *present and
 * wrong* is a refusal rather than a fall-through to the next check:
 *
 * - `Sec-Fetch-Site: same-origin | none` — set by every current browser, cannot
 *   be set by `fetch` from another origin, and is the strongest signal
 *   available. `none` is a top-level navigation the user typed or bookmarked,
 *   which cannot be a cross-site form post.
 * - `Origin: <this origin>` — what Astro's own `checkOrigin` middleware uses.
 * - Neither header at all — refused. `curl` and `fetch()` from a script omit
 *   both, and a request that is not a browser navigation has no business
 *   changing a rating through a form endpoint.
 *
 * A header that is present and *disagrees* is the attack, so it is reported with
 * the value that gave it away: a refusal nobody can diagnose is a refusal that
 * gets "fixed" by deleting the check.
 *
 * `X-EmDash-Request` is deliberately **not** accepted here. It looks like a
 * CSRF proof and is not one: `/api/signal` sets that header itself on the
 * request it makes *into* EmDash, so its presence says nothing about the browser
 * that reached us.
 */
export function sameOrigin(request: CrossOriginEvidence): SameOriginVerdict {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null) {
		const value = site.trim().toLowerCase();
		return SAME_SITE_VALUES.has(value)
			? { sameOrigin: true }
			: { sameOrigin: false, why: `Sec-Fetch-Site: ${value}` };
	}

	const origin = request.headers.get("origin");
	if (origin !== null) {
		const value = origin.trim();
		return value === request.origin
			? { sameOrigin: true }
			: // `Origin: null` is a sandboxed frame or a redirect from a `data:`
				// document. It is never this site, so it is refused rather than
				// treated as an absent header.
				{ sameOrigin: false, why: `Origin: ${value || "(empty)"}` };
	}

	return { sameOrigin: false, why: "no Sec-Fetch-Site and no Origin" };
}

/**
 * The refusal response for a cross-origin write.
 *
 * 403, no detail about *which* check failed beyond the sentence a reader needs,
 * and `no-store` so a refusal is never cached into somebody else's view.
 *
 * The body deliberately does **not** echo the hostile value. A cross-origin
 * attempt is the one input whose reflection is interesting to an attacker, and a
 * sentence costs nothing.
 */
export function crossOriginResponse(): Response {
	return new Response(
		"This request did not come from this site, so it was refused. Rate and report from the page itself.",
		{
			status: 403,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			},
		},
	);
}

/* -------------------------------------------------------------------------- */
/* 2. Redirects                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A redirect target, or `null` when the input is not one this site may send a
 * reader to.
 *
 * Four classes are refused, and the third is the one the old check missed:
 *
 * - absolute (`https://example.com`) and scheme-relative (`//example.com`) URLs;
 * - anything with a scheme at all (`javascript:`, `data:`, `https:` without
 *   slashes) — a bare `startsWith("/")` cannot see these;
 * - **backslash forms.** `"/\evil.com"` and `"/\t/evil.com"` start with `/` and
 *   do not start with `//`, and the WHATWG URL parser treats `\` as `/` for a
 *   special scheme, so `new URL("/\\evil.com", "https://this.site")` is
 *   `https://evil.com/`. The route only ever emits `pathname + search`, which is
 *   what kept this from being exploitable — but a defence that depends on the
 *   line *after* it is not a defence, so the parser's own opinion is checked
 *   here instead.
 * - anything that resolves to a different origin than the one it was resolved
 *   against, whatever the string looked like.
 */
export function safeReturnPath(value: string | null | undefined, origin: string, fallback: string): string {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return fallback;
	if (raw.includes("\\")) return fallback;
	if (raw.includes("\0")) return fallback;
	if (!raw.startsWith("/")) return fallback;
	if (raw.startsWith("//")) return fallback;
	// A control character or whitespace inside a path is never something a real
	// back link contains, and it is how header-splitting attempts start.
	if (/[\u0000-\u0020]/.test(raw)) return fallback;

	try {
		const resolved = new URL(raw, origin);
		return resolved.origin === origin ? `${resolved.pathname}${resolved.search}` : fallback;
	} catch {
		return fallback;
	}
}

/* -------------------------------------------------------------------------- */
/* 3. Links and media                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether a string is an `http(s)` URL, and therefore may be offered as
 * "the canonical source".
 *
 * The `URL` constructor is the check rather than a protocol prefix test,
 * because `javascript:alert(1)` parses as a URL with that protocol and the
 * prefix test is the one that has been forgotten in projects like this before.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null;
}

/**
 * The media URL for an entry, or `null` when the recorded value is not one this
 * app will put in a page.
 *
 * Allowed: a root-relative path, and an `http(s)` absolute URL (an R2 public
 * bucket or a CDN in front of one). Refused: `javascript:`, `data:`, `blob:`,
 * `vbscript:` and anything unparseable — every one of which is inert in an
 * `<img src>` today and none of which has any business in a CMS field.
 *
 * The allow-list matters more than the `<img>` context it is written for. The
 * same value is also emitted into `og:image`, into `srcset`-like attributes, and
 * — the reason it is worth a function rather than a comment — into whatever a
 * future component does with it. A field that can only hold a path or an http(s)
 * URL cannot be the start of that.
 */
export function safeMediaSrc(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	// Protocol-relative first: `//host/path` starts with `/` and would otherwise be
	// read as a path, and it is a URL to somewhere else.
	if (trimmed.startsWith("//")) return null;
	if (trimmed.startsWith("/")) return trimmed;
	return safeHttpUrl(trimmed);
}

/* -------------------------------------------------------------------------- */
/* 3b. Content types                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A MIME type, or `null` if the recorded value is not one.
 *
 * `/api/payload` echoes a content type that was recorded against the retained
 * object. A content type is a header value, so the things to refuse are the
 * header-shaped ones: a CRLF in it (response splitting), a parameter list (a
 * `text/html; charset=…` still renders), and anything not shaped like
 * `type/subtype`.
 *
 * This is a *shape* check, not an allow-list of types. The sandbox and
 * `attachment` in `asset-use.ts` are what stop the answer being rendered; this
 * stops the answer from being a header injection, which they cannot.
 */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i;

export function safeContentType(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.includes(";") || /[\u0000-\u0020]/.test(trimmed)) return null;
	return MIME_TYPE.test(trimmed) ? trimmed.toLowerCase() : null;
}

/* -------------------------------------------------------------------------- */
/* 5. The public Content-Security-Policy                                     */
/* -------------------------------------------------------------------------- */

/**
 * The public catalogue's Content-Security-Policy directives (#53).
 *
 * A constant here rather than in `src/middleware.ts` for one reason: the
 * middleware imports `astro:middleware`, which `node --test` cannot load, so a
 * policy defined there could not be asserted by a test. A security control that
 * no test can reach is one that gets edited without anyone noticing.
 *
 * Nothing third-party is loaded: the fonts are self-hosted (`public/fonts/`), the
 * plates are same-origin or served through EmDash's own media route, and there
 * is no analytics, no CDN and no embed. So `'self'` is the whole story, and the
 * directives that say "and not that" are the ones doing the work:
 *
 * - `object-src 'none'` — no plugin content, ever.
 * - `base-uri 'self'` — a `<base href>` must not be able to turn a relative URL
 *   on this site into someone else's.
 * - `form-action 'self'` — a form can only post here. This is the CSP half of
 *   the CSRF defence in {@link sameOrigin}; the two are independent and both are
 *   needed, because a policy is only consulted by a browser that got the page.
 * - `frame-ancestors 'none'` — nothing may embed this site.
 *
 * `script-src` and `style-src` are appended by {@link contentSecurityPolicy}.
 */
export const PUBLIC_CSP_DIRECTIVES: ReadonlyArray<string> = [
	"default-src 'self'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self'",
	"media-src 'self'",
	"manifest-src 'self'",
	"worker-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"frame-src 'none'",
	"upgrade-insecure-requests",
];

/**
 * The whole policy, as one header value.
 *
 * `script-src 'self'` with **no hash, no nonce and no `'unsafe-inline'`**. That is
 * the end state #53 was reaching for with a hash list and did not reach: the one
 * inline script this site had was allowed by `sha256-…`, the browser computed the
 * identical digest and blocked the script anyway, and `--masthead-h` was never
 * published. The requirement disappeared rather than being maintained — the
 * measurement became a bundled module, which `'self'` already covers. So the policy
 * is now *stronger* than the hash version rather than weaker, and there is no list
 * to fall out of step with the bytes.
 *
 * `style-src 'self' 'unsafe-inline'` is the one concession, and it is a measured
 * one. `style-src 'self'` was tried first and is visibly wrong: Astro emits every
 * component's `<style>` as an inline `<style>` block under `astro dev`, and still
 * emits some in a production build, so the browser blocked them — measured in
 * Chromium, `document.styleSheets.length === 0` and the page rendered unstyled,
 * against 40 sheets after the change.
 *
 * What that gives up is CSS injection: someone who could put a `style` attribute on
 * the page could restyle it. What it keeps is the control that matters — no inline
 * script, no third-party origin, no plugin content, no framing — and this
 * catalogue escapes its text rather than parsing it, so the only `style` attributes
 * on the page are design tokens this app writes itself.
 */
export function contentSecurityPolicy(): string {
	return [...PUBLIC_CSP_DIRECTIVES, "script-src 'self'", "style-src 'self' 'unsafe-inline'"].join("; ");
}

/* -------------------------------------------------------------------------- */
/* 5b. The first-run setup wizard                                             */
/* -------------------------------------------------------------------------- */

/**
 * The refusal for EmDash's first-run setup wizard in a production build.
 *
 * ## What the exposure is
 *
 * EmDash's setup wizard is three unauthenticated `POST`s:
 *
 * 1. `/_emdash/api/setup` — applies the seed, writes `emdash:setup_state`.
 * 2. `/_emdash/api/setup/admin` — mints WebAuthn **registration** options and a
 *    setup nonce cookie for an email the caller chose.
 * 3. `/_emdash/api/setup/admin/verify` — verifies the credential and calls
 *    `createFirstAdmin`, then sets `emdash:setup_complete`.
 *
 * Every one of them guards on exactly one thing: `countUsers() > 0`. There is no
 * token, no shared secret, no `Origin` requirement in the route itself. That is
 * the right design for a site that has just been created and the wrong design for
 * a site whose first account has not been made yet.
 *
 * ## The measurement, on production
 *
 * `GET /_emdash/api/setup/status` on `https://assets.loftwah.com` — anonymous:
 *
 * ```
 * {"success":true,"data":{"needsSetup":true,"step":"start",
 *  "seedInfo":{…,"collections":6,"hasContent":true},"authMode":"passkey"}}
 * ```
 *
 * `step: "start"` means `setup_complete` is false (`status.ts` forces `step:
 * "admin"` when the flag is true and no users exist), and the site is serving
 * real content, so the seed was applied.
 *
 * Whether a user exists is decided by a check that runs **before** the body is
 * parsed (`api/setup/admin.ts`, lines 41–46 then 56), so a body that fails
 * validation distinguishes the two without writing anything:
 *
 * ```
 * curl -sS -X POST -H 'content-type: application/json' -d '{}' \
 *   https://assets.loftwah.com/_emdash/api/setup/admin
 * ```
 *
 * ```
 * {"success":false,"error":{"code":"VALIDATION_ERROR","message":"Invalid request data",
 *  "details":{"issues":[{"path":"email","message":"Invalid input: expected string, received undefined"}]}}}
 * ```
 *
 * A body-validation error rather than `ADMIN_EXISTS`/`SETUP_COMPLETE`, so the
 * user-count guard did not fire: **`countUsers()` is 0.** Any visitor with a
 * passkey-capable browser can walk the three steps and become the administrator
 * of the site — its content, its media, its users, and (because the session is a
 * same-origin `httpOnly` cookie) everything an administrator can reach.
 *
 * The last step was **not** executed, because creating an administrator account
 * on someone else's production site is not a probe. The route reachability, the
 * absent guard and the zero user count are what is demonstrated; the passkey
 * registration itself is the documented, intended behaviour of those routes once
 * the guard does not fire.
 *
 * ## Why this is a refusal and not a fix to EmDash
 *
 * The guard is upstream (`emdash@1.0.1`) and this repository does not patch it.
 * What this repository *does* own is the Astro app in front of it, and the app
 * is the thing deployed to a public hostname. Blocking the wizard here fails
 * closed: a deployment whose first account has not been created cannot be
 * claimed by whoever notices, and the owner opts back in deliberately with
 * `EMDASH_ALLOW_SETUP=1` at build time.
 *
 * The body is a sentence and the status is `404` — the same status the wizard
 * already answered for a completed site, so a legitimate operator learns nothing
 * new from the refusal and a scanner learns nothing either.
 */
export function setupWizardRefusal(): Response {
	return new Response(
		"Not found. If this site is not yet set up, rebuild it with EMDASH_ALLOW_SETUP=1 " +
			"and create the administrator account from the machine you control.",
		{
			status: 404,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"x-robots-tag": "noindex",
			},
		},
	);
}

/* -------------------------------------------------------------------------- */
/* 6. Text that lies about itself                                               */
/* -------------------------------------------------------------------------- */

/**
 * The invisible formatting characters that reorder or replace what a reader sees.
 *
 * Everything else this file refuses is about what a *machine* would do with a
 * value. This group is about what a **human** does, and it is the one an attacker
 * can do with a repository description — no XSS, no parse confusion, just text
 * that says one thing and renders as another:
 *
 * - `U+202E` RIGHT-TO-LEFT OVERRIDE and `U+202C` POP DIRECTIONAL FORMATTING. A
 *   value of `‮gnp.exe` renders as `exe.png`. A licence note that reads
 *   `Reference only — cleared for commercial use` with an override in the middle
 *   renders with the reassurance last, and a reader scanning it takes away the
 *   reassurance. This is the oldest trick in the list and the one still in use.
 * - `U+200E`/`U+200F` LEFT/RIGHT-TO-LEFT MARK and `U+061C` ARABIC LETTER MARK —
 *   the invisible ones, which reorder neighbouring text without being visible at
 *   all in a diff or a search.
 * - `U+2066`–`U+2069` the isolates, and `U+00AD` SOFT HYPHEN, which makes
 *   `example.com` and `exampl­e.com` compare unequal in a filter while reading
 *   identically on screen.
 * - `U+FFFD`-adjacent `U+2028`/`U+2029` LINE/PARAGRAPH SEPARATOR, which are not
 *   `<`, not `"`, and not C0 — so a `\s`-based scrubber misses them.
 *
 * **Replaced with U+FFFD, not deleted.** A deleted character silently welds its
 * neighbours together (`example` + `.com` → `example.com`, which is *worse*: a
 * value that was not that now is). `U+FFFD` REPLACEMENT CHARACTER shows the
 * reader that something was removed and where, so a hostile value is visibly
 * hostile rather than quietly falsified.
 *
 * Homoglyphs are **not** touched. Folding `а` (Cyrillic) to `a` (Latin) would be
 * a lie about provenance in the other direction — it would present someone's
 * choice of characters as an accident, and it is not safely reversible. They are
 * handled where they matter instead: this function cannot make a homoglyphed
 * string safe to *act* on, which is why no decision in this codebase is taken from
 * one. See `docs/SECURITY.md`.
 */
const INVISIBLE_FORMATTING = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u00ad\u2028\u2029]/g;

/** The character a reader sees where something was removed. */
const REPLACEMENT = "\uFFFD";

/**
 * Strips the characters that make a value say something other than what it is.
 *
 * Applies to any text that originates outside this project: a repository
 * description, a licence quote, a contributor name, a file path, an error detail
 * off a third-party API. Applied on the way *out*, at the point of rendering, so
 * a value is corrected wherever it is shown rather than once where it enters —
 * because the ways in are several and the ways out are more.
 *
 * Plain and synchronous on purpose: this is deterministic text handling with no
 * I/O, and it must be callable from a projection, a component and a test.
 */
export function readableText(value: string | null | undefined, limit?: number): string {
	if (!value) return "";
	const cleaned = value.replace(INVISIBLE_FORMATTING, REPLACEMENT).trim();
	if (limit !== undefined && cleaned.length > limit) return `${cleaned.slice(0, limit)}…`;
	return cleaned;
}

/** {@link readableText} with the limit omitted — the usual case. */
export function safeText(value: string | null | undefined): string {
	return readableText(value);
}

/* -------------------------------------------------------------------------- */
/* 7. Slugs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether a value is a plausible catalogue subject, before a write is attempted.
 *
 * `/api/signal` used to accept any string at all, which let a single signed-in
 * account file an unbounded number of reports and ratings about entries that do
 * not exist — a moderation queue with nothing in it. The vocabulary is
 * deliberately narrow: every slug in `seed/seed.json` is lowercase and hyphenated,
 * and `npm run seed:check` fails if one is not.
 */
export const SUBJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function isSubjectSlug(value: string | null | undefined): value is string {
	return typeof value === "string" && SUBJECT_SLUG.test(value);
}

/**
 * Reduces a value to something safe to put in a CMS slug.
 *
 * `isSubjectSlug` is the gate; this is the belt. A slug is a URL segment and a
 * column value, so a `/` or a `../` inside one is a traversal in whatever reads it
 * next, and the function that builds a slug should not have to trust that a
 * caller checked first. The result is always a valid slug, never `""`.
 */
export function slugSafe(value: string | null | undefined, fallback = "x"): string {
	const cleaned = String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/^-+|-+$/g, "");
	return cleaned || fallback;
}