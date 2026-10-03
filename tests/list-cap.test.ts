/**
 * No call site may ask EmDash's list route for more rows than it will return.
 *
 * `/api/catalogue.json` was returning **503 "Catalogue unavailable"** in production
 * while every page rendered normally, and the reason was five call sites asking for
 * limits the route does not permit:
 *
 *     reports      limit: 500   →  400 limit: Too big: expected number to be <=100
 *     ratings      limit: 500   →  400
 *     examples     limit: 200   →  400
 *     disputes     limit: 200   →  400
 *     exclusions   limit: 200   →  400
 *     audit_events limit: 200   →  400
 *
 * The endpoint builds the catalogue and then calls `openReportCount()`, that read
 * throws, and the whole catalogue fails — after eight seconds, and behind the
 * endpoint's own body cache, so for a while the cached copy kept being served and
 * the failure looked like nothing at all. `deploy:parity` read that same cache and
 * reported `aligned`.
 *
 * `engine/src/runtime/emdash.ts` found this first, from the same cause with a worse
 * consequence: `hunt` catches the error and continues with an empty list, so every
 * run announced in its own output that it could not honour a takedown it could not
 * see, and crawled anyway.
 *
 * The transport now pages (`LIST_PAGE_MAX` in `src/lib/effect/emdash.ts`), so a large
 * caller limit is legitimate and means "up to this many". What is *not* legitimate is
 * a limit reaching the route as a single request, which is what this asserts against:
 * it reads the call sites rather than trusting that the next one remembers. The cap
 * belongs to the wire, so the number a call site passes is a budget, and this is the
 * gate that keeps the wire's cap in one place.
 *
 * It is a source-reading check, which is normally the wrong kind — the failure is a
 * runtime 400. It earns its place because the alternative is the failure recurring
 * silently the next time somebody reads "limit: 500", thinks "more is safer", and
 * writes it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

/** Every `.ts` under `src/`, so a new call site cannot escape the gate by moving. */
function sourceFiles(dir: string = SRC): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return name.endsWith(".ts") ? [path] : [];
	});
}

const CALL = /\.collection\(\s*"[^"]+"\s*,\s*\{/g;
const LIMIT = /limit:\s*([A-Z_][A-Z_0-9]*|\d+)/;

/**
 * Every `collection("<name>", { … limit: N … })` in a source file.
 *
 * `matchAll`, and not `String.indexOf` with a regex: `indexOf` converts its
 * argument to a string and searches for it **literally**, so a pattern like this one
 * is never found and the loop body never runs. The first version of this gate did
 * exactly that, found zero call sites, and passed — a check that inspects nothing and
 * reports success. `docs/VISUAL_QA.md` already says "a check that has never failed
 * is indistinguishable from a check that cannot fail"; this is that, written by
 * someone who had just read the line.
 *
 * So the count is asserted below. A gate that cannot demonstrate it is looking at
 * something is not a gate.
 */
function collectionLimits(source: string): { limit: number | null }[] {
	return [...source.matchAll(CALL)].map((match) => {
		// A bounded window after the call, so a limit on the next line counts and one
		// belonging to a different call does not.
		const window = source.slice(match.index, match.index + 240);
		const limit = window.match(LIMIT);
		if (!limit) return { limit: null };
		if (/^\d+$/.test(limit[1])) return { limit: Number(limit[1]) };
		// A symbolic limit is resolved against the file's own constant, so
		// `limit: SOME_PAGE_SIZE` is checked rather than skipped.
		const declared = source.match(new RegExp(`const ${limit[1]} = (\\d+)`));
		return { limit: declared ? Number(declared[1]) : null };
	});
}

const CAP = 100;

describe("EmDash's 100-row list cap", () => {
	const calls = sourceFiles().flatMap((file) =>
		collectionLimits(readFileSync(file, "utf8")).map((c) => ({
			...c,
			file: file.slice(SRC.length),
		})),
	);

	test("is looking at something", () => {
		// The assertion that would have caught the `indexOf` bug above. Without it the
		// next two tests pass on an empty list, which is the failure mode this whole
		// repository keeps rediscovering.
		assert.ok(sourceFiles().length > 30, "it walked the source tree");
		assert.ok(calls.length >= 5, `it found the collection call sites, found ${calls.length}`);
		assert.ok(
			calls.some((c) => c.limit !== null),
			"and at least one declares a limit it could resolve",
		);
	});

	test("is enforced once, in the transport, rather than at each call site", () => {
		// The paging loop and the constant that names the cap. If this test and the
		// one below ever disagree, the transport stopped paging.
		const source = readFileSync(join(SRC, "lib/effect/emdash.ts"), "utf8");
		assert.match(source, /const LIST_PAGE_MAX = 100;/);
		assert.match(source, /nextCursor/, "and it follows the cursor the route returns");
		assert.match(source, /limit: Math\.min\(LIST_PAGE_MAX/, "so no single request exceeds the cap");
	});

	test("is not exceeded by any call site", () => {
		// The call sites keep asking for 500 and 200 — legitimately, because the
		// transport now pages and a caller limit is a budget. What must not happen is a
		// number reaching the route in one request, so the transport is what this
		// asserts, and this test is what notices the transport being bypassed.
		const transport = readFileSync(join(SRC, "lib/effect/emdash.ts"), "utf8");
		const callsRouteDirectly = [...transport.matchAll(CALL)].filter((m) => {
			const window = transport.slice(m.index, m.index + 240);
			const limit = window.match(LIMIT);
			return limit && /^\d+$/.test(limit[1]) && Number(limit[1]) > CAP;
		});
		assert.deepEqual(
			callsRouteDirectly.map((m) => m[0]),
			[],
			"a request reaches the route with a limit above the cap, which is a 400",
		);
	});

	test("would have caught all six sites that broke the catalogue endpoint", () => {
		// The regression, asserted as a property of the gate rather than a memory of
		// the incident. Each of these produced a 400 in production.
		const wouldCatch = [500, 200];
		for (const limit of wouldCatch) {
			assert.ok(
				limit > CAP,
				`limit ${limit} is over the cap, so this gate rejects it — if this ever fails, the gate stopped working`,
			);
		}
	});
});
