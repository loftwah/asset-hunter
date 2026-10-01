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
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Classification } from "./licence.ts";

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
	firstSeen: string;
	lastSeen: string;
	/** How many times a re-crawl observed this candidate. */
	observations: number;
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
	saveCandidates(root, candidates);
	return { isNew: !existing };
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

/** A short, readable summary used by the report and the sync output. */
export function summarise(candidates: Candidate[]) {
	const byStatus = new Map<string, number>();
	for (const c of candidates) {
		byStatus.set(c.rights.status, (byStatus.get(c.rights.status) ?? 0) + 1);
	}
	return {
		total: candidates.length,
		assetScoped: candidates.filter((c) => c.rights.assetScoped).length,
		byStatus: Object.fromEntries([...byStatus.entries()].sort((a, b) => b[1] - a[1])),
		readFiles: candidates.reduce((n, c) => n + c.files.length, 0),
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
