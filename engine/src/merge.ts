/**
 * The merge policy.
 *
 * Issue #40 asks for an explicit merge policy rather than last-write-wins, and
 * this is it. Last-write-wins is wrong here in a specific, damaging way: a hunt
 * runs, finds a repository, writes a title derived from a README, and a curator
 * who spent twenty minutes writing a better one loses it. The other direction
 * matters just as much — a licence that has *worsened* upstream must reach the
 * public page even though a human has already reviewed the entry.
 *
 * So the policy is per field, not per record:
 *
 * | Field class            | Who writes it          | On conflict                       |
 * | ---------------------- | ---------------------- | --------------------------------- |
 * | machine factual        | engine                 | engine wins                       |
 * | editorial              | human                  | human wins, engine is told it was |
 * |                                        | skipped                           |
 * | visibility             | human                  | human wins; engine creates `draft`|
 * | rights regression      | engine, always         | engine wins, even over a human    |
 *
 * The last row is the one that matters. A "cleared" claim that is no longer
 * justified is not a formatting difference.
 *
 * Pure functions, no I/O, so the policy is testable on its own and the CLI is
 * left with nothing to decide.
 */

import { ENGINE_OWNED_FIELDS, HUMAN_OWNED_FIELDS } from "./publish.ts";

export type Visibility = "draft" | "published" | "hidden";

export interface MergeResult {
	/** Exactly the fields to write. Absent from the result means "leave alone". */
	write: Record<string, unknown>;
	/** Human-owned fields present in the incoming record that were not written. */
	preserved: string[];
	/** Fields the engine changed, for the report. */
	changed: string[];
	/** Things a reader should know happened, e.g. a rights regression. */
	notes: string[];
}

/** Ordered weakest-last, matching the catalogue's four statuses. */
const RIGHTS_ORDER = ["cleared", "attribution", "review", "reference"];

const isWeaker = (a: unknown, b: unknown): boolean =>
	RIGHTS_ORDER.indexOf(String(b)) > RIGHTS_ORDER.indexOf(String(a));

const same = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (a === null || a === undefined || b === null || b === undefined) return a == b;
	// EmDash round-trips booleans as 0/1 and numbers as strings in some paths,
	// so a string comparison is the honest one here.
	return String(a) === String(b);
};

/**
 * Merges an incoming possibility into the catalogue's copy.
 *
 * `existing` is null when the entry does not exist yet, which is the only case
 * where the engine is allowed to set the fields a human owns — on creation there
 * is no human decision to preserve, and leaving them null would put a
 * half-initialised entry in the admin.
 */
export function mergePossibility(
	existing: Record<string, unknown> | null,
	incoming: Record<string, unknown>,
): MergeResult {
	const result: MergeResult = { write: {}, preserved: [], changed: [], notes: [] };

	if (!existing) {
		// Creation. The engine supplies an initial rank of 0 so a new machine
		// entry sorts to the end of the wall instead of competing with curated
		// work, and `draft` visibility so nothing unreviewed is public.
		return {
			write: { ...incoming, editorial_rank: 0, featured: false, visibility: "draft" },
			preserved: [],
			changed: Object.keys(incoming),
			notes: ["created as a draft at rank 0; a human decides whether it is public"],
		};
	}

	// 1. Machine factual fields: the engine's answer is the current answer.
	for (const field of ENGINE_OWNED_FIELDS) {
		if (!(field in incoming)) continue;
		if (!same(existing[field], incoming[field])) {
			result.write[field] = incoming[field];
			result.changed.push(field);
		}
	}

	// 2. Sync bookkeeping, so an idempotent re-run is provably a no-op and the
	//    provenance of a record is readable from the record itself.
	//
	//    `machine_synced_at` is written only when something else changed.
	//    Recording "synced at" on a run that changed nothing makes every re-run
	//    a write, which is the opposite of idempotent and makes `verify` unable
	//    to tell a no-op from a real change.
	if (result.changed.length) {
		for (const field of ["source_hunt", "source_ids", "source_revision", "machine_synced_at"]) {
			if (field in incoming && !same(existing[field], incoming[field])) {
				result.write[field] = incoming[field];
				if (!result.changed.includes(field)) result.changed.push(field);
			}
		}
	} else {
		for (const field of ["source_hunt", "source_ids", "source_revision"]) {
			if (field in incoming && !same(existing[field], incoming[field])) {
				result.write[field] = incoming[field];
				result.changed.push(field);
			}
		}
	}

	// 3. Rights regression. A weaker status is written even though a human has
	//    reviewed the entry, because the review was of evidence that has since
	//    changed. The historical state is not lost: the licence evidence on the
	//    example keeps the quote and the hash it was read at.
	if (
		"rights_status" in incoming &&
		isWeaker(existing.rights_status, incoming.rights_status) &&
		!same(existing.rights_status, incoming.rights_status)
	) {
		result.write.rights_status = incoming.rights_status;
		if (!result.changed.includes("rights_status")) result.changed.push("rights_status");
		result.notes.push(
			`rights regressed from ${existing.rights_status} to ${incoming.rights_status}; the public page must not keep the stronger claim`,
		);
	}

	// 4. Anything a human owns is left exactly as it is, and reported as such.
	for (const field of HUMAN_OWNED_FIELDS) {
		if (field in existing) result.preserved.push(field);
	}
	if ("visibility" in existing) result.preserved.push("visibility");
	if (
		String(existing.visibility ?? "") === "published" &&
		String(incoming.rights_status ?? "") === "reference" &&
		existing.rights_status !== "reference"
	) {
		result.notes.push(
			"this entry is published and its examples are now reference-only; consider hiding it or replacing the representative",
		);
	}

	return result;
}

/** The same policy for an example, with one extra rule about downloads. */
export function mergeExample(
	existing: Record<string, unknown> | null,
	incoming: Record<string, unknown>,
): MergeResult {
	if (!existing) {
		return {
			write: { ...incoming, featured: false, visibility: "draft" },
			preserved: [],
			changed: Object.keys(incoming),
			notes: ["created as a draft"],
		};
	}
	const result: MergeResult = { write: {}, preserved: [], changed: [], notes: [] };
	const machineFields = [
		...ENGINE_OWNED_FIELDS,
		"origin",
		"note",
		"source_url",
		"source_repo",
		"source_ref",
		"source_path",
		"licence_spdx",
		"licence_evidence",
		"attribution",
		"content_hash",
		"media_kind",
		"specimen",
		"source_id",
		"source_revision",
		"source_hash",
	];
	for (const field of machineFields) {
		if (!(field in incoming)) continue;
		if (!same(existing[field], incoming[field])) {
			result.write[field] = incoming[field];
			result.changed.push(field);
		}
	}
	// `machine_synced_at` only moves when something real moved, for the same
	// idempotency reason as on the possibility.
	if (result.changed.length && "machine_synced_at" in incoming) {
		if (!same(existing.machine_synced_at, incoming.machine_synced_at)) {
			result.write.machine_synced_at = incoming.machine_synced_at;
			result.changed.push("machine_synced_at");
		}
	}

	// A download path is switched off the moment the licence stops justifying
	// it, and switched back on only when the evidence justifies it again. This
	// is the one field where the machine acts on a human's setting.
	const incomingRights = String(incoming.rights_status ?? "");
	const wasDownloadable = existing.downloadable === true || existing.downloadable === 1;
	if (!["cleared", "attribution"].includes(incomingRights) && wasDownloadable) {
		result.write.downloadable = false;
		result.changed.push("downloadable");
		result.notes.push(
			`download disabled: the licence evidence is now "${incomingRights}", which does not permit reuse`,
		);
	}
	if (["cleared", "attribution"].includes(incomingRights) && !wasDownloadable) {
		result.notes.push(
			`the licence evidence now permits reuse (${incomingRights}); download stays off until someone enables it`,
		);
	}

	for (const field of ["featured", "visibility"]) {
		if (field in existing) result.preserved.push(field);
	}
	return result;
}

/** Whether an entry should be published after a merge. */
export function shouldPublish(existing: Record<string, unknown> | null): boolean {
	return String(existing?.visibility ?? "draft") === "published";
}
