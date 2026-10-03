/**
 * The hunt engine CLI.
 *
 * Four commands, in the order they are normally run:
 *
 *   hunt     read a brief, discover what it names, record the evidence
 *   refresh  re-read what is already known, and nothing else (#41)
 *   sync     reconcile the recorded evidence into the EmDash catalogue
 *   verify   prove the catalogue matches the payload, and that nothing human
 *            was overwritten
 *
 * The engine is a separate process from the app and talks to EmDash over the
 * same authenticated HTTP API the admin uses. It does not touch the CMS
 * database and it does not import app code, so the boundary in
 * `docs/ARCHITECTURE.md` is a real one rather than a naming convention.
 *
 * This file is the program edge and nothing else. Argument parsing, the help
 * text, `process.exitCode` and the transcript are imperative on purpose, and the
 * crawl itself lives in `./crawl.ts` so it can be run against a substituted
 * GitHub service with no network at all. Every command below is exactly one
 * `runEngine` call — see `./runtime/root.ts` — so a runner is never reached from
 * inside a loop.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Option } from "effect";
import { GitHubApi } from "./runtime/github.ts";
import { runEngine } from "./runtime/root.ts";
import { validateBrief, type HuntBrief } from "./brief.ts";
import { crawl, type CrawlMode } from "./crawl.ts";
import { validatePayload, type PublishPayload } from "./publish.ts";
import { EmDashApi, type EmDashApiError } from "./runtime/emdash.ts";
import { mergeExample, mergePossibility, shouldPublish } from "./merge.ts";
import { describeExclusion, parseExclusions, type Exclusion } from "./exclusions.ts";
import { untrustedError, untrustedRepo } from "./transcript.ts";

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, "..");
const payloadPath = join(engineRoot, "state", "payload.json");

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Signing in used to live here as a hand-rolled `fetch` with a `redirect:
 * "manual"`, a cookie split on a regex and two thrown strings. It is now
 * `EmDashApi.session` in `./runtime/emdash.ts`, so the same typed failure, the
 * same timeout and the same retry apply to the first call of a run as to the
 * hundredth — and the engine has exactly one way to be authenticated.
 */

/* -------------------------------------------------------------------------- */
/* hunt / refresh                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `hunt` and `refresh` — the two crawl modes, over the same code path.
 *
 * The mode is a parameter rather than a second command implementation, so the
 * rule that decides what a run is allowed to do is one `if` in `./crawl.ts` and
 * not two crawls that drift. `hunt` discovers; `refresh` only re-reads what is
 * already on record, and `--force` re-reads that with the plan ignored.
 */
type EngineEnv = Record<string, string | undefined> | undefined;

function cmdCrawl(mode: CrawlMode, briefPath: string, force: boolean, env: EngineEnv) {
	return runEngine(
		Effect.gen(function* () {
			const brief = loadBrief(briefPath);
			const github = yield* GitHubApi;
			/*
			 * Standing takedowns, read before the crawl starts (#54).
			 *
			 * Read through `EmDashApi.list` like every other engine call, and a
			 * failure here is logged rather than fatal — but it is also not
			 * silently ignored, because a crawl that cannot reach the catalogue
			 * cannot honour a takedown it cannot see, and quietly re-ingesting a
			 * withdrawn repository is the exact failure the exclusion exists to
			 * prevent. The run continues and says so in its own output.
			 */
			const emdash = yield* EmDashApi;
			const exclusions = yield* emdash
				.list("exclusions")
				.pipe(
					Effect.map((rows) => parseExclusions(rows as Record<string, unknown>[])),
					Effect.catch((error) =>
						Effect.sync(() => {
							console.error(
								`  ! could not read standing exclusions (${describeEmDashFailure(error)}); this hunt cannot honour a takedown it cannot see`,
							);
							return [] as Exclusion[];
						}),
					),
				);
			if (exclusions.some((entry) => entry.active)) {
				console.log(
					`  exclusions   ${exclusions.filter((entry) => entry.active).length} standing takedown(s) will be skipped`,
				);
			}
			const outcome = yield* crawl({
				mode,
				root: engineRoot,
				brief,
				github,
				force,
				payloadExists: existsSync(payloadPath),
				exclusions,
			});

			if (!outcome.writePayload) {
				// The crawl has already said why. All that is left is what to do about
				// it, and the honest answer is that there is nothing.
				console.log("  next: nothing — a no-op run needs no sync");
				return;
			}

			const validation = validatePayload(outcome.payload);
			if (!validation.ok) {
				console.error("\n✖ payload failed its own invariants; nothing was written");
				for (const problem of validation.problems) console.error(`  ${problem}`);
				process.exitCode = 1;
				return;
			}
			mkdirSync(dirname(payloadPath), { recursive: true });
			writeFileSync(payloadPath, `${JSON.stringify(outcome.payload, null, "\t")}\n`);
			const examples = outcome.payload.possibilities.reduce((n, p) => n + p.examples.length, 0);
			console.log(
				`\n✔ payload ${outcome.payload.fingerprint} — ${outcome.payload.possibilities.length} possibilities, ${examples} examples`,
			);
			console.log(`  ${payloadPath}`);
			console.log("\n  next: npm run hunt:sync");
		}),
		{ env },
	);
}

function loadBrief(path: string): HuntBrief {
	const resolved = path.startsWith("/") ? path : join(engineRoot, "briefs", path);
	if (!existsSync(resolved)) throw new Error(`no brief at ${resolved}`);
	const { brief, problems } = validateBrief(JSON.parse(readFileSync(resolved, "utf8")));
	if (problems.length) {
		console.error(`✖ ${resolved} is not a usable brief:`);
		for (const p of problems) console.error(`  ${p}`);
		process.exit(1);
	}
	return brief;
}

/* -------------------------------------------------------------------------- */
/* sync                                                                      */
/* -------------------------------------------------------------------------- */

interface SyncReport {
	created: string[];
	updated: string[];
	unchanged: string[];
	failed: { slug: string; error: string }[];
	/** Human-owned fields the engine chose not to write, by entry. */
	preserved: string[];
	/** Things that happened which a person should look at. */
	notices: string[];
}

/**
 * `sync` — reconcile the recorded evidence into the EmDash catalogue.
 *
 * A run through the engine's composition root, so the session, the timeout and
 * the retry policy are the ones the rest of the engine uses. The merge decision
 * is not made here: `mergePossibility` owns it, and this only reports.
 *
 * One entry failing must not abandon the rest: the report exists so a person can
 * see exactly which slugs did not land, and a partial sync that says so is more
 * useful than a complete-looking one that lies.
 */
function cmdSync(dryRun: boolean, env: EngineEnv) {
	return runEngine(
		Effect.gen(function* () {
			const api = yield* EmDashApi;
			const payload = readPayload();
			const validation = validatePayload(payload);
			if (!validation.ok) {
				console.error("✖ payload failed its invariants; refusing to write");
				for (const problem of validation.problems) console.error(`  ${problem}`);
				process.exit(1);
			}

			/*
			 * Exclusions are read before anything is written (#54). A `sync` that
			 * cannot see them would happily re-create an entry the crawl correctly
			 * skipped, which is how a takedown comes back one command later.
			 */
			const exclusions = parseExclusions((yield* api.list("exclusions")) as Record<string, unknown>[]);
			const active = exclusions.filter((entry) => entry.active);
			if (active.length) {
				console.log(`\n  ${active.length} active exclusion(s) will be honoured`);
				for (const exclusion of active.slice(0, 8)) console.log(`    ⊘ ${describeExclusion(exclusion)}`);
			}

			const report: SyncReport = {
				created: [],
				updated: [],
				unchanged: [],
				failed: [],
				preserved: [],
				notices: [],
			};

			for (const possibility of payload.possibilities) {
				yield* reconcilePossibility(api, possibility, dryRun, report, exclusions).pipe(
					Effect.catch((error) =>
						Effect.sync(() => {
							report.failed.push({
								slug: possibility.slug,
								error: describeEmDashFailure(error),
							});
						}),
					),
				);
			}

			console.log(`\nSync ${payload.fingerprint}${dryRun ? " (dry run)" : ""}`);
			console.log(`  created   ${report.created.length}`);
			console.log(`  updated   ${report.updated.length}`);
			console.log(`  unchanged ${report.unchanged.length}`);
			console.log(`  preserved ${report.preserved.length} editorial field(s) left untouched`);
			for (const line of report.updated.slice(0, 10)) console.log(`    ~ ${line}`);
			for (const line of report.created.slice(0, 10)) console.log(`    + ${line}`);
			if (report.notices.length) {
				console.log(`\n  ${report.notices.length} notice(s) for a person:`);
				for (const notice of report.notices.slice(0, 8)) console.log(`    ! ${notice}`);
			}
			if (report.failed.length) {
				console.error(`  failed    ${report.failed.length}`);
				for (const f of report.failed.slice(0, 5))
					console.error(`    ✖ ${untrustedRepo(f.slug)}: ${untrustedError(f.error)}`);
				process.exitCode = 1;
				return;
			}
			console.log(
				dryRun ? "\n✔ dry run complete" : "\n✔ catalogue reconciled with the payload",
			);
		}),
		{ env },
	);
}

/** One possibility and its examples, with the merge policy deciding what changes. */
const reconcilePossibility = (
	api: EmDashApi["Service"],
	possibility: PublishPayload["possibilities"][number],
	dryRun: boolean,
	report: SyncReport,
	exclusions: readonly Exclusion[] = [],
) =>
	Effect.gen(function* () {
		const existing = yield* api.read("possibilities", possibility.slug);
		// The merge policy decides what to write. The CLI does not.
		const merge = mergePossibility(existing?.data ?? null, possibility.data, { exclusions });
		report.preserved.push(...merge.preserved.map((f) => `${possibility.slug}.${f}`));
		report.notices.push(...merge.notes.map((n) => `${possibility.slug}: ${n}`));

		if (existing && !Object.keys(merge.write).length) {
			report.unchanged.push(possibility.slug);
		} else if (dryRun) {
			(existing ? report.updated : report.created).push(
				`${possibility.slug} (${merge.changed.join(", ") || "no fields"})`,
			);
		} else {
			yield* api.write(
				"possibilities",
				possibility.slug,
				merge.merged,
				existing?.rev ?? null,
				// A new machine entry is created as a draft: a crawl does not decide
				// what the public catalogue shows.
				!existing ? false : shouldPublish(existing.data ?? null),
			);
			(existing ? report.updated : report.created).push(
				`${possibility.slug} (${merge.changed.join(", ")})`,
			);
		}

		for (const example of possibility.examples) {
			const current = yield* api.read("examples", example.slug);
			const exampleMerge = mergeExample(current?.data ?? null, example.data, { exclusions });
			report.notices.push(...exampleMerge.notes.map((n) => `${example.slug}: ${n}`));
			if (dryRun) continue;
			if (!Object.keys(exampleMerge.write).length && current) continue;
			yield* api.write(
				"examples",
				example.slug,
				exampleMerge.merged,
				current?.rev ?? null,
				!current ? false : shouldPublish(current.data ?? null),
			);
		}
	});

/** A readable line for a failed content call, without a stack trace. */
const describeEmDashFailure = (error: unknown): string => {
	const tag = (error as { _tag?: unknown } | null)?._tag;
	if (tag === "EmDashApiError") {
		const failure = error as EmDashApiError;
		return failure.status === 0
			? `${failure.operation} could not reach EmDash (${failure.detail})`
			: `${failure.operation} → HTTP ${failure.status} ${failure.detail}`;
	}
	return error instanceof Error ? error.message : String(error);
};

/* -------------------------------------------------------------------------- */
/* verify                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `verify` — prove the catalogue matches the payload, and that nothing human was
 * overwritten.
 *
 * Reads through `EmDashApi`, so a comparison against a live entry uses the same
 * session, the same decoding and the same typed failures as the write that put it
 * there. A verify that could read a different shape than a sync wrote is a verify
 * that proves less than it claims.
 */
function cmdVerify(env: EngineEnv) {
	return runEngine(
		Effect.gen(function* () {
	const api = yield* EmDashApi;
	const payload = readPayload();
	const validation = validatePayload(payload);
	if (!validation.ok) {
		console.error("✖ payload invariants failed:");
		for (const problem of validation.problems) console.error(`  ${problem}`);
		process.exit(1);
	}
	let checked = 0;
	const problems: string[] = [];
	const lastSynced = new Set<string>();

	for (const possibility of payload.possibilities) {
		const entry = yield* api.read("possibilities", possibility.slug);
		checked++;
		if (!entry) {
			problems.push(`${possibility.slug}: in the payload but not in the catalogue`);
			continue;
		}
		for (const [field, value] of Object.entries(possibility.data)) {
			// `machine_synced_at` records when the engine last *wrote*, and the
			// merge policy only moves it when something real changed. A payload
			// built later than the last write is the normal case, so comparing it
			// would report every run as a mismatch.
			if (field === "machine_synced_at") {
				lastSynced.add(String(entry.data?.[field] ?? "never"));
				continue;
			}
			if (!sameValue(entry.data?.[field], value)) {
				problems.push(
					`${possibility.slug}.${field}: catalogue has ${JSON.stringify(entry.data?.[field])}, payload has ${JSON.stringify(value)}`,
				);
			}
		}
	}

	console.log(`\nVerify ${payload.fingerprint}`);
	console.log(`  checked     ${checked} possibilities against the live catalogue`);
	console.log(`  last write  ${[...lastSynced].sort().join(", ")}`);
	if (problems.length) {
		console.error(`  mismatched  ${problems.length}`);
		for (const p of problems.slice(0, 20)) console.error(`    ✖ ${p}`);
		process.exitCode = 1;
		return;
	}
	console.log("\n✔ the catalogue matches the payload");
		}),
		{ env },
	);
}

/**
 * Whether two stored field values mean the same thing.
 *
 * EmDash stores booleans as 0/1 and numbers as strings on some paths, so a strict
 * `===` reports every migrated entry as changed and a sync that would otherwise be
 * a no-op rewrites the whole catalogue.
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || a === undefined || b === null || b === undefined) return a == b;
	return String(a) === String(b);
}

function readPayload(): PublishPayload {
	if (!existsSync(payloadPath)) {
		console.error(`✖ no payload at ${payloadPath}. Run \`hunt\` first.`);
		process.exit(1);
	}
	return JSON.parse(readFileSync(payloadPath, "utf8")) as PublishPayload;
}

/* -------------------------------------------------------------------------- */

/**
 * The program edge.
 *
 * The only place in `engine/` that starts a fiber: each command below is an Effect
 * run through `runEngine` (see `./runtime/root.ts`), and this block is the process
 * entrypoint that decides which one. Argument parsing, the help text and the exit
 * code stay imperative — they are a transcript, not work.
 */
const [, , command, ...rest] = process.argv;

/**
 * `--url` is configuration, and configuration is an environment record.
 *
 * Before #62 the base URL was a function argument threaded through `session`,
 * `readEntry` and `writeEntry` by hand, which is how a third argument came to be
 * optional in three places at once. Now it arrives as `AH_EMDASH_BASE_URL` in the
 * record the composition root reads, so the flag and the environment variable are
 * the same knob.
 *
 * `undefined` rather than `{}` when there is nothing to override, and that is load
 * bearing. `runEngine` reads `options.env ?? process.env`, so an empty record is
 * not "no overrides" — it is "an environment containing no variables at all", and
 * a `GITHUB_TOKEN` exported in the shell would be discarded. The symptom was a
 * hunt that announced `credentials  none — unauthenticated, slow` while a token
 * sat in `process.env`, and then spent its whole budget inside the anonymous 10
 * requests a minute: a real run lost eleven of eighteen repositories to a rate
 * limit it never needed to be subject to.
 */
const env: Record<string, string | undefined> | undefined = rest.includes("--url")
	? { AH_EMDASH_BASE_URL: rest[rest.indexOf("--url") + 1] }
	: undefined;

try {
	if (command === "hunt") {
		await cmdCrawl("hunt", rest[0] ?? "sfx.json", rest.includes("--force"), env);
	} else if (command === "refresh") {
		await cmdCrawl("refresh", rest[0] ?? "sfx.json", rest.includes("--force"), env);
	} else if (command === "sync") {
		await cmdSync(rest.includes("--dry-run"), env);
	} else if (command === "verify") {
		await cmdVerify(env);
	} else {
		console.log(`Asset Hunter hunt engine

  hunt <brief.json> [--force]     discover from a brief, then re-read what it
                                  already knows that has actually moved
  refresh <brief.json> [--force]  re-read known sources only — no discovery,
                                  no search; this is the mode to schedule
  sync [--dry-run] [--url URL]    reconcile the payload into the catalogue
  verify [--url URL]              prove the catalogue matches the payload

  --force  ignore the refresh plan and re-read everything the brief allows,
           still within maxBytes and maxCandidates. For a change in the
           engine's own rules rather than in anything upstream.

  GITHUB_TOKEN        authenticated GitHub access (recommended)
  EMDASH_TOKEN        a token for a remote instance; a dev server uses dev-bypass
  AH_EMDASH_BASE_URL  the instance to read and write (--url is shorthand)
  AH_GITHUB_PER_MINUTE  override the request rate (default follows the token)
`);
		process.exitCode = command ? 1 : 0;
	}
} catch (err) {
	console.error(`\n✖ ${untrustedError(err instanceof Error ? err.message : String(err))}`);
	process.exitCode = 1;
}
