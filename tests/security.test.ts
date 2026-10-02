/**
 * The security review's executable half (#53).
 *
 * Every finding that was fixed has an assertion here or in
 * `tests/engine.test.ts` (the prompt-injection fixtures live with the engine,
 * because they are about engine output). A finding with no test is a comment,
 * and a comment is not a control.
 *
 * The live tests at the bottom drive the running server, so the CSRF and
 * header findings are proved against real HTTP rather than against a unit double.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";


import {
	contentSecurityPolicy,
	readableText,
	setupWizardRefusal,
	crossOriginResponse,
	isSubjectSlug,
	PUBLIC_CSP_DIRECTIVES,
	safeContentType,
	safeHttpUrl,
	safeMediaSrc,
	safeReturnPath,
	slugSafe,
	sameOrigin,
} from "../src/lib/security.ts";
import { safeSnippet } from "../src/lib/search-text.ts";
import { parseBoards, serialiseBoards, MAX_BOARD_NAME } from "../src/lib/board.ts";
import { mediaSrc } from "../src/lib/catalogue.ts";
import { REPORT_WINDOW_MS, reportSlug } from "../src/lib/signals.ts";
import { payloadResult } from "../src/lib/asset-use.ts";
import type { Example } from "../src/lib/catalogue.ts";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";

/* -------------------------------------------------------------------------- */
/* CSRF                                                                       */
/* -------------------------------------------------------------------------- */

describe("the public write endpoints refuse a cross-origin request", () => {
	const headers = (record: Record<string, string | undefined>) => {
		const h = new Headers();
		for (const [name, value] of Object.entries(record)) {
			if (typeof value === "string") h.set(name, value);
		}
		return h;
	};
	const here = "https://assets.loftwah.com";

	test("a same-origin navigation is allowed, on either proof", () => {
		for (const record of [
			{ "sec-fetch-site": "same-origin" },
			{ "sec-fetch-site": "none" },
			{ origin: here },
		]) {
			assert.equal(
				sameOrigin({ headers: headers(record), origin: here }).sameOrigin,
				true,
				`refused a same-origin request: ${JSON.stringify(record)}`,
			);
		}
	});

	test("a cross-origin form post is refused, on either proof", () => {
		for (const record of [
			{ "sec-fetch-site": "cross-site" },
			{ "sec-fetch-site": "same-site" },
			{ "sec-fetch-site": "sibling" },
			{ origin: "https://evil.example" },
			// A subdomain of this site is still another origin, and a subdomain is
			// what an attacker with one XSS on a sibling property gets.
			{ origin: "https://assets.evil.example" },
		]) {
			const verdict = sameOrigin({ headers: headers(record), origin: here });
			assert.equal(verdict.sameOrigin, false, `allowed ${JSON.stringify(record)}`);
			assert.ok(!verdict.sameOrigin && verdict.why.length > 0, "a refusal must say why");
		}
	});

	test("a request with no browser provenance at all is refused", () => {
		// `curl` and server-to-server `fetch()` send neither header. There is no
		// honest reason for either to change a rating through a form endpoint, and
		// "no header" is exactly the case a check written as `if (origin)` gets
		// wrong.
		const verdict = sameOrigin({ headers: headers({}), origin: here });
		assert.equal(verdict.sameOrigin, false);
		assert.ok(!verdict.sameOrigin && verdict.why.includes("no Sec-Fetch-Site"));
	});

	test("Origin: null is refused rather than treated as absent", () => {
		const verdict = sameOrigin({ headers: headers({ origin: "null" }), origin: here });
		assert.equal(verdict.sameOrigin, false);
	});

	test("X-EmDash-Request is not accepted as proof of anything", () => {
		// `/api/signal` sets this header on the request it makes *into* EmDash, so
		// it is not evidence about the browser. A check that accepted it would pass
		// every attacker while looking like a defence.
		const verdict = sameOrigin({
			headers: headers({ "x-emdash-request": "1" }),
			origin: here,
		});
		assert.equal(verdict.sameOrigin, false);
	});

	test("the refusal does not echo the hostile value back", () => {
		const response = crossOriginResponse();
		assert.equal(response.status, 403);
		assert.match(response.headers.get("cache-control") ?? "", /no-store/);
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	});
});

/* -------------------------------------------------------------------------- */
/* Redirects                                                                  */
/* -------------------------------------------------------------------------- */

describe("a redirect can only go somewhere on this site", () => {
	const origin = "https://assets.loftwah.com";

	test("a real back link survives", () => {
		assert.equal(safeReturnPath("/possibilities/density-gradient", origin, "/"), "/possibilities/density-gradient");
		assert.equal(safeReturnPath("/board?tab=2", origin, "/"), "/board?tab=2");
	});

	test("the classic forms are refused", () => {
		for (const value of [
			"https://evil.example/evil",
			"http://evil.example",
			"//evil.example",
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"https:evil.example",
			"",
			"   ",
			null,
			undefined,
		]) {
			assert.equal(
				safeReturnPath(value, origin, "/"),
				"/",
				`allowed ${JSON.stringify(value)}`,
			);
		}
	});

	test("the backslash form that passes a startsWith('/') check is refused", () => {
		// `new URL("/\\evil.com", origin)` is `https://evil.com/`: the WHATWG parser
		// treats `\` as `/` for a special scheme. The old check was
		// `back.startsWith("/") && !back.startsWith("//")`, which passes all three
		// of these.
		for (const value of ["/\\evil.com", "/\\\\evil.com", "/\t/evil.com", "/\\/\\/evil.com"]) {
			assert.equal(
				safeReturnPath(value, origin, "/"),
				"/",
				`allowed ${JSON.stringify(value)}`,
			);
			// And the reason it matters is demonstrable, not theoretical.
			const parsed = new URL(value, origin);
			if (parsed.origin !== origin) {
				assert.equal(parsed.origin, "https://evil.com");
			}
		}
	});

	test("a header-splitting attempt is refused", () => {
		assert.equal(safeReturnPath("/board\r\nX-Injected: 1", origin, "/"), "/");
		assert.equal(safeReturnPath("/board\nSet-Cookie: a=b", origin, "/"), "/");
	});
});

/* -------------------------------------------------------------------------- */
/* Links, media and content types                                             */
/* -------------------------------------------------------------------------- */

describe("a recorded URL cannot become a script", () => {
	test("only http(s) is a source link", () => {
		assert.equal(safeHttpUrl("https://github.com/a/b"), "https://github.com/a/b");
		assert.equal(safeHttpUrl("http://github.com/a/b"), "http://github.com/a/b");
		for (const value of [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			"data:text/html;base64,PHNjcmlwdD4=",
			"vbscript:msgbox(1)",
			"file:///etc/passwd",
			"/relative",
			"not a url",
		]) {
			assert.equal(safeHttpUrl(value), null, `allowed ${value}`);
		}
	});

	test("media is a path or an http(s) URL, and never anything else", () => {
		assert.equal(safeMediaSrc("/specimens/density-gradient.svg"), "/specimens/density-gradient.svg");
		assert.equal(safeMediaSrc("https://cdn.example/a.png"), "https://cdn.example/a.png");
		for (const value of [
			"javascript:alert(1)",
			"data:image/svg+xml,<svg onload=alert(1)>",
			"data:text/html,<script>alert(1)</script>",
			"//evil.example/a.png",
		]) {
			assert.equal(safeMediaSrc(value), null, `allowed ${value}`);
		}
	});

	test("mediaSrc falls back rather than emitting a hostile recorded value", () => {
		const hostile = {
			specimen: "javascript:alert(document.domain)",
			image: { id: "m1", src: "data:text/html,<script>alert(1)</script>" },
		};
		assert.equal(mediaSrc(hostile), "/specimens/placeholder.svg");
		// And the refusal is per-field, not all-or-nothing: a good image still wins.
		assert.equal(
			mediaSrc({ ...hostile, image: { id: "m1", src: "/_emdash/api/media/file/a.png" } }),
			"/_emdash/api/media/file/a.png",
		);
	});

	test("a content type is a MIME type, not a header fragment", () => {
		assert.equal(safeContentType("image/png"), "image/png");
		assert.equal(safeContentType("IMAGE/PNG"), "image/png");
		for (const value of [
			"image/png\r\nX-Injected: 1",
			"text/html; charset=utf-8",
			"not a type",
			"a/b/c",
			"",
			null,
		]) {
			assert.equal(safeContentType(value), null, `allowed ${JSON.stringify(value)}`);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* XSS from CMS text                                                          */
/* -------------------------------------------------------------------------- */

describe("the one set:html sink cannot be reached with markup", () => {
	/** Every `<` in the output that is not the start of a `<mark>` tag. */
	const strayTags = (html: string | null | undefined) =>
		(html ?? "").replace(/<\/?mark>/g, "").includes("<");

	test("a snippet is escaped, and only <mark> is re-admitted", () => {
		const escaped = safeSnippet(
			"<img src=x onerror=alert(1)> and <mark>seam</mark> & <b>bold</b>",
		);
		assert.equal(strayTags(escaped), false, `markup survived: ${escaped}`);
		assert.ok(escaped?.includes("<mark>seam</mark>"), "the highlight must survive");
		assert.ok(escaped?.includes("&amp;"), "an ampersand is still escaped");
		assert.ok(escaped?.includes("&lt;img src=x onerror=alert(1)&gt;"));
	});

	test("a script in a snippet is text, and quotes are escaped too", () => {
		const escaped = safeSnippet(`<script>alert('xss')</script>`);
		assert.equal(escaped?.includes("<script"), false);
		assert.equal(escaped?.includes("&#39;"), true);
	});

	test("an attribute break cannot escape the element", () => {
		// `escapeHtml` in `search-text.ts` escapes quotes as well as angle
		// brackets, so a snippet is safe even if a future component moves it into
		// an attribute.
		const escaped = safeSnippet(`" onmouseover="alert(1)`);
		assert.equal(escaped?.includes(`" `), false);
		assert.ok(escaped?.includes("&quot;"));
	});

	test("an empty snippet is null, not an empty element", () => {
		assert.equal(safeSnippet(null), null);
		assert.equal(safeSnippet(""), null);
	});
});

/* -------------------------------------------------------------------------- */
/* Content-Security-Policy                                                    */
/* -------------------------------------------------------------------------- */

describe("the public policy needs no hash, because the site ships no inline script", () => {
	test("the directives are the restrictive ones", () => {
		for (const directive of [
			"default-src 'self'",
			"object-src 'none'",
			"base-uri 'self'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		]) {
			assert.ok(PUBLIC_CSP_DIRECTIVES.includes(directive), `missing ${directive}`);
		}
	});

	test("no directive names a third-party origin", () => {
		for (const directive of PUBLIC_CSP_DIRECTIVES) {
			assert.equal(
				/(https?:)?\/\/(?!self|localhost)/.test(directive.replace(/'self'/g, "")),
				false,
				`a third-party origin in: ${directive}`,
			);
		}
	});

	test("script-src is 'self' alone — no hash, no nonce, no unsafe-inline", () => {
		// This is the end state #53 was reaching for with a hash list and did not
		// reach. The policy carried `'sha256-9204…'`, the browser computed the
		// identical digest for the same script, and blocked it anyway — so
		// `--masthead-h` was never published and the sticky rail overlapped the
		// masthead by 43px. The measurement became a bundled module instead, and the
		// requirement disappeared rather than being maintained by hand.
		const policy = contentSecurityPolicy();
		const scriptSrc = policy
			.split(";")
			.map((d) => d.trim())
			.find((d) => d.startsWith("script-src"));
		assert.equal(scriptSrc, "script-src 'self'");
		assert.equal(scriptSrc?.includes("'unsafe-inline'"), false);
		assert.equal(scriptSrc?.includes("'unsafe-eval'"), false);
		assert.equal(
			scriptSrc?.includes("sha256"),
			false,
			"a hash means the list must be kept in step with the bytes by hand — the failure this replaces",
		);
	});

	test("the one concession is inline styles, and it is named", () => {
		// `style-src 'self'` was measured breaking the site: Chromium blocked every
		// component `<style>` block, `document.styleSheets.length` was 0 and the page
		// rendered unstyled. The concession is real, it is the only one, and it is
		// stated here rather than discovered in a browser.
		const policy = contentSecurityPolicy();
		assert.ok(policy.includes("style-src 'self' 'unsafe-inline'"));
		assert.equal((policy.match(/'unsafe-inline'/g) ?? []).length, 1);
	});
});

/* -------------------------------------------------------------------------- */
/* Cookies                                                                    */
/* -------------------------------------------------------------------------- */

describe("the shortlist cookie is bounded and normalised on the way out too", () => {
	test("a hand-edited board name goes through the same sanitiser as a typed one", () => {
		// The write path ran `normaliseBoardName`; the read path did not. So a
		// cookie could carry a name the app had agreed never to accept, and it was
		// rendered because nobody re-checked it on the way out.
		const raw = encodeURIComponent(
			JSON.stringify({ '"><script>alert(1)</script>': ["density-gradient"] }),
		);
		const boards = parseBoards(raw);
		const names = Object.keys(boards).filter((n) => n !== "default");
		for (const name of names) {
			assert.equal(/[<>"']/.test(name), false, `board name kept markup: ${name}`);
			assert.ok(name.length <= MAX_BOARD_NAME);
		}
	});

	test("the cookie is bounded on every axis", () => {
		const many = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => [`board-${i}`, Array.from({ length: 60 }, (_, j) => `slug-${i}-${j}`)]),
		);
		const boards = parseBoards(encodeURIComponent(JSON.stringify(many)));
		assert.ok(Object.keys(boards).length <= 6, "too many boards survived");
		for (const slugs of Object.values(boards)) {
			assert.ok(slugs.length <= 24, "too many slugs survived");
		}
		// And it still round-trips through the writer.
		const reparsed = parseBoards(serialiseBoards(boards));
		assert.equal(Object.keys(reparsed).length, Object.keys(boards).length);
	});
});

/* -------------------------------------------------------------------------- */
/* Report storage bound                                                       */
/* -------------------------------------------------------------------------- */

describe("a report cannot be flooded into the moderation queue", () => {
	const base = {
		subjectType: "possibility" as const,
		subjectSlug: "density-gradient",
		reason: "licence-changed" as const,
		actorId: "user-1",
	};

	test("the same concern in the same window lands on the same slug", () => {
		// Starting on a bucket boundary, so the last millisecond of the window is
		// still in it — the assertion is about the rule and not about arithmetic.
		const start = REPORT_WINDOW_MS * 4;
		const first = reportSlug({ ...base, millis: start });
		const second = reportSlug({ ...base, millis: start + REPORT_WINDOW_MS - 1 });
		assert.equal(
			first,
			second,
			"two clicks in one window must collide rather than create two rows",
		);
	});

	test("the next window is a new report, so history is not lost", () => {
		const start = REPORT_WINDOW_MS * 4;
		const first = reportSlug({ ...base, millis: start });
		const next = reportSlug({ ...base, millis: start + REPORT_WINDOW_MS });
		assert.notEqual(first, next);
	});

	test("different readers, entries and reasons never share a slug", () => {
		const at = REPORT_WINDOW_MS * 4;
		const slugs = new Set([
			reportSlug({ ...base, millis: at }),
			reportSlug({ ...base, actorId: "user-2", millis: at }),
			reportSlug({ ...base, subjectSlug: "seamless-loop", millis: at }),
			reportSlug({ ...base, reason: "duplicate", millis: at }),
		]);
		assert.equal(slugs.size, 4);
	});

	test("the slug is a slug: no traversal, no separator, no unbounded length", () => {
		const slug = reportSlug({
			...base,
			subjectSlug: "../../etc/passwd",
			actorId: "a/b/../c",
			millis: REPORT_WINDOW_MS * 4,
		});
		assert.ok(slug.length <= 120);
		assert.equal(slug.includes("/"), false, `a separator survived: ${slug}`);
		assert.equal(slug.includes(".."), false, `traversal survived: ${slug}`);
		assert.match(slug, /^[a-z0-9-]+$/);
	});

	test("a subject slug has to look like a catalogue slug at all", () => {
		assert.equal(isSubjectSlug("density-gradient"), true);
		assert.equal(isSubjectSlug("seamless-loop-4b21"), true);
		for (const value of [
			"",
			"../admin",
			"a/b",
			"Density-Gradient",
			"a".repeat(200),
			"<script>",
			"a b",
			null,
		]) {
			assert.equal(isSubjectSlug(value), false, `accepted ${JSON.stringify(value)}`);
		}
	});

	test("slugSafe never returns an empty or unusable component", () => {
		assert.equal(slugSafe("density-gradient"), "density-gradient");
		assert.equal(slugSafe("../../etc/passwd"), "etc-passwd");
		assert.equal(slugSafe(""), "x");
		assert.equal(slugSafe(null), "x");
		assert.equal(slugSafe("!!!"), "x");
		assert.match(slugSafe("A".repeat(200), "x"), /^[a-z0-9-]{1,60}$/);
	});
});

/* -------------------------------------------------------------------------- */
/* Download response                                                          */
/* -------------------------------------------------------------------------- */

describe("a retained payload is inert whatever it claims to be", () => {
	const example = {
		slug: "sfx-pack-1",
		title: "SFX pack",
		downloadable: true,
		rightsStatus: "cleared",
		attribution: "Someone",
		contentHash: "a".repeat(64),
		sourcePath: "assets/sfx/zap.wav",
	} as unknown as Example;

	test("a refusal is sandboxed and unsniffable too", async () => {
		const refused = await payloadResult({ example: { ...example, rightsStatus: "reference" } as Example, retained: null });
		assert.equal(refused.status, 403);
		assert.equal(refused.headers["x-content-type-options"], "nosniff");
		assert.match(refused.headers["content-security-policy"] ?? "", /^sandbox;/);
	});

	test("the retained bytes carry attachment, nosniff and a sandbox", async () => {
		const bytes = new TextEncoder().encode("not really audio");
		const digest = createHash("sha256").update(bytes).digest("hex");
		const served = await payloadResult({
			example: { ...example, contentHash: digest } as Example,
			retained: { bytes, contentType: "audio/wav" },
		});
		assert.equal(served.status, 200);
		assert.match(served.headers["content-disposition"] ?? "", /^attachment; filename="/);
		assert.equal(served.headers["x-content-type-options"], "nosniff");
		assert.match(served.headers["content-security-policy"] ?? "", /^sandbox;/);
		assert.equal(served.headers["content-type"], "audio/wav");
	});

	test("a recorded content type that is not a MIME type is not echoed", async () => {
		const bytes = new TextEncoder().encode("<script>alert(1)</script>");
		const digest = createHash("sha256").update(bytes).digest("hex");
		const served = await payloadResult({
			example: { ...example, contentHash: digest } as Example,
			retained: { bytes, contentType: "text/html\r\nX-Injected: 1" },
		});
		assert.equal(served.headers["content-type"], "application/octet-stream");
		assert.equal(served.headers["x-injected"], undefined);
	});

	test("an unparseable filename cannot break the header it is in", async () => {
		const bytes = new TextEncoder().encode("x");
		const digest = createHash("sha256").update(bytes).digest("hex");
		const served = await payloadResult({
			example: {
				...example,
				contentHash: digest,
				sourcePath: 'assets/a";\r\nSet-Cookie: admin=1/x.wav',
			} as Example,
			retained: { bytes },
		});
		const disposition = served.headers["content-disposition"] ?? "";
		assert.match(disposition, /^attachment; filename="[\w.-]+"$/);
		assert.equal(disposition.includes("\n"), false);
		assert.equal(disposition.includes("\r"), false);
		assert.equal(disposition.includes("Set-Cookie"), false);
	});
});

/* -------------------------------------------------------------------------- */
/* Live evidence                                                              */
/* -------------------------------------------------------------------------- */

describe("against the running server", () => {
	let server = "down";
	test("probe", async () => {
		try {
			const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
			server = res.ok ? "up" : "broken";
		} catch {
			server = "down";
		}
	});
	test("the security headers are actually served", async (t) => {
		if (server !== "up") return t.skip(`no server at ${baseUrl}`);
		const res = await fetch(`${baseUrl}/`);
		const csp = res.headers.get("content-security-policy") ?? "";
		assert.match(csp, /default-src 'self'/);
		assert.match(csp, /object-src 'none'/);
		assert.match(csp, /form-action 'self'/);
		const scriptSrc = csp
			.split(";")
			.map((d) => d.trim())
			.find((d) => d.startsWith("script-src"));
		assert.ok(scriptSrc, "no script-src in the served policy");
		assert.equal(
			scriptSrc,
			"script-src 'self'",
			"the served policy must need no hash: there is no inline script to allow",
		);
		assert.equal(scriptSrc?.includes("'unsafe-inline'"), false);
		// The single concession in the whole policy is inline styles, because Astro
		// emits inline `<style>` blocks and `style-src 'self'` blanked the site.
		assert.equal((csp.match(/'unsafe-inline'/g) ?? []).length, 1);
		assert.match(csp, /style-src 'self' 'unsafe-inline'/);
		assert.equal(res.headers.get("x-content-type-options"), "nosniff");
		// `frame-ancestors 'none'` is the real anti-framing control; the header
		// EmDash sets is `SAMEORIGIN`, which still permits this site to frame
		// itself. Assert the stronger one is present.
		assert.match(csp, /frame-ancestors 'none'/);
	});

	test("a cross-origin POST to a write endpoint is refused", async (t) => {
		if (server !== "up") return t.skip(`no server at ${baseUrl}`);
		for (const path of ["/api/board", "/api/signal"]) {
			const res = await fetch(`${baseUrl}${path}`, {
				method: "POST",
				redirect: "manual",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: "https://evil.example",
				},
				body: new URLSearchParams({ action: "clear", intent: "rate" }),
			});
			assert.equal(res.status, 403, `${path} answered ${res.status} to a cross-origin post`);
		}
	});

	test("a same-origin POST still works, so the check is not a lockout", async (t) => {
		if (server !== "up") return t.skip(`no server at ${baseUrl}`);
		const res = await fetch(`${baseUrl}/api/board`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: baseUrl,
				"sec-fetch-site": "same-origin",
			},
			body: new URLSearchParams({
				action: "save",
				slug: "density-gradient",
				board: "default",
				back: "/board",
			}),
		});
		assert.equal(res.status, 303);
		assert.match(res.headers.get("location") ?? "", /^\/board/);
	});

	test("?fresh cannot be used to force a rebuild per request", async (t) => {
		if (server !== "up") return t.skip(`no server at ${baseUrl}`);
		const first = await fetch(`${baseUrl}/api/catalogue.json?fresh`);
		assert.equal(first.status, 200);
		// The second one inside the cooldown must be answered from the cache.
		const second = await fetch(`${baseUrl}/api/catalogue.json?fresh`);
		assert.equal(second.status, 200);
		assert.equal(
			second.headers.get("x-catalogue-fresh"),
			"served-stale",
			"a second ?fresh inside the cooldown rebuilt the catalogue anyway",
		);
		// And the generated stamp did not move, which is the observable proof.
		assert.equal(first.headers.get("x-catalogue-generated"), second.headers.get("x-catalogue-generated"));
	});

	test("the record and payload routes answer nosniffed and sandboxed", async (t) => {
		if (server !== "up") return t.skip(`no server at ${baseUrl}`);
		for (const path of ["/api/record/not-a-real-example", "/api/payload/not-a-real-example"]) {
			const res = await fetch(`${baseUrl}${path}`);
			assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${path} has no nosniff`);
			assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/, `${path} is not sandboxed`);
		}
	});
});/* -------------------------------------------------------------------------- */
/* #53 — this review's own findings                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything above this line was in the branch when the review started. What
 * follows is what the review itself found by attacking it, and each test names
 * the measurement it replaces.
 */

describe("the abuse window survives the layer graph being rebuilt per request", () => {
	test("a fresh graph each request does not reset the count", async () => {
		// `appLayer()` builds a fresh service graph for every call — deliberately,
		// so no EmDash client is retained for the life of the isolate. When the
		// window map lived *inside* `RateLimits.layer` that also meant a fresh `Ref`
		// per request, so every caller was the first caller and the limiter refused
		// nothing.
		//
		// Measured: 70 rapid `POST /api/board` against a 60-per-minute policy
		// answered `303` seventy times and `429` never. `429` is the only status
		// `/api/board` can produce from this decision, so its absence is the proof.
		//
		// The regression test runs the layer twice — two separate `provide` calls,
		// which is what a second request does — and asserts the second one is
		// already limited. Before the fix the second call started from zero.
		const { Effect, Exit } = await import("effect");
		const { RateLimits } = await import("../src/lib/effect/limits.ts");

		/** One *separate* layer graph, which is what a separate request gets. */
		const attempt = (identity: string) =>
			Effect.runPromiseExit(
				Effect.provide(
					Effect.flatMap(RateLimits, (limits) =>
						limits.take({ identity, limit: 3, windowMs: 60_000, subject: "probe" }),
					),
					RateLimits.layer,
				),
			);

		const allowed = async (identity: string) => {
			const exit = await attempt(identity);
			assert.ok(Exit.isSuccess(exit), "the limiter answers with a decision, not a failure");
			return exit.value.allowed;
		};

		// A fresh graph per call, three times, and the fourth is refused. Before the
		// fix each of these built its own `Ref`, so all four were the first attempt
		// and all four were allowed.
		const identity = `test:across-graphs-${Math.random()}`;
		assert.equal(await allowed(identity), true, "first attempt");
		assert.equal(await allowed(identity), true, "second attempt, new graph");
		assert.equal(await allowed(identity), true, "third attempt, new graph");
		assert.equal(await allowed(identity), false, "fourth attempt is over the limit");
	});
});

describe("hostile catalogue text cannot reorder what a reader sees", () => {
	// Measured on a page of this app before the fix: a `rights_note` of
	// "Reference only ‮egilavre for commercial use" rendered with the reassurance
	// *last*, and `‮gnp.exe` rendered as `exe.png`. Five U+202E characters reached
	// the HTML, inside a `<p>`, verbatim.
	test("a right-to-left override is replaced, not merely escaped", () => {
		const out = readableText("Reference only \u202Eegilavre for commercial use");
		assert.equal(out.includes("\u202E"), false);
		assert.ok(out.includes("\uFFFD"), "the removal must be visible, not silent");
		assert.match(out, /Reference only/);
		// The characters either side survive, so the sentence is still legible and
		// is still checkable.
		assert.match(out, /egilavre for commercial use/);
	});

	test("the filename-reversal payload renders as itself", () => {
		// `‮gnp.exe` reads as `exe.png` on screen. This is the whole trick.
		assert.equal(readableText("\u202Egnp.exe"), "\uFFFDgnp.exe");
	});

	test("every invisible bidi control is covered, not just U+202E", () => {
		for (const ch of [
			"\u202A", // LRE
			"\u202B", // RLE
			"\u202C", // PDF
			"\u202D", // LRO
			"\u202E", // RLO
			"\u2066", // LRI
			"\u2067", // RLI
			"\u2068", // FSI
			"\u2069", // PDI
			"\u200E", // LRM
			"\u200F", // RLM
			"\u061C", // ALM
		]) {
			assert.equal(
				readableText(`before${ch}after`).includes(ch),
				false,
				`U+${ch.codePointAt(0)!.toString(16).toUpperCase()} survived`,
			);
		}
	});

	test("a soft hyphen cannot make two different URLs look the same", () => {
		const out = readableText("example\u00AD.com");
		assert.equal(out.includes("\u00AD"), false);
		assert.match(out, /example/);
		assert.match(out, /\.com$/);
	});

	test("ordinary text is untouched, including non-Latin scripts", () => {
		for (const value of [
			"Health you read off the world, not off a bar",
			"Naïve café — 日本語のテキスト",
			"Ελληνικά, Кириллица, עברית",
			"a/b/c/d.png",
			"",
		]) {
			assert.equal(readableText(value), value.trim());
		}
	});

	test("a homoglyph is left alone, deliberately", () => {
		// Folding `а` (Cyrillic) to `a` (Latin) would be a lie about provenance in
		// the other direction: it would present someone's choice of characters as an
		// accident. They are handled by not acting on such a string — see
		// `docs/SECURITY.md` — rather than by quietly rewriting it.
		const homoglyph = "\uD835\uDCAC\uD835\uDDA6\uD835\uDDA6\uD835\uDE0A\uD835\uDE0A";
		assert.equal(readableText(homoglyph), homoglyph);
	});

	test("a limit is honoured when one is asked for", () => {
		assert.equal(readableText("a".repeat(500), 10), `${"a".repeat(10)}…`);
		assert.equal(readableText("short", 500), "short");
		assert.equal(readableText(null), "");
		assert.equal(readableText(undefined), "");
	});

	test("the catalogue's own text projection is what does it", async () => {
		// One projection, every page. If this moved out of `catalogue.ts` the wall,
		// the drill-in, search and the JSON contract would each have to remember.
		const source = await codeOnly("../src/lib/catalogue.ts");
		assert.match(source, /const text = \(value: string \| null \| undefined\): string \| null =>/);
		assert.match(source, /readableText\(value\)/);
	});
});

describe("the first-run setup wizard is not reachable from a public origin", () => {
	// The measurement is in `setupWizardRefusal`'s doc comment. The short version:
	// `POST /_emdash/api/setup/admin` on production answers a *body* validation
	// error rather than `ADMIN_EXISTS`, and that check runs before the body is
	// parsed — so `countUsers() === 0`, and the three-step wizard would have
	// created the first administrator for whoever asked.
	test("the refusal is a 404 that reveals nothing and is not indexed", () => {
		const response = setupWizardRefusal();
		assert.equal(response.status, 404);
		assert.equal(response.headers.get("x-robots-tag"), "noindex");
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	});

	test("the refusal does not echo anything the caller sent", async () => {
		const body = await setupWizardRefusal().text();
		assert.equal(body.includes("<"), false, "a refusal body must not be a document");
		// It says how to proceed and nothing about the instance.
		assert.match(body, /EMDASH_ALLOW_SETUP/);
	});

	test("the guarded paths are the wizard's, and the middleware gates them", async () => {
		// Not a unit test of the middleware — it imports `astro:middleware`, which
		// `node --test` cannot load. This asserts the paths that must be refused are
		// named in the middleware, so a rename cannot quietly widen the hole.
		const source = await codeOnly("../src/middleware.ts");
		assert.match(source, /"\/_emdash\/admin\/setup"/);
		assert.match(source, /"\/_emdash\/api\/setup"/);
		assert.match(source, /EMDASH_ALLOW_SETUP/);
		// And it refuses before calling `next()`, so the wizard is never reached.
		assert.match(source, /if \(!SETUP_ALLOWED && isSetupPath[\s\S]*?return setupWizardRefusal\(\)/);
	});
});

/** A source file with its block and line comments removed, so a test that greps
 *  for a pattern is reading code and not the prose explaining why the pattern was
 *  removed. Every assertion below needs this: the comments quote the defects. */
async function codeOnly(relativePath: string): Promise<string> {
	const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
	return source
		.split("\n")
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.join("\n");
}

describe("a form POST answers with a redirect, not a 500", () => {
	// This one cost the whole endpoint. Astro's helper is
	// `redirect(path, status)` — the second argument is a status *code*:
	//
	//   redirect(path, status) {
	//     return new Response(null, { status: status || 302, headers: { Location: path } })
	//   }
	//
	// Passing `{ status: 303, headers }` puts that object into `status`, the
	// Response constructor coerces it to 0, and it throws — for every POST. The
	// throw became a 500, Astro treats a 500 as reroutable
	// (`REROUTABLE_STATUS_CODES = [404, 500]`), so it ran the route again with the
	// same Request, and the second run failed on `formData()` against a consumed
	// body. The endpoint answered everything, valid same-origin requests included,
	// with `500 Body has already been used` — so the CSRF check below it never ran.
	test("a 303 built by hand is a 303, and carries Retry-After", () => {
		const headers = new Headers({ location: "/api/signal?note=x" });
		headers.set("retry-after", "30");
		const response = new Response(null, { status: 303, headers });
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/api/signal?note=x");
		assert.equal(response.headers.get("retry-after"), "30");
	});

	test("and the shape Astro's helper actually wants is a status code", async () => {
		// The assertion that would have caught it: `redirect()` takes a number.
		const source = await readFile(
			new URL("../node_modules/astro/dist/core/middleware/index.js", import.meta.url),
			"utf8",
		);
		assert.match(source, /redirect\(path, status\) \{/);
		assert.match(source, /status: status \|\| 302/);

		// And the handler must not pass it a `ResponseInit`. `codeOnly`, because the
		// comments in that file quote the mistake in order to explain it.
		const handler = await codeOnly("../src/pages/api/signal.ts");
		assert.equal(
			/redirect\([^)]*\{\s*status:/.test(handler),
			false,
			"/api/signal still passes a ResponseInit to redirect(), which is a 500 waiting to happen",
		);
	});
});

describe("the curation gate is not an existence oracle", () => {
	// Measured against production: `/curate` answered `404` with `text/plain` and
	// nine bytes, where a URL that genuinely does not exist answers `404` with
	// `text/html` and 14,028 bytes — so an anonymous visitor could enumerate the
	// protected routes from the size of the refusal.
	test("the gate renders the site's own 404 rather than a bare string", async () => {
		const source = await codeOnly("../src/pages/curate/index.astro");
		assert.match(source, /return Astro\.rewrite\("\/404"\)/);
		assert.equal(
			/new Response\("Not found"/.test(source),
			false,
			"a bare 404 body is the oracle: it is 9 bytes of text/plain and nothing else is",
		);
	});

	test("a gate that fails open is a gate that is not there", async () => {
		// `Number(user.role ?? 0)` returns `NaN` for a role the gate does not
		// recognise, and `NaN < 40` is `false` — so the old expression *granted*
		// access to exactly the sessions it existed to refuse. EmDash types `role`
		// as a number, so this is hardening rather than a proven exploit; it is
		// fixed because the failure mode of a gate is the one thing that must not
		// be "it depends on the input's type".
		const source = await codeOnly("../src/pages/curate/index.astro");
		assert.match(source, /const roleLevel = \(user: unknown\): number => \{/);
		assert.match(source, /Number\.isFinite\(raw\)/);
		assert.equal(/Number\(\(\s*Astro\.locals/.test(source), false, "the failing-open read is back");
	});
});