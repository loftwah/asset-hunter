/**
 * The candidate store.
 *
 * Candidates are the engine's high-volume intermediate: one per repository a
 * hunt looked at, with the evidence that was read. They are deliberately
 * *not* a source of record for anything the product shows — that is what the
 * publish payload is for.
 *
 * Properties that matter:
 *
 * - **Content-addressed.** A candidate's id is a hash of its identity, so the
 *   same repository inspected twice is the same candidate.
 * - **Append-only.** Evidence is never rewritten. A re-crawl adds a new
 *   observation; the history of what was true stays readable, which is the whole
 *   point of keeping provenance.
 * - **Resumable.** A crawl that dies half way through resumes from the last
 *   completed wave rather than starting again.
 * - **Deletable.** The whole directory is a cache. `rm -rf engine/state` and a
 *   re-hunt must produce byte-identical output, so nothing here may be load
 *   bearing for correctness.
 *
 * Two additions from #41, and both of them are about *not* losing or *not*
 * duplicating what is already here: a candidate superseded by a later reading of
 * the same repository is marked rather than removed, and a repository that could
 * not be read is recorded with the commit we last saw it at rather than dropped.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Classification } from "./licence.ts";
import type { Vanished } from "./refresh.ts";

export interface CandidateIdentity {
	fullName: string;
	ref: string;
	stars: number;
}

export interface Candidate {
	/** Stable id: hash of the identity fields, not of the mutable data. */
	id: string;
	fullName: string;
	owner: string;
	repo: string;
	/** The commit every piece of this candidate's evidence was read at. */
	ref: string;
	stars: number;
	description: string | null;
	topics: string[];
	htmlUrl: string;
	defaultBranch: string;
	archived: boolean;
	fork: boolean;
	pushedAt: string;
	rights: RightsSummary;
	/** Files the engine actually read, with their hashes. */
	files: FileEvidence[];
	/** Paths worth reading that were found, for the report. Not fetched. */
	interesting: string[];
	/**
	 * The search wave that found this, so a candidate can be explained rather
	 * than merely listed. "Why is this here" is a question a person asks of
	 * every surprising entry.
	 */
	discoveredBy: { query: string; page: number; lane: string } | null;
	/** Whether the unlicensed policy let this candidate keep its payload. */
	policyApplied: "keep" | "metadata-only" | "rejected";
	firstSeen: string;
	lastSeen: string;
	/** How many times a re-crawl observed this candidate. */
	observations: number;
	/**
	 * The candidate that replaced this one, when the same repository was re-read
	 * at a new commit (#41).
	 *
	 * Optional and nullable because the store is read from disk and older state
	 * files do not have it. Nothing is deleted when this is set: the earlier
	 * evidence, its hashes and its commit stay exactly as they were, because what
	 * was true at that commit is still true. What is recorded is that a *later*
	 * reading of the same repository exists, which is what stops the catalogue
	 * growing a second example for a repository every time somebody pushes to it.
	 */
	supersededBy?: string | null;
	/** When it was superseded, ISO. Null while it is still the current reading. */
	supersededAt?: string | null;
	/**
	 * The canonical name this repository was renamed to, when GitHub redirected an
	 * old path to a new one (#41).
	 *
	 * Separate from `supersededBy` because it is a different fact: no later reading
	 * of *this* candidate exists, the repository simply lives somewhere else now.
	 */
	renamedTo?: string | null;
}

export interface FileEvidence {
	path: string;
	size: number;
	/** sha256 of the bytes read. */
	sha256: string;
	blobUrl: string | null;
	/** What kind of thing this is, by extension. */
	kind: string;
}

export interface RightsSummary {
	status: string;
	spdx: string | null;
	licencePath: string | null;
	licenceUrl: string | null;
	licenceSha256: string | null;
	quote: string | null;
	githubSpdxHint: string | null;
	note: string;
	meaning: string;
	assetScoped: boolean;
}

export const stateDir = (root: string) => join(root, "state");

const candidatesPath = (root: string) => join(stateDir(root), "candidates.json");
const wavesPath = (root: string) => join(stateDir(root), "waves.json");
const vanishedPath = (root: string) => join(stateDir(root), "vanished.json");

export const candidateId = (identity: CandidateIdentity): string =>
	createHash("sha256")
		.update(`${identity.fullName}@${identity.ref}`)
		.digest("hex")
		.slice(0, 16);

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		// A corrupt cache is a cache miss, not a failure. The directory is
		// disposable by design, so refusing to run would be worse.
		return fallback;
	}
}

function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

/** All candidates, keyed by id. */
export function loadCandidates(root: string): Map<string, Candidate> {
	const list = readJson<Candidate[]>(candidatesPath(root), []);
	return new Map(list.map((c) => [c.id, c]));
}

export function saveCandidates(root: string, candidates: Map<string, Candidate>) {
	// Sorted by id so the file is diffable and two runs of the same hunt
	// produce the same bytes.
	writeJson(candidatesPath(root), [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id)));
}

/**
 * Records an observation.
 *
 * Evidence already held is kept even if this observation did not re-read it, so
 * a partial re-crawl never loses what an earlier, fuller crawl established. The
 * rights summary is the exception: it is replaced, because a changed licence is
 * exactly the kind of change that must not be hidden.
 *
 * A candidate is keyed by `owner/repo@commit`, so re-reading a repository whose
 * head has moved lands on a **new** key. That is the right thing for provenance
 * — both readings exist, at the commits they were taken at — and the wrong thing
 * for a catalogue, which would otherwise gain another example for the same
 * repository on every push. So the earlier reading is *superseded* rather than
 * deleted: the evidence stays, the pointer says a later reading exists, and only
 * the live one is published.
 */
export function recordCandidate(root: string, next: Candidate): { isNew: boolean } {
	const candidates = loadCandidates(root);
	const existing = candidates.get(next.id);
	const merged: Candidate = existing
		? {
				...existing,
				...next,
				files: mergeFiles(existing.files, next.files),
				firstSeen: existing.firstSeen,
				observations: existing.observations + 1,
			}
		: { ...next, observations: 1 };
	candidates.set(next.id, merged);
	// A re-read of the same commit is a second observation of the same evidence,
	// not a new reading, so it supersedes nothing and is superseded by nothing.
	if (!existing) supersedeEarlierReadings(candidates, merged);
	saveCandidates(root, candidates);
	return { isNew: !existing };
}

/** Points every earlier reading of this repository at the one just recorded. */
function supersedeEarlierReadings(
	candidates: Map<string, Candidate>,
	latest: Candidate,
): void {
	for (const [id, candidate] of candidates) {
		if (id === latest.id) continue;
		if (candidate.fullName !== latest.fullName) continue;
		if (candidate.supersededBy) continue;
		// A renamed-away reading is no longer the same source at all; leaving the
		// rename in place is the more informative record.
		if (candidate.renamedTo) continue;
		candidates.set(id, { ...candidate, supersededBy: latest.id, supersededAt: latest.lastSeen });
	}
}

/**
 * Records that a repository is no longer at the name we knew it by (#41).
 *
 * Returns whether anything changed, so a refresh that notices nothing does not
 * write state — the same rule as `machine_synced_at`, and for the same reason: a
 * run that changed nothing must be a byte-level no-op.
 */
export function markRenamed(
	root: string,
	candidate: Candidate,
	renamedTo: string,
	now: string,
): boolean {
	if (candidate.renamedTo === renamedTo) return false;
	const candidates = loadCandidates(root);
	const stored = candidates.get(candidate.id);
	if (!stored || stored.renamedTo === renamedTo) return false;
	candidates.set(candidate.id, { ...stored, renamedTo, supersededAt: now });
	saveCandidates(root, candidates);
	return true;
}

/**
 * The readings a refresh may act on.
 *
 * Superseded and renamed-away candidates are still in the store and still on disk
 * — the point is that nothing is thrown away — but they are not the current
 * reading of anything, so planning against them would re-inspect a repository
 * forever on the strength of a commit that was superseded weeks ago.
 */
export function activeCandidates(candidates: Iterable<Candidate>): Candidate[] {
	return [...candidates].filter((c) => !c.supersededBy && !c.renamedTo);
}

/** The newest recorded reading of each repository, by full name. */
export function latestByFullName(candidates: Iterable<Candidate>): Map<string, Candidate> {
	const latest = new Map<string, Candidate>();
	for (const candidate of candidates) {
		const held = latest.get(candidate.fullName);
		if (!held || candidate.lastSeen > held.lastSeen) latest.set(candidate.fullName, candidate);
	}
	return latest;
}

/** Later evidence for the same path replaces the earlier read. */
function mergeFiles(earlier: FileEvidence[], later: FileEvidence[]): FileEvidence[] {
	const byPath = new Map(earlier.map((f) => [f.path, f]));
	for (const file of later) byPath.set(file.path, file);
	return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface Wave {
	query: string;
	page: number;
	/** How many hits came back. */
	found: number;
	/** How many passed the brief's constraints. */
	kept: number;
	/**
	 * The full names this page kept.
	 *
	 * Optional, and the reason an interrupted hunt can finish rather than only
	 * restart. A page is recorded as crawled the moment it is *fetched*, so a run
	 * that dies during the inspection phase comes back to find every lane already
	 * marked done — and does nothing at all, because the results it never acted on
	 * are unreachable. The hunt then silently never completes.
	 *
	 * Recording which names the page yielded costs a few hundred bytes and closes
	 * that: the next run re-offers the ones that never became candidates, and never
	 * re-fetches the page for material that was already inspected.
	 */
	names?: string[];
	/**
	 * True when this page ended its lane because it came back short.
	 *
	 * Without it, a resumed run pages *past* a lane that had already finished: the
	 * `break` that ends a lane lives in the fetch path, which a resumed page never
	 * takes, so every resume re-asked for the pages after the last one. A hunt
	 * interrupted once would then cost one extra search per page on every subsequent
	 * run, which is how "resumable" quietly becomes "repeatedly re-queried" — and
	 * the extra searches are the expensive kind, against a rate limit that is the
	 * tightest in the whole engine.
	 */
	lastPage?: boolean;
	completedAt: string;
}

/**
 * Completed waves, so a crawl that is interrupted resumes rather than repeats.
 * The key is the query and page, which is what determines the work.
 */
export function loadWaves(root: string): Map<string, Wave> {
	const list = readJson<Wave[]>(wavesPath(root), []);
	return new Map(list.map((w) => [`${w.query}::${w.page}`, w]));
}

export function recordWave(root: string, wave: Wave) {
	const waves = loadWaves(root);
	waves.set(`${wave.query}::${wave.page}`, wave);
	writeJson(
		wavesPath(root),
		[...waves.values()].sort((a, b) =>
			`${a.query}::${a.page}`.localeCompare(`${b.query}::${b.page}`),
		),
	);
}

/* -------------------------------------------------------------------------- */
/* Disappearance                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A disappearance, as the store keeps it (#41).
 *
 * `Vanished` in `./refresh.ts` is what the crawler *decides*; this is what
 * survives between runs, and the difference is that a decision evaporates when
 * the run ends while a disappearance has to be reported every time until it is
 * explained. A repository that came back is not quietly forgotten either — it is
 * marked resolved, with the commit it came back at, so the record says the
 * material disappeared and later returned rather than implying it never went.
 */
export interface VanishedRecord extends Vanished {
	/** ISO, or null while the source is still unreachable. */
	resolvedAt: string | null;
	/** The commit the source was found at again, when it came back. */
	resolvedRef: string | null;
}

/** Every disappearance on record, open ones included, keyed by full name. */
export function loadVanished(root: string): Map<string, VanishedRecord> {
	const list = readJson<VanishedRecord[]>(vanishedPath(root), []);
	return new Map(list.map((v) => [v.fullName, v]));
}

/** Sources a refresh still cannot reach. */
export function openVanished(root: string): VanishedRecord[] {
	return [...loadVanished(root).values()]
		.filter((v) => v.resolvedAt === null)
		.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/**
 * Records a disappearance.
 *
 * Idempotent on the commit: a source that 404s every run is one open record, not
 * one per run, because "this is gone" is a fact and not an event. The *first*
 * notice is kept, since that is the run whose date the record is about.
 */
export function recordVanished(root: string, record: Vanished): boolean {
	const vanished = loadVanished(root);
	const held = vanished.get(record.fullName);
	if (held && held.resolvedAt === null && held.lastSeenRef === record.lastSeenRef) return false;
	vanished.set(record.fullName, {
		...record,
		resolvedAt: held?.resolvedAt ?? null,
		resolvedRef: held?.resolvedRef ?? null,
	});
	writeJson(vanishedPath(root), [...vanished.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)));
	return true;
}

/** Marks a disappearance as explained, keeping the record rather than erasing it. */
export function resolveVanished(root: string, fullName: string, ref: string, now: string): boolean {
	const vanished = loadVanished(root);
	const held = vanished.get(fullName);
	if (!held || held.resolvedAt !== null) return false;
	vanished.set(fullName, { ...held, resolvedAt: now, resolvedRef: ref });
	writeJson(vanishedPath(root), [...vanished.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)));
	return true;
}

/** A short, readable summary used by the report and the sync output. */
export function summarise(candidates: Candidate[]) {
	const byStatus = new Map<string, number>();
	for (const c of candidates) {
		byStatus.set(c.rights.status, (byStatus.get(c.rights.status) ?? 0) + 1);
	}
	const lanes = new Map<string, number>();
	for (const c of candidates) {
		const lane = c.discoveredBy?.lane ?? "(recorded before lanes)";
		lanes.set(lane, (lanes.get(lane) ?? 0) + 1);
	}
	return {
		total: candidates.length,
		assetScoped: candidates.filter((c) => c.rights.assetScoped).length,
		byStatus: Object.fromEntries([...byStatus.entries()].sort((a, b) => b[1] - a[1])),
		byLane: Object.fromEntries([...lanes.entries()].sort((a, b) => b[1] - a[1])),
		readFiles: candidates.reduce((n, c) => n + c.files.length, 0),
		readBytes: candidates.reduce(
			(n, c) => n + c.files.reduce((m, f) => m + f.size, 0),
			0,
		),
		policyApplied: Object.fromEntries(
			[...new Set(candidates.map((c) => c.policyApplied))].map((policy) => [
				policy,
				candidates.filter((c) => c.policyApplied === policy).length,
			]),
		),
	};
}

export const rightsSummaryFrom = (c: Classification, extra: Partial<RightsSummary> = {}): RightsSummary => ({
	status: c.status,
	spdx: c.evidence.spdx,
	licencePath: c.evidence.sourcePath,
	licenceUrl: c.evidence.sourceUrl,
	licenceSha256: c.evidence.contentHash,
	quote: c.evidence.quote,
	githubSpdxHint: c.evidence.githubSpdxHint,
	note: c.evidence.note,
	meaning: c.meaning,
	assetScoped: c.assetScoped,
	...extra,
});
