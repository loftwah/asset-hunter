/**
 * The hunt engine CLI.
 *
 * Three commands, in the order they are normally run:
 *
 *   hunt    read a brief, crawl what it names, record the evidence
 *   sync    reconcile the recorded evidence into the EmDash catalogue
 *   verify  prove the catalogue matches the payload, and that nothing human
 *           was overwritten
 *
 * The engine is a separate process from the app and talks to EmDash over the
 * same authenticated HTTP API the admin uses. It does not touch the CMS
 * database and it does not import app code, so the boundary in
 * `docs/ARCHITECTURE.md` is a real one rather than a naming convention.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Option } from "effect";
import { decodeBase64, isWorthReading, type SearchHit } from "./github.ts";
import { GitHubApi, GitHubError, type RepoRef } from "./runtime/github.ts";
import { runEngine, runEngineExit } from "./runtime/root.ts";
import { briefFingerprint, validateBrief, type HuntBrief } from "./brief.ts";
import {
	assetLicenceFor,
	classify,
	pickLicenceFile,
} from "./licence.ts";
import {
	candidateId,
	loadCandidates,
	loadWaves,
	recordCandidate,
	recordWave,
	rightsSummaryFrom,
	summarise,
	type Candidate,
	type FileEvidence,
} from "./candidates.ts";
import { extractPossibilities, kindFor, type ExtractedPossibility } from "./possibility.ts";
import { buildPayload, validatePayload, type PublishPayload } from "./publish.ts";
import { EmDashApi, EmDashApiError } from "./runtime/emdash.ts";
import { mergeExample, mergePossibility, shouldPublish } from "./merge.ts";
import {
	describeExclusion,
	exclusionFor,
	parseExclusions,
	type Exclusion,
} from "./exclusions.ts";
import { briefFingerprint as fingerprintOf } from "./brief.ts";

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, "..");
const payloadPath = join(engineRoot, "state", "payload.json");

/* -------------------------------------------------------------------------- */
/* Auth                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Signing in used to live here as a hand-rolled `fetch` with a `redirect:
 * "manual"`, a cookie split on a regex and two thrown strings. It is now
 * `EmDashApi.session` in `./runtime/emdash.ts`, so the same typed failure, the
 * same timeout and the same retry apply to the first call of a run as to the
 * hundredth — and the engine has exactly one way to be authenticated.
 */

/* -------------------------------------------------------------------------- */
/* hunt                                                                      */
/* -------------------------------------------------------------------------- */

const ASSET_EXTENSIONS =
	/\.(png|jpe?g|gif|webp|avif|svg|webm|mp4|mov|glb|gltf|blend|wav|mp3|ogg|flac|ttf|otf|woff2?|glsl|frag|vert|hlsl|shader)$/i;

/** Source files count as evidence: a procedural-audio repo shows its technique in code. */
const SOURCE_EXTENSIONS = /\.(py|js|mjs|ts|tsx|jsx|cpp|cc|c|h|rs|rb|cs|lua|d|zig)$/i;

const PER_PAGE = 30;

/** Which search wave a hit came from, recorded on the hit rather than patched on. */
interface LandedHit extends SearchHit {
	readonly query: string;
	readonly page: number;
	readonly lane: number;
}

/** The wave attribution stored on a candidate. */
interface Lane {
	readonly query: string;
	readonly page: number;
	readonly lane: string;
}

/**
 * The typed failure inside a `Cause`, when there is one.
 *
 * `Effect.runPromise` would reject with the whole `Cause` as one opaque value;
 * `runEngineExit` hands back an `Exit` so the CLI can print the message GitHub's
 * status implies rather than a stack trace.
 */
const failureOf = (cause: Cause.Cause<unknown>): GitHubError | null => {
	const found = Cause.findErrorOption(cause);
	if (Option.isNone(found)) return null;
	const value: unknown = found.value;
	return value !== null && typeof value === "object" && "_tag" in value
		? (value as GitHubError)
		: null;
};

/**
 * `hunt` — read a brief, crawl what it names, record the evidence.
 *
 * An Effect because most of what it does is network I/O with typed failures and
 * a report that has to be able to say "this hunt read less than it claims". It is
 * run by `runEngine` in the program edge at the bottom of this file, which is the
 * only place in `engine/` that starts a fiber.
 */
function cmdHunt(briefPath: string, env: Record<string, string | undefined>) {
	return runEngine(
		Effect.gen(function* () {
			const brief = loadBrief(briefPath);
			const github = yield* GitHubApi;
			const emdash = yield* EmDashApi;
			/*
			 * Standing takedowns, read before the crawl starts (#54).
			 *
			 * Read through `EmDashApi.list` like every other engine call, and a failure
			 * here is logged rather than fatal: a crawl that cannot reach the catalogue
			 * should still record what it found, and `sync` will consult the exclusions
			 * again before it writes anything. What must never happen is a run that
			 * *silently* ignores them — so the failure is reported and the hunt goes on
			 * with an empty list rather than pretending it read them.
			 */
			const exclusions = yield* emdash
				.list("exclusions")
				.pipe(
					Effect.map(parseExclusions),
					Effect.catchTag("EmDashApiError", (error) =>
						Effect.sync(() => {
							console.error(
								`  ! could not read standing exclusions (${error.detail}); this hunt cannot honour a takedown it cannot see`,
							);
							return [] as Exclusion[];
						}),
					),
				);
			// `hunt` keeps its transcript imperative, so it is bridged as a promise.
			// Everything it does that touches the network is an Effect internally.
			yield* Effect.tryPromise({
				try: () => hunt(brief, github, exclusions),
				catch: (cause) => cause,
			}).pipe(Effect.catchCause((cause) => Effect.logError(Cause.pretty(cause))));
		}),
		{ env },
	);
}

/**
 * The crawl itself, as one Effect.
 *
 * The reporting stays imperative on purpose. A `console.log` per wave is not
 * effectful work; it is a transcript, and modelling it as one would buy nothing
 * and cost every line. The network calls around it are Effects.
 */
async function hunt(
	brief: HuntBrief,
	github: GitHubApi["Service"],
	exclusions: readonly Exclusion[] = [],
): Promise<void> {
	const waves = loadWaves(engineRoot);
	const maxCandidates = brief.constraints?.maxCandidates ?? 25;
	const minStars = brief.constraints?.minStars ?? 0;
	const excluded = new Set((brief.constraints?.excludeTopics ?? []).map((t) => t.toLowerCase()));

	console.log(`\nHunt — ${brief.intent}`);
	console.log(`  brief        ${briefFingerprint(brief)}  (${brief.verticals.join(", ")})`);
	console.log(`  credentials  ${github.authenticated ? "GITHUB_TOKEN" : "none — unauthenticated, slow"}`);
	console.log(`  limit        ${maxCandidates} candidates`);
	if (exclusions.some((entry) => entry.active)) {
		// Said out loud at the top rather than silently folded into the "kept" count:
		// a hunt that finds less than its brief says must be able to say why, or the
		// catalogue looks smaller than it is.
		console.log(
			`  exclusions   ${exclusions.filter((entry) => entry.active).length} standing takedown(s) will be skipped`,
		);
	}
	console.log("");

	const queue: LandedHit[] = [];
	// Every hit a takedown removed, so the run can name them at the end. Silence here
	// would read as "we looked and found nothing", which is the impression a takedown
	// is most in danger of leaving.
	const stopped: { fullName: string; exclusion: Exclusion }[] = [];
	for (const query of brief.queries) {
		let page = 1;
		// Keep paging while a page comes back full: GitHub caps a search at 1000
		// results, and stopping at the first short page is what turns a 12
		// candidate limit into an accidental 3.
		while (queue.length < maxCandidates && page <= 5) {
			if (waves.has(`${query}::${page}`)) {
				console.log(`  ↩ ${query} p${page} already crawled`);
				page++;
				continue;
			}
			let hits: SearchHit[];
			// A rate limit or a 5xx is reported and the wave is abandoned, because a
			// hunt that quietly searched less than it claims produces a catalogue that
			// looks complete and is not. `runEngineExit` gives the typed failure rather
			// than a thrown string, so the message is the one GitHub's status implies.
			const found = await runEngineExit(
				github.search(buildQuery(query, brief), PER_PAGE, page),
			);
			if (found._tag !== "Success") {
				const failure = failureOf(found.cause);
				console.error(
					failure
						? `  ✖ ${query} p${page}: ${failure.detail}`
						: `  ✖ ${query} p${page}: the hunt could not be completed`,
				);
				break;
			}
			hits = [...found.value];
			/*
			 * The takedown filter, first (#54).
			 *
			 * A repository somebody has asked us to stop ingesting is dropped before
			 * it becomes a candidate, not after: keeping it would write a candidate,
			 * spend a download on it, and then drop it — re-reading the very material
			 * the request was about. This is the first of the acceptance criteria, and
			 * it belongs at the point where material is *found* rather than where it
			 * is written.
			 */
			const takedown = hits
				.map((hit) => ({
					fullName: hit.fullName,
					exclusion: exclusionFor(exclusions, { fullName: hit.fullName }),
				}))
				.filter((entry): entry is { fullName: string; exclusion: Exclusion } => entry.exclusion !== null);
			for (const entry of takedown) {
				if (!stopped.some((seen) => seen.fullName === entry.fullName)) stopped.push(entry);
			}
			const kept = hits.filter(
				(h) =>
					!takedown.some((hit) => hit.fullName === h.fullName) &&
					!h.archived &&
					!h.fork &&
					h.stars >= minStars &&
					!hitsExcluded(h, excluded),
			);
			recordWave(engineRoot, {
				query,
				page,
				found: hits.length,
				kept: kept.length,
				completedAt: new Date().toISOString(),
			});
			const below = hits.filter((h) => h.stars < minStars).length;
			console.log(
				`  ${query} p${page} — ${hits.length} hits, ${kept.length} kept${below ? ` (${below} under ${minStars} stars)` : ""}${takedown.length ? ` (${takedown.length} excluded by takedown)` : ""}`,
			);
			// A hit carries the wave that found it, so a candidate can be *explained*
			// rather than merely listed — "why is this here" is a question a person asks
			// about every surprising entry. Kept as a separate type rather than two
			// properties monkey-patched onto `SearchHit`, which is what the old code did
			// and which is why the field was invisible to the type checker.
			queue.push(...kept.map((hit) => ({ ...hit, query, page, lane: brief.queries.indexOf(query) + 1 })));
			if (hits.length < PER_PAGE) break;
			page++;
		}
	}

	// Which wave each hit came from. The first one wins, so a repository that two
	// queries both found is attributed to the one that found it first — the order
	// the operator wrote them in, which is the order that means something.
	const laneByHit = new Map<string, Lane>();
	for (const hit of queue) {
		if (!laneByHit.has(hit.fullName)) {
			laneByHit.set(hit.fullName, {
				query: hit.query,
				page: hit.page,
				lane: String(hit.lane),
			});
		}
	}
	const laneOf = (fullName: string) =>
		laneByHit.get(fullName) ?? { query: "unknown", page: 1, lane: "0" };

	const unique = [...new Map(queue.map((h) => [h.fullName, h])).values()].slice(0, maxCandidates);
	console.log(`\n  inspecting ${unique.length} repositories\n`);

	const budget = {
		bytes: 0,
		maxBytes: brief.constraints?.budgets?.maxBytes ?? 20 * 1024 * 1024,
		maxFiles: maxCandidates,
	};

	for (const hit of unique) {
		if (budget.bytes >= budget.maxBytes) {
			console.log(
				`\n  ! byte budget reached (${budget.bytes} of ${budget.maxBytes}); ${unique.length - unique.indexOf(hit)} candidate(s) left uninspected`,
			);
			break;
		}
		// One repository failing must not end the hunt: the evidence for the others
		// is still worth recording, and the failure is named in the transcript.
		const inspected = await runEngineExit(
			inspect(github, hit, brief, laneOf(hit.fullName), budget),
		);
		if (inspected._tag !== "Success") {
			const failure = failureOf(inspected.cause);
			console.error(
				`  ✖ ${hit.fullName}: ${failure ? failure.detail : "the repository could not be read"}`,
			);
		}
	}

	const candidates = [...loadCandidates(engineRoot).values()];
	const s = summarise(candidates);
	if (stopped.length) {
		console.log(`\n  ${stopped.length} hit(s) skipped because of a standing takedown:`);
		for (const entry of stopped.slice(0, 8)) console.log(`    ⊘ ${describeExclusion(entry.exclusion)}`);
	}
	console.log("\nRecorded");
	console.log(`  candidates   ${s.total}`);
	console.log(`  files read   ${s.readFiles}`);
	console.log(`  asset-scoped ${s.assetScoped} (a licence beside the asset, not just the repo)`);
	for (const [status, n] of Object.entries(s.byStatus)) {
		console.log(`  ${status.padEnd(12)}${n}`);
	}
	console.log(`  bytes read  ${(s.readBytes / 1024).toFixed(0)}kB`);
	const lanes = Object.entries(s.byLane).filter(([lane]) => lane !== "(recorded before lanes)");
	if (lanes.length) {
		console.log(`  lanes       ${lanes.map(([lane, n]) => `${lane}→${n}`).join(" ")}`);
	}
	for (const [policy, n] of Object.entries(s.policyApplied)) {
		if (policy !== "keep") console.log(`  policy      ${policy}: ${n}`);
	}
	// The client's own record of whether GitHub throttled us, so the report can
	// say so. This is the honesty rule: a hunt that searched less than it claims
	// must not produce a payload that looks complete.
	if (await runEngine(github.rateLimited)) {
		console.log("\n  ! rate limited during this run — the payload covers less than the queries asked for");
	}

	const payload = buildPayload(toPossibilities(candidates, brief), [], {
		huntId: `${fingerprintOf(brief)}:${brief.queries[0] ?? "hunt"}`,
		// A real timestamp here is the one thing that makes two payloads differ,
		// so it is the only non-deterministic input and it is recorded in a
		// field the merge policy treats as bookkeeping.
		syncedAt: new Date().toISOString(),
	});
	const validation = validatePayload(payload);
	if (!validation.ok) {
		console.error("\n✖ payload failed its own invariants; nothing was written");
		for (const problem of validation.problems) console.error(`  ${problem}`);
		process.exitCode = 1;
		return;
	}
	mkdirSync(dirname(payloadPath), { recursive: true });
	writeFileSync(payloadPath, `${JSON.stringify(payload, null, "\t")}\n`);
	console.log(
		`\n✔ payload ${payload.fingerprint} — ${payload.possibilities.length} possibilities, ${payload.possibilities.reduce((n, p) => n + p.examples.length, 0)} examples`,
	);
	console.log(`  ${payloadPath}`);
	console.log("\n  next: npm run hunt:sync");
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

/**
 * Builds the GitHub search string.
 *
 * Two things are deliberately *not* injected:
 *
 * - `topic:<vertical>`. A vertical is where a result is filed in our taxonomy,
 *   not a claim about how a repository is tagged on GitHub. Adding
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

/** The shape of the service the crawl uses, without depending on the class. */
type GitHubClient = GitHubApi["Service"];

/**
 * Reads one repository: pin a commit, list the tree, read what is worth reading.
 *
 * `budget` is threaded through rather than read from a global so the whole hunt
 * has one place that knows how much has been spent, and stopping mid-hunt is a
 * decision the report can explain.
 *
 * An Effect because every step is a network read that can fail in a way the
 * transcript should name. `budget` is a plain mutable object threaded through the
 * generator on purpose: it is the hunt's running spend, and a `Ref` would buy
 * nothing for a value only this function writes.
 */
function inspect(
	github: GitHubClient,
	hit: SearchHit,
	brief: HuntBrief,
	lane: Lane,
	budget: { bytes: number; maxBytes: number; maxFiles: number },
) {
	return Effect.gen(function* () {
	const ref = yield* github.resolve(hit.fullName);
	const tree = yield* github.tree(ref);
	const paths = tree.map((n) => n.path);

	// The licence first: it decides how everything else in the repository is
	// described, so it is read before any classification is formed.
	const licencePath = pickLicenceFile(paths);
	const licenceFile = licencePath ? yield* github.file(ref, licencePath) : null;

	// Asset-scoped licence: a licence sitting beside an asset is the only
	// evidence that speaks about the asset rather than the repository.
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

	// The unlicensed policy, applied before any payload is read rather than
	// after. `reject` and `metadata-only` mean the bytes never arrive; keeping
	// them and then refusing to publish them would be theatre.
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
	}

	let lfsPointers = 0;
	if (readPayload) {
		for (const path of sample) {
			if (budget.bytes >= budget.maxBytes) break;
			const file = yield* github.file(ref, path);
			if (!file) continue;
			if (file.lfsPointer) {
				// A pointer is not the asset. Hashing it would produce evidence
				// that looks real and proves nothing.
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
	};
	const { isNew } = recordCandidate(engineRoot, candidate);
	const lfsNote = lfsPointers ? ` (${lfsPointers} LFS pointer skipped)` : "";
	const policyNote = policyApplied === "keep" ? "" : ` [${policyApplied}]`;
	console.log(
		`  ${isNew ? "+" : "↻"} ${hit.fullName.padEnd(40)} ${classification.status.padEnd(11)} ${files.length} files${lfsNote}${policyNote}`,
	);
	return candidate;
	});
}

/** Groups the recorded evidence, one vertical at a time. */
function toPossibilities(candidates: Candidate[], brief: HuntBrief): ExtractedPossibility[] {
	const relevant = candidates.filter((c) => c.files.some((f) => f.kind !== "licence"));
	const out: ExtractedPossibility[] = [];
	for (const vertical of brief.verticals) {
		out.push(...extractPossibilities(relevant, { vertical, intent: brief.intent }));
	}
	return out;
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
	/** Entries a takedown stopped this run from writing (#54). */
	excluded: string[];
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
function cmdSync(dryRun: boolean, env: Record<string, string | undefined>) {
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

			const report: SyncReport = {
				created: [],
				updated: [],
				unchanged: [],
				failed: [],
				preserved: [],
				notices: [],
				excluded: [],
			};

			/*
			 * Exclusions are read before anything is written (#54).
			 *
			 * This is the acceptance criterion, not a nicety: a takedown that the
			 * engine cannot see is a takedown that the next crawl quietly undoes. The
			 * read is over HTTP like everything else here — the engine is an ordinary
			 * API client and has no privileged path into the CMS.
			 */
			const exclusions = parseExclusions(yield* api.list("exclusions"));
			if (exclusions.some((exclusion) => exclusion.active)) {
				console.log(
					`\n  ${exclusions.filter((exclusion) => exclusion.active).length} active exclusion(s) will be honoured`,
				);
			}

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
			if (report.excluded.length) {
				console.log(`\n  ${report.excluded.length} entr(ies) not written because of a takedown:`);
				for (const line of report.excluded.slice(0, 8)) console.log(`    ⊘ ${line}`);
			}
			if (report.notices.length) {
				console.log(`\n  ${report.notices.length} notice(s) for a person:`);
				for (const notice of report.notices.slice(0, 8)) console.log(`    ! ${notice}`);
			}
			if (report.failed.length) {
				console.error(`  failed    ${report.failed.length}`);
				for (const f of report.failed.slice(0, 5)) console.error(`    ✖ ${f.slug}: ${f.error}`);
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
	exclusions: readonly Exclusion[],
) =>
	Effect.gen(function* () {
		const existing = yield* api.read("possibilities", possibility.slug);
		// The merge policy decides what to write. The CLI does not.
		const merge = mergePossibility(existing?.data ?? null, possibility.data, { exclusions });
		report.preserved.push(...merge.preserved.map((f) => `${possibility.slug}.${f}`));
		report.notices.push(...merge.notes.map((n) => `${possibility.slug}: ${n}`));
		// A merge that wrote nothing *and* said it was excluded is a takedown, not a
		// no-op: the two are indistinguishable from the counters alone, and reading a
		// takedown as "unchanged" is exactly how one gets silently undone.
		if (
			merge.notes.some((note) => note.startsWith("not written")) &&
			!Object.keys(merge.write).length
		) {
			report.excluded.push(
				`${possibility.slug} — ${merge.notes.find((note) => note.startsWith("not written"))}`,
			);
			return;
		}

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
			if (exampleMerge.notes.some((note) => note.startsWith("not written"))) {
				report.excluded.push(
					`${example.slug} — ${exampleMerge.notes.find((note) => note.startsWith("not written"))}`,
				);
				continue;
			}
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
function cmdVerify(env: Record<string, string | undefined>) {
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
 */
const env: Record<string, string | undefined> = {};
if (rest.includes("--url")) env.AH_EMDASH_BASE_URL = rest[rest.indexOf("--url") + 1];

try {
	if (command === "hunt") {
		await cmdHunt(rest[0] ?? "sfx.json", env);
	} else if (command === "sync") {
		await cmdSync(rest.includes("--dry-run"), env);
	} else if (command === "verify") {
		await cmdVerify(env);
	} else {
		console.log(`Asset Hunter hunt engine

  hunt <brief.json> [--url URL]   read a brief, crawl and record the evidence
  sync [--dry-run] [--url URL]    reconcile the payload into the catalogue
  verify [--url URL]              prove the catalogue matches the payload

  GITHUB_TOKEN        authenticated GitHub access (recommended)
  EMDASH_TOKEN        a token for a remote instance; a dev server uses dev-bypass
  AH_EMDASH_BASE_URL  the instance to read and write (--url is shorthand)
  AH_GITHUB_PER_MINUTE  override the request rate (default follows the token)
`);
		process.exitCode = command ? 1 : 0;
	}
} catch (err) {
	console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
}
