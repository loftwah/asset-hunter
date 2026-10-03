/**
 * The publish contract.
 *
 * `docs/ARCHITECTURE.md` specifies the boundary; this is the code that enforces
 * it. Everything crossing from the engine into the catalogue is a
 * `PublishPayload`, and the payload is validated before it is applied rather
 * than trusted because the engine produced it.
 *
 * Three properties make the sync step safe to run repeatedly:
 *
 * 1. **Deterministic.** The same evidence produces a byte-identical payload, so
 *    two runs can be diffed and a re-run is a no-op.
 * 2. **Idempotent.** Applying it twice writes the same entries, with the same
 *    slugs, and does not create duplicates.
 * 3. **Field-ownership aware.** The engine writes the fields it owns and leaves
 *    the human ones alone. `editorial_rank`, `featured`, `image`, `build_notes`
 *    and `prompt_scaffold` are editorial decisions; a crawl that overwrites them
 *    would destroy the difference between a curated catalogue and a dump.
 */

import { createHash } from "node:crypto";
import type { ExtractedPossibility } from "./possibility.ts";

/** Fields a person owns. The publisher must never write them. */
export const HUMAN_OWNED_FIELDS = [
	"editorial_rank",
	"featured",
	"image",
	"build_notes",
	"prompt_scaffold",
] as const;

/** Fields the engine owns. Everything written must come from this list. */
export const ENGINE_OWNED_FIELDS = [
	"title",
	"tagline",
	"summary",
	"technique",
	"vertical",
	"media_kind",
	"representative_origin",
	"rights_status",
	"rights_note",
	"example_count",
	"distinct_sources",
	"novelty",
	"coverage",
] as const;

/**
 * Sync bookkeeping, required by #40 so a record can be traced back to the hunt
 * that produced it and a re-run can be proven to be a no-op.
 */
export const SYNC_FIELDS = [
	"source_hunt",
	"source_ids",
	"source_revision",
	"machine_synced_at",
] as const;

export interface PublishExample {
	slug: string;
	data: Record<string, unknown>;
	/** The possibility this example belongs to, by slug. */
	possibility: string;
}

export interface PublishPossibility {
	slug: string;
	data: Record<string, unknown>;
	examples: PublishExample[];
}

export interface PublishCollection {
	slug: string;
	data: Record<string, unknown>;
	members: string[];
}

export interface PublishPayload {
	version: 1;
	/** Hash of the evidence, so the payload identifies what produced it. */
	fingerprint: string;
	possibilities: PublishPossibility[];
	collections: PublishCollection[];
}

export interface ValidationResult {
	problems: string[];
	ok: boolean;
}

const VALID_RIGHTS = new Set(["cleared", "attribution", "review", "reference"]);
const VALID_ORIGINS = new Set(["upstream", "derived", "generated", "none"]);

/**
 * Validates a payload against the honesty invariants from
 * `docs/ARCHITECTURE.md`. These are the rules that stop plausible-looking
 * fabricated evidence from reaching the public catalogue, so they are checked
 * here, once, rather than trusted from the producer.
 */
export function validatePayload(payload: PublishPayload): ValidationResult {
	const problems: string[] = [];
	const seen = new Set<string>();

	for (const p of payload.possibilities) {
		if (seen.has(p.slug)) problems.push(`duplicate possibility slug: ${p.slug}`);
		seen.add(p.slug);

		for (const field of HUMAN_OWNED_FIELDS) {
			if (field in p.data) {
				problems.push(
					`${p.slug}: engine payload carries "${field}", which a person owns — it would overwrite an editorial decision`,
				);
			}
		}
		for (const key of Object.keys(p.data)) {
			if (
				!(ENGINE_OWNED_FIELDS as readonly string[]).includes(key) &&
				!(SYNC_FIELDS as readonly string[]).includes(key)
			) {
				problems.push(`${p.slug}: "${key}" is not an engine-owned field`);
			}
		}

		if (!VALID_RIGHTS.has(String(p.data.rights_status))) {
			problems.push(
				`${p.slug}: rights_status "${p.data.rights_status}" is not one of ${[...VALID_RIGHTS].join(", ")}`,
			);
		}
		if (!VALID_ORIGINS.has(String(p.data.representative_origin))) {
			problems.push(
				`${p.slug}: representative_origin "${p.data.representative_origin}" is not one of ${[...VALID_ORIGINS].join(", ")}`,
			);
		}
		if (typeof p.data.vertical !== "string" || !p.data.vertical) {
			problems.push(`${p.slug}: vertical is required — a possibility has to be filed somewhere`);
		}
		if (typeof p.data.summary !== "string" || !(p.data.summary as string).trim()) {
			problems.push(`${p.slug}: summary is required`);
		}

		// The count of verified sources must not exceed the number of examples,
		// and must be 0 when no example has a licence that was actually read.
		const verified = p.examples.filter(
			(e) => e.data.rights_status === "cleared" || e.data.rights_status === "attribution",
		).length;
		if (Number(p.data.distinct_sources) > verified) {
			problems.push(
				`${p.slug}: distinct_sources is ${p.data.distinct_sources} but only ${verified} example(s) have a readable licence`,
			);
		}
		if (p.examples.length === 0 && Number(p.data.distinct_sources) !== 0) {
			problems.push(`${p.slug}: distinct_sources must be 0 with no examples`);
		}

		// A machine observation is null or a number. Never a string, and never a
		// number that was invented to look plausible.
		for (const field of ["novelty", "coverage"] as const) {
			const value = p.data[field];
			if (value !== null && typeof value !== "number") {
				problems.push(`${p.slug}: ${field} must be a number or null, got ${typeof value}`);
			}
		}

		for (const e of p.examples) {
			if (e.possibility !== p.slug) {
				problems.push(`${e.slug}: points at "${e.possibility}" but lives under "${p.slug}"`);
			}
			if (!VALID_RIGHTS.has(String(e.data.rights_status))) {
				problems.push(`${e.slug}: rights_status "${e.data.rights_status}" is not a known status`);
			}
			if (e.data.origin === "upstream" && !e.data.source_repo) {
				problems.push(
					`${e.slug}: claims to be upstream media with no source repository — an upstream example must name where it came from`,
				);
			}
			if (e.data.licence_spdx && !e.data.licence_evidence) {
				problems.push(`${e.slug}: declares ${e.data.licence_spdx} with no recorded evidence`);
			}
		}
	}

	return { problems, ok: problems.length === 0 };
}

const exampleSlug = (possibilitySlug: string, fullName: string, ref: string) =>
	`${possibilitySlug}--${fullName.replace("/", "-").toLowerCase()}-${ref.slice(0, 7)}`;

/** Builds the payload. Pure: same input, same bytes. */
export function buildPayload(
	possibilities: ExtractedPossibility[],
	collections: { slug: string; title: string; tagline: string | null; summary: string | null; members: string[] }[] = [],
	context: { huntId?: string; syncedAt?: string } = {},
): PublishPayload {
	// A fixed timestamp when the caller does not supply one keeps the payload
	// byte-identical across runs, which is what makes `verify` meaningful.
	const syncedAt = context.syncedAt ?? "1970-01-01T00:00:00.000Z";
	const built: PublishPossibility[] = possibilities
		.map((p) => ({
			slug: p.slug,
			data: {
				title: p.title,
				tagline: p.tagline ?? null,
				summary: p.summary,
				technique: p.technique,
				vertical: p.vertical,
				media_kind: p.mediaKind,
				/*
				 * `generated` only when a plate was actually generated.
				 *
				 * This was hard-coded, and it was a false provenance claim: the engine
				 * records what it *read*, not what it *rendered*, so a crawled entry
				 * arrived saying its representative was newly generated while carrying no
				 * representative at all. `DESIGN.md` and `docs/ARCHITECTURE.md` both say the
				 * origin is what keeps generated and upstream material distinguishable, so
				 * a hard-coded value there removes the guarantee for every discovered entry
				 * at once.
				 *
				 * So: `none`, with its own meaning in the app's vocabulary, and the tile,
				 * the use page and the JSON contract all say "no representative media yet"
				 * rather than implying one exists. When a plate is generated for a crawled
				 * entry later (#34), this becomes `generated` and says so again.
				 */
				representative_origin: "none",
				rights_status: worstRights(p.examples.map((e) => e.rightsStatus)),
				rights_note: rightsNoteFor(p),
				example_count: p.examples.length,
				distinct_sources: p.distinctSources,
				novelty: p.novelty,
				coverage: p.coverage,
				// Sync bookkeeping.
				source_hunt: context.huntId ?? null,
				source_ids: p.examples.map((e) => e.fullName).join(",").slice(0, 500),
				source_revision: p.examples.map((e) => e.ref.slice(0, 12)).join(",").slice(0, 500),
				machine_synced_at: syncedAt,
			},
			examples: p.examples
				.map((e) => ({
					slug: exampleSlug(p.slug, e.fullName, e.ref),
					possibility: p.slug,
					data: {
						title: e.fullName,
						origin: e.origin,
						media_kind: e.mediaKind,
						specimen: null,
						rights_status: e.rightsStatus,
						rights_note: e.note,
						source_url: e.htmlUrl,
						source_repo: e.fullName,
						source_ref: e.ref,
						licence_spdx: e.licenceSpdx,
						licence_evidence: e.licenceEvidence,
						attribution: e.attribution,
						content_hash: e.contentHash,
						// A repository reference is not a redistributable file, so
						// nothing from a crawl is offered as a download.
						downloadable: false,
						source_id: e.fullName,
						source_revision: e.ref,
						source_hash: e.contentHash,
						machine_synced_at: syncedAt,
					},
				}))
				.sort((a, b) => a.slug.localeCompare(b.slug)),
		}))
		.sort((a, b) => a.slug.localeCompare(b.slug));

	const fingerprint = createHash("sha256")
		.update(JSON.stringify(built))
		.digest("hex")
		.slice(0, 16);

	return {
		version: 1,
		fingerprint,
		possibilities: built,
		collections: collections
			.map((c) => ({
				slug: c.slug,
				data: { title: c.title, tagline: c.tagline ?? null, summary: c.summary ?? null },
				members: [...c.members].sort(),
			}))
			.sort((a, b) => a.slug.localeCompare(b.slug)),
	};
}

/**
 * The weakest rights status in the group.
 *
 * A possibility's status is the *floor* across its examples, not the best one.
 * A catalogue entry that says "cleared" because one of five sources was MIT
 * while the other four had no licence at all is exactly the false certainty
 * this product is built to avoid.
 *
 * A status that is not one of the four counts as `reference` — the weakest thing
 * there is. That direction is the same one the app's `weakestRights` and
 * `useStateFor` take, and it matters here because `validatePayload` refuses an
 * unknown status *after* this runs: an entry built from a status this build
 * cannot read must not be described as cleared on its way to being rejected.
 * `tests/takedown.test.ts` asserts the two implementations agree, because the
 * architecture keeps them in separate systems.
 */
export function worstRights(statuses: string[]): string {
	const order = ["cleared", "attribution", "review", "reference"];
	if (!statuses.length) return "reference";
	return statuses.reduce((worst, s) => {
		const index = order.indexOf(s);
		if (index === -1) return "reference";
		return order.indexOf(worst) > index ? worst : s;
	}, "cleared");
}

function rightsNoteFor(p: ExtractedPossibility): string {
	const counts = new Map<string, number>();
	for (const e of p.examples) counts.set(e.rightsStatus, (counts.get(e.rightsStatus) ?? 0) + 1);
	const breakdown = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([status, n]) => `${n} ${status}`)
		.join(", ");
	return `Weakest status across ${p.examples.length} example(s): ${breakdown}. Rights attach to an example, never to the possibility.`;
}
