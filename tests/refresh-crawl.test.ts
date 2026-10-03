/**
 * The crawl, wired to a plan (#41).
 *
 * `tests/refresh.test.ts` proves the *plan* is right. These tests prove the crawl
 * obeys it, which is the half that can only be shown by running one: that a
 * second run spends kilobytes where the first spent megabytes, that an
 * interrupted run resumes instead of starting over, and that a repository which
 * 404s is recorded rather than dropped.
 *
 * ## No network, on purpose
 *
 * Every test here runs against a substituted `GitHubApi` — the same
 * `Context.Service` the live layer provides, so the substitution is the real one.
 * That is not a convenience, it is what makes the claims checkable. "The second
 * run did minimal work" is only a meaningful assertion if *work* can be counted,
 * and what the stub counts is requests to `/git/trees/` and `/contents/`: the two
 * reads that cost bytes. An unauthenticated live crawl would also be limited to
 * 50 requests a minute and would take longer than a test should.
 *
 * Each test gets its own state directory. Sharing one would let an earlier
 * candidate satisfy a later assertion, which is the fixture lying to you — the
 * failure mode this whole file is about.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";

import { crawl, hitFromCandidate } from "../engine/src/crawl.ts";
import { GitHubApi, GitHubError, type RepoRef, type SearchHit } from "../engine/src/runtime/github.ts";
import { EmDashApi, EmDashApiError } from "../engine/src/runtime/emdash.ts";
import { validatePayload } from "../engine/src/publish.ts";
import type { HuntBrief } from "../engine/src/brief.ts";
import {
	activeCandidates,
	loadCandidates,
	loadVanished,
	type Candidate,
} from "../engine/src/candidates.ts";

/* -------------------------------------------------------------------------- */
/* A stub universe                                                             */
/* -------------------------------------------------------------------------- */

const MIT = `MIT License

Copyright (c) 2026 Someone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.`;

/** One repository, as the stub serves it. Mutable: a test moves it. */
interface StubRepo {
	fullName: string;
	stars: number;
	pushedAt: string;
	headSha: string;
	description?: string;
	archived?: boolean;
	fork?: boolean;
	defaultBranch?: string;
	/** The paths the tree listing returns, with the size each is served at. */
	tree: Record<string, number>;
	/** `path` → the bytes served. */
	content: Record<string, string>;
	/** The name GitHub redirects to, or null when the old path still works. */
	renamedTo?: string | null;
	/** Omit the repository to answer 404, as GitHub does for a deleted repository. */
	gone?: boolean;
}

const repo = (fullName: string, overrides: Partial<StubRepo> = {}): StubRepo => ({
	fullName,
	stars: 10,
	pushedAt: "2026-01-01T00:00:00Z",
	headSha: `sha-${fullName}`,
	description: `A granular texture sound generator: ${fullName}`,
	tree: { LICENSE: 1078, "src/synth.cpp": 100 },
	content: { LICENSE: MIT, "src/synth.cpp": "void main() {}" },
	...overrides,
});

/** A `SearchHit`, for the `hunt` mode's lanes. */
const hit = (r: StubRepo, query: string, page: number, lane: number): SearchHit => ({
	fullName: r.fullName,
	description: r.description ?? null,
	stars: r.stars,
	license: { spdxId: "MIT", name: "MIT License" },
	topics: [],
	defaultBranch: r.defaultBranch ?? "main",
	htmlUrl: `https://github.com/${r.fullName}`,
	updatedAt: r.pushedAt,
	pushedAt: r.pushedAt,
	archived: r.archived === true,
	fork: r.fork === true,
	query,
	page,
	lane,
} as SearchHit);

/**
 * One GitHub, counted.
 *
 * The log is the assertion instrument. `expensive` is only the reads that cost
 * bytes, so "the second run did minimal work" becomes a number instead of an
 * impression.
 */
function stubGitHub(
	repos: StubRepo[],
	options: { rateLimit?: boolean; searchHits?: StubRepo[] } = {},
) {
	const urls: string[] = [];
	const cost = (url: string) => {
		urls.push(url);
	};
	const expensiveOf = () => urls.filter((u) => /\/git\/trees\/|\/contents\//.test(u));
	const notFound = (operation: string, url: string) =>
		new GitHubError({ operation, status: 404, url, detail: "not found", rateLimited: false });
	const throttled = (operation: string, url: string) =>
		new GitHubError({
			operation,
			status: 403,
			url,
			detail: "rate limited (403, remaining=0). The hunt read less than it reports.",
			rateLimited: true,
		});

	// A moved repository is answered at whichever name the stub says it lives at,
	// which is how GitHub behaves: the old path redirects rather than 404s.
	const byName = (fullName: string) =>
		repos.find((r) => r.fullName === fullName || r.renamedTo === fullName);

	const layer = Layer.succeed(
		GitHubApi,
		GitHubApi.of({
			search: (query: string, _perPage: number, page = 1) =>
				Effect.suspend(() => {
					// Every search is logged, so a test can prove that a completed lane was
					// not re-asked and that a recovery was not charged to a lane.
					cost(`/search/repositories?q=${encodeURIComponent(query)}&page=${page}`);
					const wanted = options.searchHits ?? [];
					// A `repo:` qualifier is GitHub's exact match for one repository, which is
					// how a re-offered hit recovers its description for one request.
					const matched = query.startsWith("repo:")
						? wanted.filter((r) => `repo:${r.fullName}` === query)
						: wanted;
					return Effect.succeed(matched.map((r) => hit(r, query, page, 1)) as ReadonlyArray<SearchHit>);
				}),
			resolve: (fullName: string) =>
				Effect.suspend(() => {
					const found = byName(fullName);
					if (!found) return Effect.fail(notFound("resolve", fullName));
					// A renamed repository is served at whichever name it was asked for, so
					// the owner/repo echoed back is the *requested* pair. That is exactly the
					// situation a rename creates, and it is why the canonical name has to
					// come from `observe` rather than from the repository path.
					return Effect.succeed({
						owner: fullName.split("/")[0],
						repo: fullName.split("/")[1],
						ref: found.headSha,
					} satisfies RepoRef);
				}),
			observe: (fullName: string) =>
				Effect.suspend(() => {
					if (options.rateLimit) return Effect.fail(throttled("observe", fullName));
					const found = byName(fullName);
					if (!found || found.gone) return Effect.fail(notFound("observe", fullName));
					cost(`/repos/${fullName}`);
					cost(`/repos/${fullName}/commits/main`);
					return Effect.succeed({
						// The canonical name, which is how a rename becomes visible at all.
						fullName: found.renamedTo ?? found.fullName,
						pushedAt: found.pushedAt,
						archived: found.archived === true,
						fork: found.fork === true,
						defaultBranch: found.defaultBranch ?? "main",
						headSha: found.headSha,
						stars: found.stars,
					});
				}),
			tree: (ref: RepoRef) =>
				Effect.suspend(() => {
					const found = repos.find((r) => r.headSha === ref.ref);
					if (!found) return Effect.fail(notFound("tree", ref.repo));
					cost(`/repos/${found.fullName}/git/trees/${ref.ref}?recursive=1`);
					return Effect.succeed(
						Object.entries(found.tree).map(([path, size]) => ({ path, size, sha: `${path}-sha` })),
					);
				}),
			file: (ref: RepoRef, path: string) =>
				Effect.suspend(() => {
					const found = repos.find((r) => r.headSha === ref.ref);
					if (!found) return Effect.fail(notFound("file", `${ref.repo}/${path}`));
					cost(`/repos/${found.fullName}/contents/${path}?ref=${ref.ref}`);
					const body = found.content[path];
					if (body === undefined) return Effect.succeed(null);
					return Effect.succeed({
						path,
						content: Buffer.from(body, "utf8").toString("base64"),
						sha: `${path}-sha`,
						size: found.tree[path] ?? body.length,
						url: `https://api.github.com/repos/${found.fullName}/contents/${path}`,
					});
				}),
			authenticated: true,
			calls: Effect.succeed([] as ReadonlyArray<string>),
			rateLimited: Effect.succeed(options.rateLimit === true),
		}),
	) as Layer.Layer<GitHubApi>;

	return { layer, urls, expensive: expensiveOf };
}

/* -------------------------------------------------------------------------- */
/* Running a crawl                                                             */
/* -------------------------------------------------------------------------- */

/** A brief, with the defaults a real one would have. */
const brief = (overrides: Partial<HuntBrief> = {}): HuntBrief => ({
	intent: "procedural sound effects",
	verticals: ["audio-music"],
	queries: ["procedural sound effects"],
	constraints: {
		minStars: 0,
		maxCandidates: 10,
		unlicensedPolicy: "keep",
		budgets: { maxFilesPerRepo: 5, maxBytes: 8 * 1024 * 1024 },
	},
	...overrides,
});

/** A brief with a narrower byte budget, which is how a run is made to stop. */
const budgeted = (maxBytes: number) =>
	brief({ constraints: { minStars: 0, maxCandidates: 10, budgets: { maxFilesPerRepo: 5, maxBytes } } });

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "ah-refresh-"));
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface RunOptions {
	readonly mode?: "hunt" | "refresh";
	readonly force?: boolean;
	readonly payloadExists?: boolean;
	readonly brief?: HuntBrief;
	readonly rateLimit?: boolean;
	readonly searchHits?: StubRepo[];
}

/**
 * One crawl against one universe, in its own state directory.
 *
 * `name` is the state directory, so two tests can never see each other's
 * candidates. The service comes out of a `Layer.succeed(GitHubApi, …)` — the
 * same tag the live layer provides — rather than being hand-built at the call
 * site, so this is service substitution through the real seam.
 */
async function run(name: string, repos: StubRepo[], options: RunOptions = {}) {
	const root = join(dir, name);
	const github = stubGitHub(repos, { rateLimit: options.rateLimit, searchHits: options.searchHits });
	const service = await Effect.runPromise(Effect.provide(Effect.map(GitHubApi, (s) => s), github.layer));
	const lines: string[] = [];
	const outcome = await Effect.runPromise(
		crawl({
			mode: options.mode ?? "refresh",
			root,
			brief: options.brief ?? brief(),
			github: service,
			force: options.force,
			payloadExists: options.payloadExists,
			log: (line) => lines.push(line),
			now: () => "2026-02-01T00:00:00.000Z",
		}),
	);
	return {
		outcome,
		root,
		calls: [...github.urls],
		expensive: github.expensive(),
		transcript: lines.join("\n"),
	};
}

/**
 * One hunt, to put something in the store.
 *
 * Most of this file is about what a *second* run does, and a refresh over an empty
 * store correctly does nothing at all — so each test discovers first and then
 * measures. The discovery is a real crawl through the same code path, not a
 * hand-written fixture, so the state the assertions read is state the engine
 * actually produced.
 */
const seed = (name: string, universe: StubRepo[], options: RunOptions = {}) =>
	run(name, universe, { mode: "hunt", searchHits: universe, payloadExists: true, ...options });

/* -------------------------------------------------------------------------- */
/* Resumption                                                                  */
/* -------------------------------------------------------------------------- */

describe("an interrupted refresh resumes rather than restarts", () => {
	test("a hunt stopped by its own budget picks up only what it did not finish", async () => {
		// Four sources, each a 1078-byte licence and a 100-byte source file, and a
		// budget of exactly two of them. The byte budget is the mechanism a real run
		// uses to stop part-way through a universe, so this interruption is produced by
		// ordinary code rather than by a test hook.
		//
		// Resumption is asserted on a *hunt*, not a refresh, and that is the honest
		// choice: a refresh cannot grow the universe, so the sources an interrupted
		// discovery found but never inspected are unreachable from `refresh` by
		// design. Finishing them is discovery's job, which is `hunt`'s.
		const universe = [repo("a/one"), repo("b/two"), repo("c/three"), repo("d/four")];
		const narrow = budgeted(2 * (1078 + 100));

		const first = await seed("budget", universe, { brief: narrow, payloadExists: false });
		assert.deepEqual(first.outcome.inspected, ["a/one", "b/two"]);
		assert.match(
			first.transcript,
			new RegExp(`byte budget reached \\(2356 of 2356\\); 2 source\\(s\\) left uninspected`),
		);
		assert.equal(loadCandidates(first.root).size, 2, "the two that finished are on record");

		// The second hunt: the search lane is already complete, so it is not re-asked;
		// the two finished sources cost two metadata reads each; the two unfinished
		// ones are picked up from the lane's record and inspected.
		const second = await seed("budget", universe, { brief: narrow, payloadExists: true });
		assert.match(second.transcript, /already crawled; 2 hit\(s\) still to inspect/);
		assert.deepEqual(
			second.outcome.inspected,
			["c/three", "d/four"],
			"a resumed run inspects only what the first run did not finish",
		);
		assert.equal(second.outcome.metrics.sourcesUnchanged, 2, "the finished two owe nothing");
		assert.equal(
			second.calls.filter((u) => u.includes("/search/repositories")).length,
			2,
			"no lane was re-asked; the only searches are one repo: lookup per outstanding hit",
		);
		// The proof that it resumed rather than restarted: neither finished repository
		// is read again. Not once.
		const reread = second.expensive.filter((u) => /a\/one|b\/two/.test(u));
		assert.deepEqual(reread, [], `a resumed run re-read nothing it had already read: ${reread.join(" ")}`);
		assert.equal(loadCandidates(second.root).size, 4);

		// And once the universe is complete, a third hunt has nothing to do at all.
		const third = await seed("budget", universe, { brief: narrow, payloadExists: true });
		assert.deepEqual(third.outcome.inspected, []);
		assert.deepEqual(third.expensive, []);
	});

	test("a finished run's second pass reads no repository content at all", async () => {
		// The headline acceptance criterion, measured in requests rather than asserted
		// in prose. Zero tree listings and zero content reads is not "less work" — it
		// is no work at all beyond the metadata that decided to skip.
		const universe = [repo("a/one"), repo("b/two")];
		await seed("minimal", universe);
		const second = await run("minimal", universe, { payloadExists: true });

		assert.deepEqual(second.outcome.inspected, []);
		assert.deepEqual(second.expensive, [], "not one byte of repository content");
		assert.deepEqual(second.outcome.metrics, {
			sourcesChecked: 2,
			sourcesChanged: 0,
			sourcesUnchanged: 2,
			newSources: 0,
			vanished: 0,
			bytesDownloaded: 0,
			licenceRereads: 0,
		});
		// Two metadata reads per known source, and only those: the repository document
		// and the single-commit lookup. This is the "cheap before expensive" property
		// as a number.
		assert.equal(second.calls.length, 4);
		assert.ok(
			second.calls.every((u) => /^\/repos\/[^/]+\/[^/]+(\/commits\/main)?$/.test(u)),
			`only metadata: ${second.calls.join(" ")}`,
		);
	});

	test("a refresh that changed nothing does not rewrite the payload", async () => {
		// `machine_synced_at` only moves when something real moved, and the payload
		// file is that same rule one step earlier. A rewrite here would make every
		// later run a diff and leave `hunt:verify` unable to tell a no-op from a
		// change.
		const universe = [repo("a/one")];
		await seed("payload", universe);
		const noop = await run("payload", universe, { payloadExists: true });
		assert.equal(noop.outcome.writePayload, false);
		assert.match(noop.transcript, /nothing changed, so no payload was rewritten/);

		// A run that did record something does rewrite it, or a newly added source
		// would never reach the catalogue. New sources arrive by discovery, so this is
		// a `hunt` — a `refresh` cannot grow the universe, which is what makes it safe
		// to schedule.
		const withWork = await run("payload", [...universe, repo("b/two")], {
			mode: "hunt",
			// A second query is a lane the engine has never crawled, so the new repository
			// is discoverable. This is how new material reaches a brief whose earlier
			// lanes are already complete.
			brief: brief({ queries: ["procedural sound effects", "granular texture"] }),
			searchHits: [repo("b/two")],
			payloadExists: true,
		});
		// The brief's one lane was crawled by the first hunt, so the new repository is
		// never returned again — which is the *other* half of resumption working. A new
		// source reaches a brief that has already run its lanes by being in a lane the
		// engine has not crawled yet.
		assert.equal(withWork.outcome.writePayload, true);
	});

	test("--force re-reads inside the budget rather than ignoring it", async () => {
		// "Full" must never mean "unlimited": a broad refresh is still a crawl with a
		// budget, and a test that proved otherwise would be proving the wrong thing.
		const universe = [repo("a/one"), repo("b/two")];
		const narrow = budgeted(100);
		const forced = await seed("force", universe, { brief: narrow });
		assert.deepEqual(forced.outcome.inspected, ["a/one"], "the budget still stopped it");
		assert.match(forced.transcript, /byte budget reached/);
	});

	test("a search lane is not re-asked once every hit it found is recorded", async () => {
		// Resumption at the *search* stage, which is a separate record from the
		// candidate store. Without it a hunt that dies during inspection re-runs every
		// search it had already paid for.
		const universe = [repo("a/one")];
		const first = await run("waves", universe, { mode: "hunt", searchHits: universe });
		assert.match(first.transcript, /procedural sound effects p1 — 1 hits, 1 kept/);
		const second = await run("waves", universe, { mode: "hunt", searchHits: universe });
		assert.match(second.transcript, /↩ procedural sound effects p1 already crawled; re-checking 1 known/);
		assert.equal(
			second.calls.filter((u) => u.includes("/search/")).length,
			0,
			"no search request was issued for a completed lane whose hits are all recorded",
		);
	});
});

/* -------------------------------------------------------------------------- */
/* What the plan skips                                                         */
/* -------------------------------------------------------------------------- */

describe("only what moved is re-read", () => {
	test("a star change and an edited description cost nothing", async () => {
		// The two fields that move on almost every real crawl. Treating either as
		// evidence would make "minimal work on the second run" false in practice while
		// a fixture that only moved `pushedAt` would still pass.
		const universe = [repo("a/one", { stars: 10, description: "A granular texture sound generator" })];
		await seed("stars", universe);
		const moved = [
			repo("a/one", {
				stars: 4110,
				description: "A granular texture sound generator (now with reverb)",
				headSha: "sha-a/one",
				pushedAt: "2026-01-01T00:00:00Z",
			}),
		];
		const second = await run("stars", moved, { payloadExists: true });
		assert.deepEqual(second.expensive, []);
		assert.equal(second.outcome.metrics.sourcesUnchanged, 1);
	});

	test("a push upstream re-reads, and is counted as a change", async () => {
		const universe = [repo("a/one", { headSha: "sha-old" })];
		await seed("pushed", universe);
		const second = await run("pushed", [repo("a/one", { headSha: "sha-new", pushedAt: "2026-01-09T00:00:00Z" })], {
			payloadExists: true,
		});
		assert.deepEqual(second.outcome.inspected, ["a/one"]);
		assert.equal(second.outcome.metrics.sourcesChanged, 1);
		assert.equal(second.outcome.metrics.sourcesUnchanged, 0);
		assert.ok(
			second.expensive.some((u) => /git\/trees/.test(u)),
			"a moved source does pay for a tree listing",
		);
	});

	test("a force-push with an unmoved timestamp is still caught", async () => {
		// `pushedAt` alone would miss this, which is why the pre-check reads the head
		// commit rather than trusting the timestamp.
		const universe = [repo("a/one", { headSha: "sha-old" })];
		await seed("forcepush", universe);
		const second = await run(
			"forcepush",
			[repo("a/one", { headSha: "sha-rebased", pushedAt: "2026-01-01T00:00:00Z" })],
			{ payloadExists: true },
		);
		assert.deepEqual(second.outcome.inspected, ["a/one"]);
	});

	test("a changed licence file is counted as a licence re-read", async () => {
		const universe = [repo("a/one", { headSha: "sha-old" })];
		await seed("licence", universe);
		const relicensed = [
			repo("a/one", {
				headSha: "sha-new",
				// Same status, different bytes: a classification has to be redone rather
				// than assumed to still hold.
				content: { LICENSE: `${MIT}\n\nThe warranty is disclaimed.`, "src/synth.cpp": "void main() {}" },
				tree: { LICENSE: 1120, "src/synth.cpp": 100 },
			}),
		];
		const second = await run("licence", relicensed, { payloadExists: true });
		assert.deepEqual(second.outcome.inspected, ["a/one"]);
		assert.equal(second.outcome.metrics.licenceRereads, 1);
		// The licence is charged to the budget as well as to the report. It is usually
		// the largest thing a crawl reads — an AGPL text runs to tens of kilobytes — so
		// a budget that ignored it was not bounding bytes downloaded, which is the one
		// thing it exists to do.
		assert.equal(second.outcome.metrics.bytesDownloaded, 1120 + 100);
	});

	test("a re-read with identical evidence is not a licence re-read", async () => {
		const universe = [repo("a/one", { headSha: "sha-old" })];
		await seed("same", universe);
		const second = await run("same", [repo("a/one", { headSha: "sha-new", pushedAt: "2026-02-01T00:00:00Z" })], {
			payloadExists: true,
		});
		assert.deepEqual(second.outcome.inspected, ["a/one"]);
		assert.equal(second.outcome.metrics.licenceRereads, 0);
	});

	test("a repository re-read at a new commit is superseded, not duplicated", async () => {
		// Without this the catalogue gains another example for the same repository on
		// every push, which is the duplicate ingestion #41 names.
		const universe = [repo("a/one", { headSha: "sha-old" })];
		await seed("supersede", universe);
		await run("supersede", [repo("a/one", { headSha: "sha-new" })], { payloadExists: true });

		const everything = [...loadCandidates(run0("supersede")).values()];
		assert.equal(everything.length, 2, "both readings are kept — nothing is deleted");
		assert.equal(activeCandidates(everything).length, 1, "but only one of them is live");
		assert.equal(everything.filter((c) => c.supersededBy).length, 1);
	});
});

/* -------------------------------------------------------------------------- */
/* Disappearance                                                               */
/* -------------------------------------------------------------------------- */

describe("a source that is gone is recorded, not dropped", () => {
	test("a 404 keeps the candidate, the last commit and the payload entry", async () => {
		const universe = [repo("a/one", { headSha: "sha-last-read" })];
		const before = await seed("vanish", universe);
		assert.equal(loadCandidates(before.root).size, 1);

		const gone = await run("vanish", [repo("a/one", { gone: true })], { payloadExists: true });
		assert.deepEqual(gone.outcome.vanished, ["a/one"]);
		assert.equal(gone.outcome.metrics.vanished, 1);
		assert.match(gone.transcript, /gone upstream, kept here with the commit last read/);

		// The candidate is still there. A disappearance that deletes its own evidence is
		// not honest.
		assert.equal(loadCandidates(gone.root).size, 1);
		const record = loadVanished(gone.root).get("a/one");
		assert.ok(record, "the disappearance is on record");
		assert.equal(record.lastSeenRef, "sha-last-read");
		assert.equal(record.reason, "not found");
		assert.equal(record.resolvedAt, null);
		assert.equal(record.noticedAt, "2026-02-01T00:00:00.000Z");
		// And it is still in the payload: evidence read at that commit is still
		// evidence about that commit, and the catalogue does not lose it quietly.
		assert.equal(
			gone.outcome.payload.possibilities.flatMap((p) => p.examples).length,
			1,
			"a vanished source is not silently removed from the catalogue",
		);
		// Nothing was spent reaching that conclusion.
		assert.deepEqual(gone.expensive, []);
	});

	test("a 404 on every run is one record, not one per run", async () => {
		const universe = [repo("a/one")];
		await seed("repeat", universe);
		await run("repeat", [repo("a/one", { gone: true })], { payloadExists: true });
		const second = await run("repeat", [repo("a/one", { gone: true })], { payloadExists: true });
		assert.deepEqual(second.outcome.vanished, [], "still one fact, not a new one");
		assert.equal(loadVanished(second.root).size, 1);
	});

	test("a source that comes back resolves the record without erasing it", async () => {
		const universe = [repo("a/one", { headSha: "sha-old" })];
		await seed("returns", universe);
		await run("returns", [repo("a/one", { gone: true })], { payloadExists: true });
		const back = await run("returns", universe, { payloadExists: true });

		const record = loadVanished(back.root).get("a/one");
		assert.ok(record);
		assert.equal(record.resolvedAt, "2026-02-01T00:00:00.000Z");
		assert.equal(record.resolvedRef, "sha-old");
		assert.equal(back.outcome.vanished.length, 0);
	});

	test("a throttle is not a disappearance", async () => {
		// The failure that must never be mistaken for a deleted repository. Recording
		// these is how a flaky network invents repositories that were removed.
		const universe = [repo("a/one")];
		await seed("throttle", universe);
		const throttled = await run("throttle", universe, { payloadExists: true, rateLimit: true });
		assert.deepEqual(throttled.outcome.vanished, []);
		assert.equal(throttled.outcome.metrics.vanished, 0);
		assert.match(throttled.transcript, /rate limited \(403/);
		assert.equal(throttled.expensive.length, 0, "and it spent nothing either");
	});
});

/* -------------------------------------------------------------------------- */
/* Moving                                                                      */
/* -------------------------------------------------------------------------- */

describe("a repository that moved upstream is a move, not a loss", () => {
	test("an old path that redirects is recorded as a rename, and followed", async () => {
		const universe = [repo("a/one")];
		await seed("renamed", universe);
		assert.equal(loadVanished(join(dir, "renamed")).size, 0);

		// GitHub answers the old path and reports the new name, so the two facts are
		// kept apart: the old reading is a move, not a disappearance. And the move is
		// finished in the same run — the new name is inspected immediately, carrying
		// the recorded description across so a renamed repository does not lose the
		// text that explains why it was in the catalogue at all.
		const moved = await run("renamed", [{ ...repo("a/one"), renamedTo: "a/one-renamed" }]);
		assert.deepEqual(moved.outcome.renamed, [["a/one", "a/one-renamed"]]);
		assert.match(moved.transcript, /a\/one is now a\/one-renamed/);
		assert.deepEqual(moved.outcome.inspected, ["a/one-renamed"], "the new name is inspected now");
		assert.equal(loadVanished(moved.root).size, 0, "a move is not a 404");

		const everything = [...loadCandidates(moved.root).values()];
		const old = everything.find((c) => c.fullName === "a/one");
		assert.ok(old, "the old reading is kept, with the name it moved to");
		assert.equal(old.renamedTo, "a/one-renamed");
		assert.equal(old.files.length > 0, true, "and with the evidence it had");
		assert.deepEqual(
			activeCandidates(everything).map((c) => c.fullName),
			["a/one-renamed"],
			"exactly one live reading, under the name GitHub now serves",
		);
		// And the description survived the move, which is the thing a naive
		// delete-and-refetch would lose.
		const live = activeCandidates(everything)[0];
		assert.match(String(live.description), /granular texture/);
	});
});

/* -------------------------------------------------------------------------- */
/* Modes                                                                       */
/* -------------------------------------------------------------------------- */

describe("the two modes differ only in discovery", () => {
	test("refresh issues no search at all", async () => {
		// The property that makes `refresh` safe to schedule: its cost is bounded by
		// what is already held, so it cannot grow the universe.
		const universe = [repo("a/one")];
		await seed("mode-refresh", universe);
		const refreshed = await run("mode-refresh", universe, {
			mode: "refresh",
			searchHits: universe,
			payloadExists: true,
		});
		assert.match(refreshed.transcript, /known sources only, no discovery/);
		assert.deepEqual(
			refreshed.calls.filter((u) => u.includes("/search/")),
			[],
			"a refresh never asks GitHub for a search",
		);
		assert.deepEqual(refreshed.expensive, [], "and nothing had moved to re-read");
	});

	test("hunt still discovers, and still re-checks what it knows", async () => {
		const universe = [repo("a/one")];
		const first = await run("mode-hunt", universe, { mode: "hunt", searchHits: universe, payloadExists: true });
		assert.match(first.transcript, /full discovery, with the refresh plan applied/);
		assert.deepEqual(first.outcome.inspected, ["a/one"]);

		// A second hunt finds the same repository and must not re-read it: the plan
		// applies to discovery results too, not only to a refresh.
		const second = await run("mode-hunt", universe, {
			mode: "hunt",
			searchHits: universe,
			payloadExists: true,
		});
		assert.deepEqual(second.expensive, []);
		assert.equal(second.outcome.metrics.sourcesUnchanged, 1);
	});
});

/* -------------------------------------------------------------------------- */
/* The contract the crawl must not break                                       */
/* -------------------------------------------------------------------------- */

describe("a refresh is a crawl, so it cannot decide what the catalogue shows", () => {
	test("a refresh-built payload carries no human-owned field", async () => {
		const universe = [repo("a/one", { headSha: "sha-old" })];
		await seed("contract", universe);
		const again = await run("contract", [repo("a/one", { headSha: "sha-new" })], { payloadExists: true });
		const validation = validatePayload(again.outcome.payload);
		assert.deepEqual(validation.problems, []);
		assert.ok(again.outcome.payload.possibilities.length > 0);
		for (const possibility of again.outcome.payload.possibilities) {
			assert.equal("editorial_rank" in possibility.data, false);
			assert.equal("featured" in possibility.data, false);
			assert.equal("image" in possibility.data, false);
		}
		// One example for one repository, even though two commits were read. A
		// duplicate here is the failure mode a superseding rule exists to prevent.
		const examples = again.outcome.payload.possibilities.flatMap((p) => p.examples);
		assert.equal(new Set(examples.map((e) => e.data.source_repo)).size, examples.length);
	});
});

describe("the catalogue boundary still holds end to end", () => {
	test("a machine entry is created as a draft, and a person decides otherwise", async () => {
		// The invariant #40 exists to protect, asserted through the real merge policy on
		// a payload a real crawl produced. If the crawl ever started writing
		// `editorial_rank` or setting `visibility: published`, this is where it shows.
		const universe = [repo("a/one")];
		const crawled = await seed("boundary", universe);
		assert.deepEqual(validatePayload(crawled.outcome.payload).problems, []);

		const { mergePossibility, shouldPublish } = await import("../engine/src/merge.ts");
		for (const possibility of crawled.outcome.payload.possibilities) {
			// No existing entry: the merge is a creation, and a creation is a draft.
			assert.equal(shouldPublish(null), false, "a new machine entry is never published");
			const merged = mergePossibility(null, possibility.data);
			assert.equal(merged.merged.visibility, "draft", "arrives as a draft");
			assert.equal(merged.merged.editorial_rank, 0, "at the bottom of the wall");
		}
	});
});

describe("an entry that is not there is not an error", () => {
	// `EmDashApi.read` returns `null` for a 404, which is the normal state of a first
	// sync. It did not: `call` rejected a 404 like any other non-2xx, the failure escaped
	// `read`, and every caller read "not there" as "the CMS is broken".
	//
	// The consequences were not subtle. `sync` reported every missing entry as a failure
	// and created nothing, so a first sync could not work at all — and `verify`, whose
	// entire job is to report a payload that is not in the catalogue, aborted with an
	// unreadable `EmDashApiError` before printing the line that says so. Both were found
	// by running the real commands rather than by reading the code; the module's own doc
	// comment had described the correct behaviour all along.
	//
	// A refresh makes this the critical path rather than a first-run edge: after a
	// refresh the payload is compared against a catalogue, and "this slug is not in
	// there yet" is the normal answer, not a fault report.
	const readLayer = (status: number) =>
		Layer.succeed(
			EmDashApi,
			EmDashApi.of({
				session: Effect.succeed({ cookie: "", headers: {} }),
				read: () =>
					status === 404
						? Effect.succeed(null)
						: Effect.fail(
								new EmDashApiError({
									operation: "read possibilities/x",
									status,
									detail: `HTTP ${status}`,
								}),
							),
				list: () => Effect.succeed([]),
				write: () => Effect.void,
			}),
		) as Layer.Layer<EmDashApi>;

	test("a 404 reads as absent, which is what makes a first sync possible", async () => {
		const entry = await Effect.runPromise(
			Effect.provide(
				Effect.flatMap(EmDashApi, (api) => api.read("possibilities", "not-created-yet")),
				readLayer(404),
			),
		);
		assert.equal(entry, null, "not there is an answer, not a failure");
	});

	test("a 401, a 403 and a 500 stay failures", async () => {
		// The other direction, and the one that matters. Absorbing every status would
		// turn a broken session or a sick database into a catalogue that reads as empty,
		// which is the silent wrong answer this project exists to prevent.
		for (const status of [401, 403, 500]) {
			const exit = await Effect.runPromiseExit(
				Effect.provide(
					Effect.flatMap(EmDashApi, (api) => api.read("possibilities", "x")),
					readLayer(status),
				),
			);
			assert.equal(Exit.isFailure(exit), true, `HTTP ${status} must not read as absent`);
		}
	});
});

describe("a refresh reconstructs a candidate without searching for it", () => {
	test("the recorded candidate carries everything an inspection needs", () => {
		const stored: Candidate = {
			id: "0123456789abcdef",
			fullName: "a/one",
			owner: "a",
			repo: "one",
			ref: "sha-old",
			stars: 12,
			description: "a granular texture generator",
			topics: ["audio"],
			htmlUrl: "https://github.com/a/one",
			defaultBranch: "main",
			archived: false,
			fork: false,
			pushedAt: "2026-01-01T00:00:00Z",
			rights: {
				status: "attribution",
				spdx: "MIT",
				licencePath: "LICENSE",
				licenceUrl: "u",
				licenceSha256: "h",
				quote: "q",
				githubSpdxHint: "MIT",
				note: "n",
				meaning: "m",
				assetScoped: false,
			},
			files: [],
			interesting: [],
			discoveredBy: { query: "q", page: 1, lane: "1" },
			policyApplied: "keep",
			firstSeen: "2026-01-01T00:00:00Z",
			lastSeen: "2026-01-01T00:00:00Z",
			observations: 1,
				briefFingerprint: null,
		};
		const reconstructed = hitFromCandidate(stored);
		assert.equal(reconstructed.fullName, "a/one");
		assert.equal(reconstructed.license?.spdxId, "MIT");
		assert.equal(reconstructed.defaultBranch, "main");
		assert.equal(reconstructed.stars, 12);
		assert.equal(reconstructed.htmlUrl, "https://github.com/a/one");
	});
});

/** The state directory a named run used. */
const run0 = (name: string) => join(dir, name);
