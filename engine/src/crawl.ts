/**
 * The crawl, as one Effect (#41).
 *
 * This is where `planRefresh` stops being a pure function and starts being a
 * crawl. Before it, `engine/src/refresh.ts` answered "which sources owe work"
 * on its own, with no network and no filesystem, and `hunt` separately
 * re-inspected every repository it had ever found. The two were never joined, so
 * a second hunt cost exactly as much as the first no matter how little had moved
 * upstream.
 *
 * ## The order, which is the whole design
 *
 * ```
 *   cheap metadata  →  plan  →  bytes
 *   (2 requests)      (pure)   (tree + files, only for what the plan kept)
 * ```
 *
 * Reading a repository costs a recursive tree listing — megabytes for an ordinary
 * project — and then a download per sampled file. So nothing that costs bytes is
 * asked for until something that costs kilobytes has said it is worth it. A source
 * the plan skips costs two metadata requests and nothing else, and that is the
 * difference between a crawl that can run weekly and one that cannot.
 *
 * ## Two modes, one code path
 *
 * | Mode      | Discovery | Known sources                     |
 * | --------- | --------- | --------------------------------- |
 * | `hunt`    | yes       | re-checked, unchanged ones skipped |
 * | `refresh` | no        | re-checked, unchanged ones skipped |
 *
 * The issue asks for "semantics such as" three modes, so what is implemented is
 * chosen to be unambiguous and documented rather than speculative:
 *
 * - **`hunt <brief>`** — full discovery. Runs the brief's search lanes (skipping
 *   lanes already crawled, which is how an interrupted hunt resumes) and inspects
 *   the results, *and* applies the refresh plan to anything it already knows.
 *   Unchanged repositories are not re-downloaded.
 * - **`refresh <brief>`** — known sources only. No search, no discovery, no new
 *   candidates found by a query. This is the mode to run on a schedule: it cannot
 *   grow the universe, so its cost is bounded by what is already held.
 * - **`refresh --force`** — a broad refresh within the configured budgets. Ignores
 *   the plan and re-reads everything the brief allows, which is what you want
 *   after changing the *engine's* classification rules rather than the upstream
 *   material. Still bounded by `maxBytes` and `maxCandidates`; "full" never means
 *   "unlimited".
 *
 * A schedule is deliberately not hard-coded. #41 says the engine should be
 * runnable locally first and that future scheduling may invoke this same
 * deterministic command — so the command is the interface, and adding a schedule
 * later is a `cron` line rather than a second crawler.
 *
 * ## What a failure means
 *
 * The three outcomes of the cheap pre-check are kept apart because collapsing
 * them is how a catalogue quietly becomes wrong:
 *
 * - **404** — the source is gone. Recorded with the commit we last read and the
 *   reason. The candidate stays: a disappearance that deletes its own evidence is
 *   not honest, and a record of "gone, at commit X, on date Y" is investigable in
 *   a way that an absence is not.
 * - **403/429** — GitHub throttled us. Reported, never recorded as a
 *   disappearance, because "we were told to slow down" says nothing about the
 *   repository.
 * - **transport failure** — the socket moved. Reported, and likewise recorded as
 *   nothing. Recording these as vanishings is how a flaky network invents
 *   repositories that were deleted.
 */

import { Effect, Result } from "effect";
import { decodeBase64, isWorthReading, type SearchHit } from "./github.ts";
import type { GitHubApi } from "./runtime/github.ts";
import { briefFingerprint, type HuntBrief } from "./brief.ts";
import { assetLicenceFor, classify, pickLicenceFile } from "./licence.ts";
import {
	activeCandidates,
	candidateId,
	latestByFullName,
	candidatesForBrief,
	loadCandidates,
	loadWaves,
	markRenamed,
	recordCandidate,
	recordVanished,
	recordWave,
	resolveVanished,
	rightsSummaryFrom,
	type Candidate,
	type FileEvidence,
} from "./candidates.ts";
import { describeExclusion, exclusionFor, type Exclusion } from "./exclusions.ts";
import { verticalTerms } from "./vocabulary.ts";
import {
	extractPossibilities,
	kindFor,
	mediaKindsOf,
	type ExtractedPossibility,
} from "./possibility.ts";
import { buildPayload, type PublishPayload } from "./publish.ts";
import {
	emptyMetrics,
	formatMetrics,
	needsLicenceReread,
	noteVanished,
	planRefresh,
	type RefreshMetrics,
	type SourceAction,
	type SourceObservation,
} from "./refresh.ts";

/* -------------------------------------------------------------------------- */
/* The brief's vocabulary, as rules                                            */
/* -------------------------------------------------------------------------- */

/** Source files count as evidence: a procedural-audio repo shows its technique in code. */
const SOURCE_EXTENSIONS = /\.(py|js|mjs|ts|tsx|jsx|cpp|cc|c|h|rs|rb|cs|lua|d|zig)$/i;

const ASSET_EXTENSIONS =
	/\.(png|jpe?g|gif|webp|avif|svg|webm|mp4|mov|glb|gltf|blend|wav|mp3|ogg|flac|ttf|otf|woff2?|glsl|frag|vert|hlsl|shader)$/i;

const PER_PAGE = 30;

/** Which search wave a hit came from, recorded on the hit rather than patched on. */
interface LandedHit extends SearchHit {
	readonly query: string;
	readonly page: number;
	readonly lane: number;
	/**
	 * True when the hit was re-offered from a completed lane's record rather than
	 * from a fresh search, so its description and topics still have to be recovered.
	 */
	readonly recovered?: boolean;
}

/** The wave attribution stored on a candidate. */
interface Lane {
	readonly query: string;
	readonly page: number;
	readonly lane: string;
}

const UNKNOWN_LANE: Lane = { query: "unknown", page: 1, lane: "0" };

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/** The shape of the service the crawl uses, without depending on the class. */
type GitHubClient = GitHubApi["Service"];

export type CrawlMode = "hunt" | "refresh";

export interface CrawlOptions {
	readonly mode: CrawlMode;
	/** The engine root. State lives under it and nowhere else. */
	readonly root: string;
	readonly brief: HuntBrief;
	readonly github: GitHubClient;
	/**
	 * Re-inspect everything the brief allows, ignoring the plan.
	 *
	 * The escape hatch for a change in *our* rules rather than upstream's: a new
	 * classifier, a changed brief. Without it, a correction that does not depend on
	 * anything moving upstream has no way to be applied at all.
	 */
	readonly force?: boolean;
	/**
	 * Whether a payload is already on disk.
	 *
	 * The caller owns the payload file, so it owns this question too. A refresh that
	 * changed nothing must not rewrite the payload with a new timestamp, for the
	 * same reason the merge policy leaves `machine_synced_at` alone: it would make
	 * every later run a diff and stop `hunt:verify` from being able to tell a no-op
	 * from a real change.
	 */
	readonly payloadExists?: boolean;
	/**
	 * Standing takedowns (#54).
	 *
	 * Applied inside the crawl rather than after it, and *before* the plan, because
	 * a skipped repository must cost nothing — no metadata round trip, no tree
	 * listing, no bytes. Filtering at the end would still have re-downloaded
	 * everything on the way to discarding it.
	 *
	 * Optional, so a run with no catalogue in reach behaves exactly as it did
	 * before exclusions existed rather than failing closed on a missing list.
	 */
	readonly exclusions?: readonly Exclusion[];
	/**
	 * The transcript sink.
	 *
	 * A plain callback rather than an Effect: printing a line a person reads is not
	 * effectful work, and modelling it as one would cost every line of the report
	 * to buy nothing. A test passes a collector and asserts on what the run *said*
	 * it did, which is the only part of a crawl anybody cares about afterwards.
	 */
	readonly log?: (line: string) => void;
	/** The clock, so a test is deterministic. Defaults to the wall clock. */
	readonly now?: () => string;
}

export interface CrawlOutcome {
	readonly metrics: RefreshMetrics;
	readonly payload: PublishPayload;
	/** False when the run recorded nothing and a payload already exists. */
	readonly writePayload: boolean;
	/** Sources whose bytes were read, in the order they were read. */
	readonly inspected: string[];
	readonly skipped: SourceAction[];
	/** Disappearances newly recorded this run. */
	readonly vanished: string[];
	/** Sources GitHub redirected to a different name, as `[from, to]`. */
	readonly renamed: [string, string][];
}

/* -------------------------------------------------------------------------- */
/* The crawl                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Runs a crawl, in full, as a single Effect.
 *
 * Sequential by design: the whole point is that each repository's decision is made
 * before the next one is read, and the budget is a single running total.
 * Concurrency here would spend the budget in a different order on every run and
 * make the report unexplainable.
 *
 * The error channel is `never` on purpose and not by accident: every network call
 * is individually captured with `Effect.result`, because one repository failing
 * must not abandon the repositories after it. A crawl that died on the fourth of
 * forty sources would not be resumable in any useful sense — it would be a crawl
 * that only works when nothing goes wrong.
 */
export function crawl(options: CrawlOptions): Effect.Effect<CrawlOutcome> {
	return Effect.gen(function* () {
		const { root, brief, github, mode, force = false } = options;
		const say = options.log ?? ((line: string) => console.log(line));
		const clock = options.now ?? (() => new Date().toISOString());
		const now = clock();

		const metrics = emptyMetrics();
		const renamed: [string, string][] = [];
		const vanished: string[] = [];
		const inspected: string[] = [];

		const maxCandidates = brief.constraints?.maxCandidates ?? 25;
		const minStars = brief.constraints?.minStars ?? 0;
		const excluded = new Set((brief.constraints?.excludeTopics ?? []).map((t) => t.toLowerCase()));

		say(`\n${mode === "hunt" ? "Hunt" : "Refresh"} — ${brief.intent}`);
		say(`  brief        ${briefFingerprint(brief)}  (${brief.verticals.join(", ")})`);
		say(`  credentials  ${github.authenticated ? "GITHUB_TOKEN" : "none — unauthenticated, slow"}`);
		say(
			`  mode         ${
				mode === "hunt"
					? "full discovery, with the refresh plan applied to what is already known"
					: "known sources only, no discovery"
			}${force ? "  [--force: the plan is ignored]" : ""}`,
		);
		say(`  limit        ${maxCandidates} candidates\n`);

		/* -- What is already known --------------------------------------------- */

		// Read before discovery, not after: whether a completed lane has work left is
		// answered against the store as it was at the start of the run.
		//
		// `activeCandidates` is what makes "known" mean "the current reading": a
		// candidate superseded by a later commit is history, and planning against
		// history would re-read a repository forever on the strength of a commit that
		// was replaced weeks ago.
		/*
		 * Standing takedowns (#54), resolved to full names before anything is
		 * fetched.
		 *
		 * `exclusionFor` takes the same target shape the engine already carries for a
		 * repository, so a takedown can name a repository, a path inside one, or a
		 * digest — and this is the point at which a repository-level exclusion drops
		 * the source entirely, before the metadata round trip below spends a request
		 * to learn something already decided.
		 */
		const exclusions = options.exclusions ?? [];
		const withheld = new Map<string, Exclusion>();

		const recordedAll = activeCandidates(loadCandidates(root).values());
		// An excluded source is dropped from the record the planner reads, not from
		// the store: the evidence of what was once read is kept, so lifting an
		// exclusion restores the history instead of requiring a re-crawl.
		const recorded = recordedAll.filter((c) => {
			const exclusion = exclusionFor(exclusions, { fullName: c.fullName });
			if (exclusion) withheld.set(c.fullName, exclusion);
			return !exclusion;
		});
		if (withheld.size) {
			say(`  exclusions   ${withheld.size} source(s) withheld by a standing takedown\n`);
			for (const [fullName, exclusion] of [...withheld].slice(0, 8)) {
				say(`    ⊘ ${fullName} — ${describeExclusion(exclusion)}`);
			}
		}
		const known = latestByFullName(recorded);
		const knownNames = new Set(known.keys());

		/* -- Discovery --------------------------------------------------------- */

		const queue: LandedHit[] = [];
		if (mode === "hunt") {
			yield* discover({
				github,
				brief,
				root,
				maxCandidates,
				minStars,
				excluded,
				say,
				known: knownNames,
				land: queue,
			});
		}

		// Search hits a takedown names are dropped here, before they become targets.
		// Discovery already cost the query; the repository costs nothing more.
		for (const landed of queue) {
			const exclusion = exclusionFor(exclusions, { fullName: landed.fullName });
			if (exclusion) withheld.set(landed.fullName, exclusion);
		}
		if (withheld.size) {
			say(`  exclusions   ${withheld.size} source(s) withheld by a standing takedown\n`);
			for (const [fullName, exclusion] of [...withheld].slice(0, 8)) {
				say(`    ⊘ ${fullName} — ${describeExclusion(exclusion)}`);
			}
		}

		const laneByHit = new Map<string, Lane>();
		for (const hit of queue.filter((l) => !withheld.has(l.fullName))) {
			// The first wave wins, so a repository two queries both found is attributed
			// to the one that found it first — the order the operator wrote them in,
			// which is the order that means something.
			if (!laneByHit.has(hit.fullName)) {
				laneByHit.set(hit.fullName, { query: hit.query, page: hit.page, lane: String(hit.lane) });
			}
		}
		const laneOf = (fullName: string) => laneByHit.get(fullName) ?? UNKNOWN_LANE;

		// `SearchHit`, not `LandedHit`: a refresh has no lane for a hit it did not
		// discover, and the wave attribution is carried on the candidate instead.
		const targets = new Map<string, SearchHit>();
		for (const landed of queue) {
			if (withheld.has(landed.fullName)) continue;
			// A hit the store already holds is rebuilt from the recorded evidence. The
			// search is not re-run for it, so there is nothing else to build it from —
			// and using the placeholder would throw away the description that explains
			// why the repository is in the catalogue at all.
			if (!landed.recovered) {
				targets.set(landed.fullName, landed);
				continue;
			}
			if (known.has(landed.fullName)) {
				targets.set(landed.fullName, hitFromCandidate(known.get(landed.fullName)!));
				continue;
			}
			// Outstanding work from an interrupted run: no search result and no record,
			// so its description is recovered with one targeted lookup.
			const recovery = yield* recoverHit(github, landed);
			targets.set(landed.fullName, recovery.hit);
			if (!recovery.recovered) {
				say(
					`  ! ${landed.fullName} could not be described again (${recovery.reason}); recording it with no description`,
				);
			}
		}

		// In a refresh the universe *is* the store, so the candidates are
		// reconstructed from what is already recorded rather than from a search that
		// would find new material. A refresh that could grow the universe would not be
		// a refresh.
		if (mode === "refresh") {
			for (const candidate of recorded.slice(0, maxCandidates)) {
				if (!targets.has(candidate.fullName)) targets.set(candidate.fullName, hitFromCandidate(candidate));
			}
			if (recorded.length > maxCandidates) {
				say(
					`  ! ${recorded.length} sources on record but the brief allows ${maxCandidates}; the rest need a wider brief`,
				);
			}
		}

		/* -- The cheap pre-check ----------------------------------------------- */

		const observations = new Map<string, SourceObservation>();
		for (const fullName of [...targets.keys()]) {
			// A source the store has never seen needs no pre-check at all: the search
			// result already carried everything an inspection needs, so a metadata
			// round trip would be a request spent to learn that it is new.
			const candidate = known.get(fullName);
			if (!candidate) continue;

			const read = yield* Effect.result(github.observe(fullName));
			if (Result.isSuccess(read)) {
				const seen = read.success;
				observations.set(seen.fullName, seen);
				metrics.sourcesChecked++;
				if (seen.fullName !== fullName) {
					// A redirect is a move, not a disappearance, and it is finished in the
					// same run rather than left for the next hunt: the old reading is
					// marked as moved, and the new name is inspected now, carrying the
					// recorded description across so a renamed repository does not lose
					// the text that explains why it was ever in the catalogue.
					markRenamed(root, candidate, seen.fullName, clock());
					renamed.push([fullName, seen.fullName]);
					targets.set(seen.fullName, {
						...hitFromCandidate(candidate),
						fullName: seen.fullName,
						stars: seen.stars,
						defaultBranch: seen.defaultBranch,
						pushedAt: seen.pushedAt,
						archived: seen.archived,
						fork: seen.fork,
					});
					say(`  → ${fullName} is now ${seen.fullName}`);
				}
				continue;
			}

			const failure = read.failure;
			if (failure.status === 404) {
				// Never silently dropped: the candidate stays in the store and in the
				// payload, and the disappearance is recorded with the commit we last
				// read. A record of "gone, at this commit, on this date" can be
				// investigated; an absence cannot.
				const record = noteVanished(candidate, failure.detail || "404 not found", clock());
				if (recordVanished(root, record)) {
					metrics.vanished++;
					vanished.push(fullName);
					say(`  ✖ ${fullName} is gone — last read at ${candidate.ref.slice(0, 7)}`);
				}
				continue;
			}
			if (failure.rateLimited) {
				// Said out loud, recorded as nothing. A throttle is not a fact about the
				// repository, and writing one down would invent disappearances.
				say(`  ! ${fullName}: ${failure.detail}`);
				continue;
			}
			// A transport failure says the socket moved, not that the repository did.
			say(`  ✖ ${fullName}: ${failure.detail}`);
		}

		/* -- The plan ---------------------------------------------------------- */

		// A hit this run discovered is work, and it is work the plan cannot see:
		// `planRefresh` plans from the *recorded* candidates, because "does this
		// source owe a re-read" is a question about a source the store already holds.
		// New material has nothing to re-read, so it is added rather than planned for.
		//
		// Two things are deliberately not done here. A new hit is not given a
		// fabricated `headSha` so that the planner can see it — a made-up provenance
		// value is exactly what this engine exists to avoid. And a new hit is not
		// given a metadata pre-check — the search response already carried
		// `pushedAt`, `archived`, `fork`, `defaultBranch` and `stars`, so a round trip
		// would be a request spent to learn what was in hand.
		const planned = planRefresh(recorded, observations, now);
		// A renamed source arrives twice: once as the observation the planner saw under
		// its new name, and once as a target this run has never heard of. One job, not
		// two — inspecting it twice would read its tree twice and count it twice.
		const alreadyPlanned = new Set(planned.inspect.map((action) => action.fullName));
		const discovered = [...targets.keys()].filter(
			(fullName) => !known.has(fullName) && !alreadyPlanned.has(fullName),
		);
		const plan = force
			? forcedPlan(targets.keys(), known)
			: {
					...planned,
					inspect: [
						...planned.inspect,
						...discovered.map(
							(fullName): SourceAction => ({ kind: "inspect", reason: "new-source", fullName }),
						),
					],
				};

		metrics.sourcesUnchanged = plan.unchanged;
		for (const action of plan.inspect) {
			if (action.reason === "new-source") metrics.newSources++;
			else metrics.sourcesChanged++;
		}
		// A source that is reachable again is no longer missing, but the record of the
		// disappearance stays: "gone, then back at this commit" is what happened, and
		// erasing the first half would make the second half unverifiable.
		for (const [fullName, seen] of observations) {
			resolveVanished(root, fullName, seen.headSha, clock());
		}

		const due = plan.inspect
			.map((action) => action.fullName)
			// A plan entry with no candidate to inspect is a repository that was renamed
			// onto a name this run has nothing to fetch for. It is named, not dropped.
			.filter((fullName) => targets.has(fullName))
			.slice(0, maxCandidates);
		const renamesWithoutTarget = plan.inspect
			.map((action) => action.fullName)
			.filter((fullName) => !targets.has(fullName));
		for (const fullName of renamesWithoutTarget) {
			say(`  ! ${fullName} is new and this run has no search result for it; run \`hunt\` to discover it`);
		}

		const fresh = due.filter((fullName) => !known.has(fullName));
		if (due.length) {
			say(`\n  inspecting ${due.length} repositories — ${fresh.length} new, ${due.length - fresh.length} changed\n`);
		} else {
			say("\n  nothing owes a re-read\n");
		}

		/* -- Bytes, for whatever survived the plan ------------------------------ */

		const budget = { bytes: 0, maxBytes: brief.constraints?.budgets?.maxBytes ?? 20 * 1024 * 1024 };

		for (const [index, fullName] of due.entries()) {
			if (budget.bytes >= budget.maxBytes) {
				say(
					`\n  ! byte budget reached (${budget.bytes} of ${budget.maxBytes}); ${due.length - index} source(s) left uninspected`,
				);
				break;
			}
			const hit = targets.get(fullName)!;
			const before = known.get(fullName) ?? null;
			const read = yield* Effect.result(
				inspect({ github, hit, brief, lane: laneOf(fullName), budget, root, say }),
			);
			if (Result.isFailure(read)) {
				say(`  ✖ ${fullName}: ${read.failure.detail}`);
				continue;
			}
			inspected.push(fullName);
			// A licence re-read is only *owed* when the evidence behind the rights
			// actually moved. Counting a re-read of a repository because a star count
			// went up would inflate the one number a person would trust.
			if (before && needsLicenceReread(before, read.success)) metrics.licenceRereads++;
		}

		metrics.bytesDownloaded = budget.bytes;

		/* -- The report -------------------------------------------------------- */

		// A hunt always produces a payload. A refresh only rewrites one when it
		// recorded something, or when there is nothing to rewrite yet.
		const writePayload = mode === "hunt" || inspected.length > 0 || !options.payloadExists;

		say("\nRefresh");
		for (const line of formatMetrics(metrics)) say(line);
		if (!writePayload) {
			// Said out loud rather than passed over in silence: a run that decided not
			// to write is a decision somebody might otherwise read as a failure, and the
			// absence of a payload diff is the whole point.
			say("\n✔ nothing changed, so no payload was rewritten");
		}
		if (vanished.length) {
			say("\n  gone upstream, kept here with the commit last read:");
			for (const fullName of vanished) say(`    ✖ ${fullName}`);
		}
		if (renamed.length) {
			say("\n  moved upstream:");
			for (const [from, to] of renamed) say(`    → ${from} → ${to}`);
		}

		const payload = buildPayload(toPossibilities(activeCandidates(loadCandidates(root).values()), brief), [], {
			huntId: `${briefFingerprint(brief)}:${mode === "hunt" ? (brief.queries[0] ?? "hunt") : "refresh"}`,
			// The one non-deterministic input to the payload, and the one the merge
			// policy treats as bookkeeping rather than as change.
			syncedAt: now,
		});

		// The client's own record of whether GitHub throttled us. The honesty rule: a
		// run that read less than it claims must not produce a payload that looks
		// complete.
		if (yield* github.rateLimited) {
			say("\n  ! rate limited during this run — the payload covers less than the brief asked for");
		}

		return {
			metrics,
			payload,
			writePayload,
			inspected,
			skipped: plan.skip,
			vanished,
			renamed,
		} satisfies CrawlOutcome;
	});
}

/**
 * The plan `--force` substitutes for {@link planRefresh}.
 *
 * A forced re-read is reported as `upstream-pushed` for a source we already hold
 * and `new-source` for one we do not, because those are the only two reasons a
 * plan entry can have and inventing a third would give the report a word that
 * means nothing. The operator knows why: they asked.
 */
function forcedPlan(
	fullNames: Iterable<string>,
	known: ReadonlyMap<string, Candidate>,
): { inspect: SourceAction[]; skip: SourceAction[]; unchanged: number } {
	const inspect: SourceAction[] = [];
	for (const fullName of fullNames) {
		inspect.push({
			kind: "inspect",
			reason: known.has(fullName) ? "upstream-pushed" : "new-source",
			fullName,
		});
	}
	return { inspect, skip: [], unchanged: 0 };
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

interface DiscoverOptions {
	readonly github: GitHubClient;
	readonly brief: HuntBrief;
	readonly root: string;
	readonly maxCandidates: number;
	readonly minStars: number;
	readonly excluded: Set<string>;
	readonly say: (line: string) => void;
	/** Full names the store already holds, so a completed lane is not re-offered. */
	readonly known: ReadonlySet<string>;
	/** Filled with every hit the lanes returned. */
	readonly land: LandedHit[];
}

/**
 * Runs the brief's search lanes, skipping the pages already crawled.
 *
 * `loadWaves` is what makes an interrupted hunt resumable at the *search* stage: a
 * page is recorded as complete the moment it is fetched, so a run that dies during
 * the inspection phase does not re-run searches that already answered. The key is
 * the query and the page, which is what determines the work.
 *
 * ## Why a completed lane is not the end of it
 *
 * "Fetched" and "acted on" are different moments, and only the first is recorded
 * by the wave. A run that dies between them comes back to find every lane marked
 * done and does nothing at all, so a hunt interrupted after its searches but before
 * its inspections could never finish, and would report a clean run having found
 * nothing to do. That is the failure #41 calls a non-resumable crawl, and it is
 * worse than starting over, because it looks like success.
 *
 * So a completed lane is *checked* against the store rather than trusted: the hits
 * it yielded that never became candidates are re-offered, as names. Their
 * description and topics are recovered with one targeted `repo:` lookup per
 * outstanding hit, which is the same endpoint and the same fields for a kilobyte
 * instead of a re-run of the whole lane, and a name the store already holds is not
 * re-offered at all.
 */
const discover = (options: DiscoverOptions) =>
	Effect.gen(function* () {
		const { github, brief, root, maxCandidates, minStars, excluded, say, known, land } = options;
		const waves = loadWaves(root);
		for (const query of brief.queries) {
			let page = 1;
			// Keep paging while a page comes back full: GitHub caps a search at 1000
			// results, and stopping at the first short page is what turns a 12
			// candidate limit into an accidental 3.
			while (land.length < maxCandidates && page <= 5) {
				const done = waves.get(`${query}::${page}`);
				if (done) {
					// A completed lane re-offers every name it yielded, and the store
					// decides what happens to each one:
					//
					// - a name already on record becomes a pre-check target, so `hunt`
					//   re-reads what it knows in the same run it looks for what it does
					//   not. That is the whole point of a hunt, and the pre-check is two
					//   requests, so doing it here is nearly free.
					// - a name that never became a candidate is outstanding work from an
					//   interrupted run, and is inspected for the first time. Its
					//   description has to be recovered, because the store has none.
					//
					// Either way the search itself is not repeated, which is the expensive
					// part and the part that is rate-limited.
					const names = done.names ?? [];
					for (const name of names) {
						land.push({
							...placeholderHit(name),
							query,
							page,
							lane: brief.queries.indexOf(query) + 1,
							// A name already on record is re-checked from the recorded evidence,
							// which needs no search. A name that is not on record is outstanding
							// work from an interrupted run and has no description yet, so one
							// targeted `repo:` lookup recovers it.
							recovered: !known.has(name),
						});
					}
					const outstanding = names.filter((name) => !known.has(name));
					say(
						outstanding.length
							? `  ↩ ${query} p${page} already crawled; ${outstanding.length} hit(s) still to inspect, ${names.length - outstanding.length} re-checked`
							: `  ↩ ${query} p${page} already crawled; re-checking ${names.length} known`,
					);
					// A page that ended its lane ends it again. Without this the `break`
					// below is never reached on a resumed page, so every resume pages
					// past a finished lane and re-asks GitHub for results it already has.
					if (done.lastPage) break;
					page++;
					continue;
				}
				const found = yield* Effect.result(github.search(buildQuery(query, brief), PER_PAGE, page));
				// A rate limit or a 5xx is reported and the lane is abandoned, because a
				// hunt that quietly searched less than it claims produces a catalogue that
				// looks complete and is not.
				if (Result.isFailure(found)) {
					say(`  ✖ ${query} p${page}: ${found.failure.detail}`);
					break;
				}
				const hits = [...found.success];
				const kept = hits.filter(
					(h) => !h.archived && !h.fork && h.stars >= minStars && !hitsExcluded(h, excluded),
				);
				const lastPage = hits.length < PER_PAGE;
				recordWave(root, {
					query,
					page,
					found: hits.length,
					kept: kept.length,
					// Which names, not just how many: a completed lane has to be able to say
					// which of its results were never inspected, or an interrupted hunt can
					// never finish. See `discover`.
					names: kept.map((h) => h.fullName),
					lastPage,
					completedAt: new Date().toISOString(),
				});
				const below = hits.filter((h) => h.stars < minStars).length;
				say(
					`  ${query} p${page} — ${hits.length} hits, ${kept.length} kept${below ? ` (${below} under ${minStars} stars)` : ""}`,
				);
				// A hit carries the wave that found it, so a candidate can be *explained*
				// rather than merely listed — "why is this here" is a question a person
				// asks about every surprising entry. A separate type rather than two
				// properties monkey-patched onto `SearchHit`, which is what the first
				// version did and why the field was invisible to the type checker.
				for (const hit of kept) land.push({ ...hit, query, page, lane: brief.queries.indexOf(query) + 1 });
				if (lastPage) break;
				page++;
			}
			// One lane is a whole idea the operator wrote down. Filling the candidate
			// limit from the first query and never asking the second would mean the
			// brief's later queries are decoration, so the loop moves on and the limit
			// is enforced inside it instead.
		}
	});

/**
 * Builds the GitHub search string.
 *
 * Two things are deliberately *not* injected:
 *
 * - `topic:<vertical>`. A vertical is where a result is filed in our taxonomy, not
 *   a claim about how a repository is tagged on GitHub. Adding
 *   `topic:audio-music` to a sound query returns zero results, which is how the
 *   first run of this engine reported a successful hunt that found nothing.
 * - `stars:>=N`. GitHub ANDs every qualifier into the text match, and
 *   `"granular sound texture stars:>=40"` matches nothing while the phrase alone
 *   matches nine. Stars are filtered client-side instead, where the threshold is
 *   visible in the report.
 */
function buildQuery(query: string, brief: HuntBrief): string {
	const parts = [query];
	for (const topic of brief.constraints?.topicHints ?? []) parts.push(`topic:${topic}`);
	return parts.join(" ");
}

function hitsExcluded(hit: SearchHit, excluded: Set<string>): boolean {
	return hit.topics.some((t) => excluded.has(t.toLowerCase()));
}

/**
 * The least a hit can be, given only its name.
 *
 * Reached for a hit re-offered from a completed lane: the search result is gone
 * and the repository has never been inspected, so there is nothing recorded. The
 * fields that must not be invented — description, topics, the licence hint — are
 * left null/empty here and recovered below, rather than guessed at.
 */
function placeholderHit(fullName: string): SearchHit {
	return {
		fullName,
		description: null,
		stars: 0,
		license: null,
		topics: [],
		defaultBranch: "main",
		htmlUrl: `https://github.com/${fullName}`,
		updatedAt: "",
		pushedAt: "",
		archived: false,
		fork: false,
	};
}

/**
 * Fills in the fields a re-offered hit is missing.
 *
 * `repo:owner/name` is GitHub's own qualifier for "this exact repository", so the
 * recovery is the same endpoint and the same fields the original lane read, for
 * one request instead of a re-run of the page. A failure is not fatal: the
 * inspection still runs, and the report says the description was not recovered
 * rather than the candidate being quietly recorded with no description at all —
 * which is what would happen if this silently returned the placeholder.
 */
const recoverHit = (github: GitHubClient, hit: SearchHit) =>
	Effect.gen(function* () {
		const found = yield* Effect.result(github.search(`repo:${hit.fullName}`, PER_PAGE, 1));
		if (Result.isFailure(found)) {
			return { hit, recovered: false, reason: found.failure.detail };
		}
		// `repo:` is an exact qualifier, but an empty result is possible for a
		// repository made private between the two calls, so this is checked rather
		// than assumed.
		const exact = found.success.find((h) => h.fullName === hit.fullName);
		return exact ? { hit: { ...exact, query: "", page: 0, lane: 0 }, recovered: true } : { hit, recovered: false, reason: "not found by a repo: lookup" };
	});

/**
 * A refresh's stand-in for a search hit.
 *
 * Built from what is already recorded, so a refresh needs no search in order to
 * re-inspect a repository. The recorded hint is carried through because it is a
 * hint: the classifier reads the licence *file* and treats GitHub's metadata as a
 * claim to be checked, never as permission.
 */
export function hitFromCandidate(candidate: Candidate): SearchHit {
	return {
		fullName: candidate.fullName,
		description: candidate.description,
		stars: candidate.stars,
		license: candidate.rights.githubSpdxHint
			? { spdxId: candidate.rights.githubSpdxHint, name: null }
			: null,
		topics: candidate.topics,
		defaultBranch: candidate.defaultBranch,
		htmlUrl: candidate.htmlUrl,
		updatedAt: candidate.lastSeen,
		pushedAt: candidate.pushedAt,
		archived: candidate.archived,
		fork: candidate.fork,
	};
}

/* -------------------------------------------------------------------------- */
/* Inspection                                                                  */
/* -------------------------------------------------------------------------- */

interface InspectOptions {
	readonly github: GitHubClient;
	readonly hit: SearchHit;
	readonly brief: HuntBrief;
	readonly lane: Lane;
	readonly budget: { bytes: number; maxBytes: number };
	/** The engine root the candidate is recorded under. */
	readonly root: string;
	readonly say: (line: string) => void;
}

/**
 * Reads one repository: pin a commit, list the tree, read what is worth reading.
 *
 * `budget` is threaded through rather than read from a global so the whole crawl
 * has one place that knows how much has been spent, and stopping mid-crawl is a
 * decision the report can explain.
 *
 * An Effect because every step is a network read that can fail in a way the
 * transcript should name. `budget` is a plain mutable object threaded through the
 * generator on purpose: it is the run's running spend, and a `Ref` would buy
 * nothing for a value only this function writes.
 */
function inspect(options: InspectOptions) {
	const { github, hit, brief, lane, budget, root, say } = options;
	return Effect.gen(function* () {
		const ref = yield* github.resolve(hit.fullName);
		const tree = yield* github.tree(ref);
		const paths = tree.map((n) => n.path);

		// The licence first: it decides how everything else in the repository is
		// described, so it is read before any classification is formed.
		const licencePath = pickLicenceFile(paths);
		const licenceFile = licencePath ? yield* github.file(ref, licencePath) : null;

		// Asset-scoped licence: a licence sitting beside an asset is the only evidence
		// that speaks about the asset rather than the repository.
		const assetPaths = paths.filter((p) => ASSET_EXTENSIONS.test(p) && isWorthReading(p, 0));
		const sourcePaths = paths.filter(
			(p) => SOURCE_EXTENSIONS.test(p) && !/\.(test|spec)\./i.test(p) && isWorthReading(p, 0),
		);
		// Media first, then source: a repository that ships both demonstrates the
		// technique twice, and the media is the more direct evidence of it.
		const perRepo = brief.constraints?.budgets?.maxFilesPerRepo ?? 5;
		const sample = [...assetPaths.slice(0, 3), ...sourcePaths.slice(0, 2)].slice(0, perRepo);

		let assetEvidence: { text: string; path: string; url: string | null } | null = null;
		for (const candidate of sample) {
			const near = assetLicenceFor(paths, candidate);
			if (!near) continue;
			const file = yield* github.file(ref, near);
			if (file) {
				assetEvidence = { text: decodeBase64(file.content), path: near, url: file.url };
				break;
			}
		}

		const classification = classify({
			licenceText: licenceFile ? decodeBase64(licenceFile.content) : null,
			licencePath,
			licenceUrl: licenceFile?.url ?? null,
			githubSpdxHint: hit.license?.spdxId ?? null,
			assetLicenceText: assetEvidence?.text ?? null,
			assetLicencePath: assetEvidence?.path ?? null,
			assetLicenceUrl: assetEvidence?.url ?? null,
		});

		// The unlicensed policy, applied before any payload is read rather than after.
		// `reject` and `metadata-only` mean the bytes never arrive; keeping them and
		// then refusing to publish them would be theatre.
		const unlicensed = !["cleared", "attribution"].includes(classification.status);
		const policy = brief.constraints?.unlicensedPolicy ?? "keep";
		const policyApplied: Candidate["policyApplied"] = !unlicensed
			? "keep"
			: policy === "reject"
				? "rejected"
				: policy === "metadata-only"
					? "metadata-only"
					: "keep";
		const readPayload = policyApplied === "keep";

		const files: FileEvidence[] = [];
		const hashOf = (file: { content: string }) =>
			Effect.promise(() => import("node:crypto")).pipe(
				Effect.map((crypto) => crypto.createHash("sha256").update(file.content).digest("hex")),
			);

		if (licenceFile) {
			files.push({
				path: licencePath as string,
				size: licenceFile.size,
				sha256: yield* hashOf(licenceFile),
				blobUrl: licenceFile.url,
				kind: "licence",
			});
			// The licence is charged to the budget like any other file. It was not
			// before this change, and it is usually the *largest* thing a crawl reads —
			// AGPL and GPL texts run to tens of kilobytes — so a budget that ignored it
			// was not bounding bytes downloaded, which is the one thing it exists to do.
			// `summarise().readBytes` in the report always counted these, so the two
			// numbers disagreed.
			budget.bytes += licenceFile.size;
		}

		let lfsPointers = 0;
		if (readPayload) {
			for (const path of sample) {
				if (budget.bytes >= budget.maxBytes) break;
				const file = yield* github.file(ref, path);
				if (!file) continue;
				if (file.lfsPointer) {
					// A pointer is not the asset. Hashing it would produce evidence that
					// looks real and proves nothing.
					lfsPointers++;
					continue;
				}
				files.push({
					path,
					size: file.size,
					sha256: yield* hashOf(file),
					blobUrl: file.url || null,
					kind: kindFor(path),
				});
				budget.bytes += file.size;
			}
		}

		const now = new Date().toISOString();
		const candidate: Candidate = {
			id: candidateId({ fullName: hit.fullName, ref: ref.ref, stars: hit.stars }),
			fullName: hit.fullName,
			owner: ref.owner,
			repo: ref.repo,
			ref: ref.ref,
			stars: hit.stars,
			description: hit.description,
			topics: hit.topics,
			htmlUrl: hit.htmlUrl,
			defaultBranch: hit.defaultBranch,
			archived: hit.archived,
			fork: hit.fork,
			pushedAt: hit.pushedAt,
			rights: rightsSummaryFrom(classification),
			files,
			interesting: [...assetPaths, ...sourcePaths].slice(0, 25),
			discoveredBy: lane,
			policyApplied,
			firstSeen: now,
			lastSeen: now,
			observations: 1,
			briefFingerprint: briefFingerprint(brief),
		};
		const { isNew } = recordCandidate(root, candidate);
		const lfsNote = lfsPointers ? ` (${lfsPointers} LFS pointer skipped)` : "";
		const policyNote = policyApplied === "keep" ? "" : ` [${policyApplied}]`;
		say(
			`  ${isNew ? "+" : "↻"} ${hit.fullName.padEnd(40)} ${classification.status.padEnd(11)} ${files.length} files${lfsNote}${policyNote}`,
		);
		return candidate;
	});
}

/**
 * Groups the recorded evidence, one vertical at a time.
 *
 * Two things this deliberately does **not** do, both of which it used to do and
 * both of which put false claims on the public catalogue:
 *
 * 1. **It does not see other briefs' candidates.** `candidates.json` is shared
 *    across hunts, so extracting the whole store meant a run of the logos brief
 *    filed the audio candidates the SFX brief had recorded — a logos entry with a
 *    Java tic-tac-toe game listed as its evidence. The store is now filtered by
 *    the brief's fingerprint, so an entry's examples are the sources that hunt
 *    actually inspected.
 * 2. **It does not file one candidate under every declared vertical.** It did,
 *    which meant one repository produced four entries differing only by a slug
 *    segment: a wall of the same mark four times with four different examples
 *    lists, none of them more correct than the others. Each candidate is now
 *    filed under the single declared vertical it fits best, so a brief produces
 *    one entry per treatment and the taxonomy is a statement rather than a
 *    multiplication. `verticalFit` is the rule, and a candidate that fits none of
 *    the declared terms is dropped rather than filed under the nearest.
 */
function toPossibilities(candidates: Candidate[], brief: HuntBrief): ExtractedPossibility[] {
	const mine = candidatesForBrief(new Map(candidates.map((c) => [c.id, c])), briefFingerprint(brief));
	const relevant = mine.filter((c) => c.files.some((f) => f.kind !== "licence"));
	const byVertical = new Map<string, Candidate[]>();
	for (const candidate of relevant) {
		const vertical = verticalFit(candidate, brief.verticals);
		if (!vertical) continue;
		const bucket = byVertical.get(vertical) ?? [];
		bucket.push(candidate);
		byVertical.set(vertical, bucket);
	}
	const out: ExtractedPossibility[] = [];
	for (const vertical of brief.verticals) {
		const bucket = byVertical.get(vertical);
		if (!bucket?.length) continue;
		out.push(...extractPossibilities(bucket, { vertical, intent: brief.intent }));
	}
	return out;
}

/**
 * A deliberately crude stem, and deliberately so.
 *
 * The failure it exists to fix was arithmetic, not linguistics: `Logos` split
 * into `["logos"]`, and a repository or a query that said `logo` matched nothing,
 * so a hunt whose whole intent was marks refused every mark it found. A real
 * stemmer would be more code than this problem deserves and a place to be wrong
 * quietly, so this collapses the two endings that actually cause it (`-s` and
 * `-es`) and nothing else. Words shorter than three characters are dropped
 * because they cannot discriminate.
 */
function stem(word: string): string {
	const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (w.length <= 2) return "";
	if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
	if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
	if (w.endsWith("s")) return w.slice(0, -1);
	return w;
}

const stemAll = (text: string): Set<string> =>
	new Set(
		text
			.split(/[^a-z0-9]+/)
			.map(stem)
			.filter((w) => w.length > 2),
	);

/**
 * The one declared vertical a candidate belongs in, or null for none.
 *
 * Scored from three places, in this order of authority:
 *
 * 1. **The candidate's own words** — its name, description and topics. Strongest,
 *    because it is evidence about the repository rather than about the hunt.
 * 2. **The query that found it.** The operator wrote the queries, the brief
 *    records them, and `discoveredBy.query` says which one surfaced this
 *    repository. A favicon generator found by `"logo generator svg"` said
 *    "logo" in the only sentence anyone wrote about the intent to find it, and
 *    using that is not a guess — it is the brief doing its job.
 * 3. **The medium the vertical produces.** A `vector` result is evidence about
 *    an `icons` entry independently of what anybody called it.
 *
 * Refuses on no signal and on a tie. Filing under the first declared vertical
 * because it happened to be listed first is exactly how a Java game ends up in a
 * wall of logos, and a refusal is recoverable in a way a wrong entry is not.
 */
function verticalFit(candidate: Candidate, verticals: string[]): string | null {
	const own = stemAll(
		[
			candidate.repo,
			candidate.description ?? "",
			...(candidate.topics ?? []),
		].join(" "),
	);
	const via = stemAll(candidate.discoveredBy?.query ?? "");
	const media = mediaKindsOf(candidate);
	// The terms, not just the label. `audio-music`'s label words are *audio* and
	// *music*; the repositories that brief is sent after say *sound*, *sfx* and
	// *granular*. Matching the label alone refused a granular texture generator
	// from a hunt for procedural sound effects — see `VERTICAL_TERMS`.
	const scored = verticals.map((vertical) => {
		let score = 0;
		for (const term of verticalTerms(vertical)) {
			const word = stem(term);
			if (!word) continue;
			if (own.has(word)) score += 3;
			if (via.has(word)) score += 2;
		}
		if (own.has(stem(vertical))) score += 3;
		if (vertical === "icons" && media.includes("vector")) score += 2;
		if (vertical === "logos" && media.includes("vector")) score += 1;
		if (vertical === "motion-video" && media.includes("motion")) score += 2;
		if (vertical === "audio-music" && media.includes("audio")) score += 2;
		if (vertical === "3d" && media.includes("model")) score += 2;
		return { vertical, score };
	});
	scored.sort((a, b) => b.score - a.score);
	if (!scored[0] || scored[0].score <= 0) return null;
	if (scored[1] && scored[0].score === scored[1].score) return null;
	return scored[0].vertical;
}
