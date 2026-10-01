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
import {
	GitHub,
	GitHubError,
	decodeBase64,
	isWorthReading,
	type SearchHit,
} from "./github.ts";
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
import { mergeExample, mergePossibility, shouldPublish } from "./merge.ts";
import { briefFingerprint as fingerprintOf } from "./brief.ts";

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, "..");
const payloadPath = join(engineRoot, "state", "payload.json");

/* -------------------------------------------------------------------------- */
/* Auth                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Signs in the way the emdash CLI does, so the engine is an ordinary API client
 * rather than something with special access. A token is preferred; the local
 * dev-bypass exists only on a dev server and only for development.
 */
async function session(baseUrl: string): Promise<{ cookie: string; headers: Record<string, string> }> {
	const token = process.env.EMDASH_TOKEN;
	if (token) {
		return {
			cookie: "",
			headers: {
				authorization: `Bearer ${token}`,
				"X-EmDash-Request": "1",
				"content-type": "application/json",
			},
		};
	}
	const res = await fetch(`${baseUrl}/_emdash/api/setup/dev-bypass`, { redirect: "manual" });
	if (!res.ok) {
		throw new Error(
			`no EmDash session: dev-bypass returned ${res.status}. Set EMDASH_TOKEN for a remote instance.`,
		);
	}
	const cookie = (res.headers.get("set-cookie") ?? "")
		.split(/,(?=[^;]+?=)/)
		.map((c) => c.split(";")[0].trim())
		.filter(Boolean)
		.join("; ");
	if (!cookie.includes("astro-session")) throw new Error("dev-bypass issued no session cookie");
	return {
		cookie,
		headers: {
			cookie,
			// EmDash's same-origin CSRF proof. Without it every state-changing
			// request is rejected.
			"X-EmDash-Request": "1",
			"content-type": "application/json",
		},
	};
}

/* -------------------------------------------------------------------------- */
/* hunt                                                                      */
/* -------------------------------------------------------------------------- */

const ASSET_EXTENSIONS =
	/\.(png|jpe?g|gif|webp|avif|svg|webm|mp4|mov|glb|gltf|blend|wav|mp3|ogg|flac|ttf|otf|woff2?|glsl|frag|vert|hlsl|shader)$/i;

/** Source files count as evidence: a procedural-audio repo shows its technique in code. */
const SOURCE_EXTENSIONS = /\.(py|js|mjs|ts|tsx|jsx|cpp|cc|c|h|rs|rb|cs|lua|d|zig)$/i;

const PER_PAGE = 30;

async function cmdHunt(briefPath: string, baseUrl: string) {
	const brief = loadBrief(briefPath);
	const github = new GitHub();
	const waves = loadWaves(engineRoot);
	const maxCandidates = brief.constraints?.maxCandidates ?? 25;
	const minStars = brief.constraints?.minStars ?? 0;
	const excluded = new Set((brief.constraints?.excludeTopics ?? []).map((t) => t.toLowerCase()));

	console.log(`\nHunt — ${brief.intent}`);
	console.log(`  brief        ${briefFingerprint(brief)}  (${brief.verticals.join(", ")})`);
	console.log(`  credentials  ${github.authenticated ? "GITHUB_TOKEN" : "none — unauthenticated, slow"}`);
	console.log(`  limit        ${maxCandidates} candidates\n`);

	const queue: SearchHit[] = [];
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
			try {
				hits = await github.search(buildQuery(query, brief), PER_PAGE, page);
			} catch (err) {
				if (err instanceof GitHubError) {
					console.error(`  ✖ ${query} p${page}: ${err.message}`);
					break;
				}
				throw err;
			}
			const kept = hits.filter(
				(h) =>
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
				`  ${query} p${page} — ${hits.length} hits, ${kept.length} kept${below ? ` (${below} under ${minStars} stars)` : ""}`,
			);
			queue.push(...kept);
			if (hits.length < PER_PAGE) break;
			page++;
		}
	}

	const unique = [...new Map(queue.map((h) => [h.fullName, h])).values()].slice(0, maxCandidates);
	console.log(`\n  inspecting ${unique.length} repositories\n`);

	for (const hit of unique) {
		try {
			await inspect(github, hit, brief);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`  ✖ ${hit.fullName}: ${message}`);
		}
	}

	const candidates = [...loadCandidates(engineRoot).values()];
	const s = summarise(candidates);
	console.log("\nRecorded");
	console.log(`  candidates   ${s.total}`);
	console.log(`  files read   ${s.readFiles}`);
	console.log(`  asset-scoped ${s.assetScoped} (a licence beside the asset, not just the repo)`);
	for (const [status, n] of Object.entries(s.byStatus)) {
		console.log(`  ${status.padEnd(12)}${n}`);
	}
	if (github.rateLimited) {
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
	void baseUrl;
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

/** Reads one repository: pin a commit, list the tree, read what is worth reading. */
async function inspect(github: GitHub, hit: SearchHit, brief: HuntBrief) {
	const ref = await github.resolve(hit.fullName);
	const tree = await github.tree(ref);
	const paths = tree.map((n) => n.path);

	// The licence first: it decides how everything else in the repository is
	// described, so it is read before any classification is formed.
	const licencePath = pickLicenceFile(paths);
	const licenceFile = licencePath ? await github.file(ref, licencePath) : null;

	// Asset-scoped licence: a licence sitting beside an asset is the only
	// evidence that speaks about the asset rather than the repository.
	const assetPaths = paths.filter((p) => ASSET_EXTENSIONS.test(p) && isWorthReading(p, 0));
	const sourcePaths = paths.filter(
		(p) => SOURCE_EXTENSIONS.test(p) && !/\.(test|spec)\./i.test(p) && isWorthReading(p, 0),
	);
	// Media first, then source: a repository that ships both demonstrates the
	// technique twice, and the media is the more direct evidence of it.
	const sample = [...assetPaths.slice(0, 3), ...sourcePaths.slice(0, 2)];

	let assetEvidence: { text: string; path: string; url: string | null } | null = null;
	for (const candidate of sample) {
		const near = assetLicenceFor(paths, candidate);
		if (!near) continue;
		const file = await github.file(ref, near);
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

	// Read a bounded set of assets so the classification has something concrete
	// behind it. These are bytes for hashing, never for execution.
	const files: FileEvidence[] = [];
	for (const path of sample) {
		const file = await github.file(ref, path);
		if (!file) continue;
		files.push({
			path,
			size: file.size,
			sha256: (await import("node:crypto")).createHash("sha256").update(file.content).digest("hex"),
			blobUrl: file.url || null,
			kind: kindFor(path),
		});
	}
	if (licenceFile) {
		files.push({
			path: licencePath as string,
			size: licenceFile.size,
			sha256: (await import("node:crypto"))
				.createHash("sha256")
				.update(licenceFile.content)
				.digest("hex"),
			blobUrl: licenceFile.url,
			kind: "licence",
		});
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
		firstSeen: now,
		lastSeen: now,
		observations: 1,
	};
	const { isNew } = recordCandidate(engineRoot, candidate);
	console.log(
		`  ${isNew ? "+" : "↻"} ${hit.fullName.padEnd(42)} ${classification.status.padEnd(11)} ${files.length} files`,
	);
	void brief;
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
	/** Things that happened which a person should look at. */
	notices: string[];
}

async function cmdSync(baseUrl: string, dryRun: boolean) {
	const payload = readPayload();
	const validation = validatePayload(payload);
	if (!validation.ok) {
		console.error("✖ payload failed its invariants; refusing to write");
		for (const problem of validation.problems) console.error(`  ${problem}`);
		process.exit(1);
	}

	const { headers } = await session(baseUrl);
	const report: SyncReport = {
		created: [],
		updated: [],
		unchanged: [],
		failed: [],
		preserved: [],
		notices: [],
	};

	for (const possibility of payload.possibilities) {
		try {
			const existing = await readEntry(baseUrl, headers, "possibilities", possibility.slug);
			// The merge policy decides what to write. The CLI does not.
			const merge = mergePossibility(existing?.data ?? null, possibility.data);
			report.preserved.push(...merge.preserved.map((f) => `${possibility.slug}.${f}`));
			report.notices.push(...merge.notes.map((n) => `${possibility.slug}: ${n}`));

			if (existing && !Object.keys(merge.write).length) {
				report.unchanged.push(possibility.slug);
			} else if (dryRun) {
				(existing ? report.updated : report.created).push(
					`${possibility.slug} (${merge.changed.join(", ") || "no fields"})`,
				);
			} else {
				await writeEntry(
					baseUrl,
					headers,
					"possibilities",
					possibility.slug,
					merge.write,
					existing?._rev ?? null,
					// A new machine entry is created as a draft: a crawl does not
					// decide what the public catalogue shows.
					!existing ? false : shouldPublish(existing.data ?? null),
				);
				(existing ? report.updated : report.created).push(
					`${possibility.slug} (${merge.changed.join(", ")})`,
				);
			}

			for (const example of possibility.examples) {
				const current = await readEntry(baseUrl, headers, "examples", example.slug);
				const exampleMerge = mergeExample(current?.data ?? null, example.data);
				report.notices.push(...exampleMerge.notes.map((n) => `${example.slug}: ${n}`));
				if (dryRun) continue;
				if (!Object.keys(exampleMerge.write).length && current) continue;
				await writeEntry(
					baseUrl,
					headers,
					"examples",
					example.slug,
					exampleMerge.write,
					current?._rev ?? null,
					!current ? false : shouldPublish(current.data ?? null),
				);
			}
		} catch (err) {
			report.failed.push({
				slug: possibility.slug,
				error: err instanceof Error ? err.message : String(err),
			});
		}
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
		for (const f of report.failed.slice(0, 5)) console.error(`    ✖ ${f.slug}: ${f.error}`);
		process.exitCode = 1;
		return;
	}
	console.log(dryRun ? "\n✔ dry run complete" : "\n✔ catalogue reconciled with the payload");
}

/**
 * Writes an entry.
 *
 * Creation POSTs to the collection and carries the slug in the body; update PUTs
 * to the item. Posting to the item path returns 401 rather than 405, which reads
 * like an auth failure and sends you looking for a session problem.
 */
async function writeEntry(
	baseUrl: string,
	headers: Record<string, string>,
	collection: string,
	slug: string,
	data: Record<string, unknown>,
	rev: string | null,
	publish: boolean,
) {
	const url = rev
		? `${baseUrl}/_emdash/api/content/${collection}/${slug}`
		: `${baseUrl}/_emdash/api/content/${collection}`;
	const body: Record<string, unknown> = rev ? { data, _rev: rev } : { slug, data };
	const res = await fetch(url, {
		method: rev ? "PUT" : "POST",
		headers,
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`write ${collection}/${slug} → HTTP ${res.status} ${detail.slice(0, 140)}`);
	}
	if (publish) {
		const published = await fetch(
			`${baseUrl}/_emdash/api/content/${collection}/${slug}/publish`,
			{ method: "POST", headers },
		);
		if (!published.ok) {
			throw new Error(`publish ${collection}/${slug} → HTTP ${published.status}`);
		}
	}
}

/** Fields worth comparing, so a metadata timestamp never looks like a change. */
const diffableFields = (data: Record<string, unknown>) =>
	Object.keys(data).filter(
		(key) => !["id", "createdAt", "updatedAt", "publishedAt", "version", "_rev"].includes(key),
	);

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || a === undefined || b === null || b === undefined) return a == b;
	// EmDash stores booleans as 0/1 and numbers as strings in some paths.
	return String(a) === String(b);
}

interface EntryResponse {
	data?: Record<string, unknown>;
	_rev?: string;
}

/**
 * Reads one entry.
 *
 * The content API nests the record at `data.item.data` and the revision token at
 * `data.item._rev`; reading `data.data` returns an empty object, which looks
 * exactly like "the entry has no fields" and makes every merge look like a
 * creation.
 */
async function readEntry(
	baseUrl: string,
	headers: Record<string, string>,
	collection: string,
	slug: string,
): Promise<EntryResponse | null> {
	const res = await fetch(`${baseUrl}/_emdash/api/content/${collection}/${slug}`, { headers });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`read ${collection}/${slug} → HTTP ${res.status}`);
	const body = (await res.json()) as { success?: boolean; data?: { item?: EntryResponse } };
	const item = body.data?.item;
	if (!body.success || !item) return null;
	return { data: item.data ?? {}, _rev: item._rev };
}

/* -------------------------------------------------------------------------- */
/* verify                                                                    */
/* -------------------------------------------------------------------------- */

async function cmdVerify(baseUrl: string) {
	const payload = readPayload();
	const validation = validatePayload(payload);
	if (!validation.ok) {
		console.error("✖ payload invariants failed:");
		for (const problem of validation.problems) console.error(`  ${problem}`);
		process.exit(1);
	}
	const { headers } = await session(baseUrl);
	let checked = 0;
	const problems: string[] = [];

	for (const possibility of payload.possibilities) {
		const entry = await readEntry(baseUrl, headers, "possibilities", possibility.slug);
		checked++;
		if (!entry) {
			problems.push(`${possibility.slug}: in the payload but not in the catalogue`);
			continue;
		}
		for (const [field, value] of Object.entries(possibility.data)) {
			if (!sameValue(entry.data?.[field], value)) {
				problems.push(
					`${possibility.slug}.${field}: catalogue has ${JSON.stringify(entry.data?.[field])}, payload has ${JSON.stringify(value)}`,
				);
			}
		}
	}

	console.log(`\nVerify ${payload.fingerprint}`);
	console.log(`  checked     ${checked} possibilities against the live catalogue`);
	if (problems.length) {
		console.error(`  mismatched  ${problems.length}`);
		for (const p of problems.slice(0, 20)) console.error(`    ✖ ${p}`);
		process.exitCode = 1;
		return;
	}
	console.log("\n✔ the catalogue matches the payload");
}

function readPayload(): PublishPayload {
	if (!existsSync(payloadPath)) {
		console.error(`✖ no payload at ${payloadPath}. Run \`hunt\` first.`);
		process.exit(1);
	}
	return JSON.parse(readFileSync(payloadPath, "utf8")) as PublishPayload;
}

/* -------------------------------------------------------------------------- */

const [, , command, ...rest] = process.argv;
const baseUrl = rest.includes("--url")
	? rest[rest.indexOf("--url") + 1]
	: "http://localhost:4321";

try {
	if (command === "hunt") {
		await cmdHunt(rest[0] ?? "sfx.json", baseUrl);
	} else if (command === "sync") {
		await cmdSync(baseUrl, rest.includes("--dry-run"));
	} else if (command === "verify") {
		await cmdVerify(baseUrl);
	} else {
		console.log(`Asset Hunter hunt engine

  hunt <brief.json> [--limit N]   read a brief, crawl and record the evidence
  sync [--dry-run] [--url URL]    reconcile the payload into the catalogue
  verify [--url URL]              prove the catalogue matches the payload

  GITHUB_TOKEN  authenticated GitHub access (recommended)
  EMDASH_TOKEN  a token for a remote instance; a dev server uses dev-bypass
`);
		process.exitCode = command ? 1 : 0;
	}
} catch (err) {
	console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
}
