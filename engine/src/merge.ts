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
 * | rights dispute (#54)   | human, always          | engine writes nothing over it     |
 * | exclusion (#54)        | human, always          | engine does not write the entry   |
 *
 * The last row is the one that matters. A "cleared" claim that is no longer
 * justified is not a formatting difference.
 *
 * #54 adds two more rows, both of them refusals rather than conflicts. A dispute is
 * a person's decision about somebody else's work and a crawl has no standing to
 * change it in either direction — not to open one, not to close one, and not to put
 * a withheld download back because the licence evidence still permits it. An
 * exclusion is a takedown, and the engine's obligation is not to re-ingest what has
 * been taken down; both are refusals, so they are checked before anything is
 * written rather than merged into what is.
 *
 * Pure functions, no I/O, so the policy is testable on its own and the CLI is
 * left with nothing to decide.
 */

import { ENGINE_OWNED_FIELDS, HUMAN_OWNED_FIELDS } from "./publish.ts";
import { exclusionForExample, type Exclusion } from "./exclusions.ts";

export type Visibility = "draft" | "published" | "hidden";

/**
 * What a run knows about standing exclusions (#54).
 *
 * Passed rather than read from a global so the policy stays a pure function: the
 * same merge decided against an empty list and against a list carrying a takedown
 * can be compared in one test, which is the whole of #54's "an exclusion must
 * survive a refresh" criterion.
 */
export interface MergeOptions {
	/** Exclusions read from EmDash before the run. Lifted ones are filtered out. */
	exclusions?: readonly Exclusion[];
}

const activeExclusions = (options: MergeOptions | undefined): readonly Exclusion[] =>
	(options?.exclusions ?? []).filter((exclusion) => exclusion.active);

/**
 * Whether a rights dispute is live on a record (#54).
 *
 * The same rule as the app's `withholdsAsset`, written out rather than imported
 * because `docs/ARCHITECTURE.md` requires the engine not to import app code. Two
 * cases matter and the first is the one that would be easy to get wrong: an example
 * with **no** dispute recorded is not in dispute — every example in the catalogue
 * has no dispute until somebody files one — while a state this build cannot read
 * still withholds, because it is not evidence that the dispute was resolved.
 */
const isDisputed = (value: unknown): boolean => {
	const state = typeof value === "string" ? value.trim() : "";
	if (!state) return false;
	return state !== "corrected" && state !== "dismissed";
};

export interface MergeResult {
	/**
	 * Exactly the fields the engine decided to change. Absent means "leave
	 * alone". Used for the report and for the tests.
	 */
	write: Record<string, unknown>;
	/**
	 * The complete record to send: the existing values with `write` applied over
	 * them.
	 *
	 * EmDash's PUT validates the whole record, so sending only the changed
	 * fields fails with "title: expected string, received undefined" on any
	 * entry whose title happened to be unchanged. Sending the merged record is
	 * also the honest thing: the policy decided the final state of every field,
	 * so the whole state is what gets written.
	 */
	merged: Record<string, unknown>;
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
	options: MergeOptions = {},
): MergeResult {
	// `merged` starts as a copy of the incoming record and is filled in as the
	// policy decides each field; `write` is the subset that actually differs.
	const result: MergeResult = { write: {}, merged: {}, preserved: [], changed: [], notes: [] };

	if (!existing) {
		// Creation. The engine supplies an initial rank of 0 so a new machine
		// entry sorts to the end of the wall instead of competing with curated
		// work, and `draft` visibility so nothing unreviewed is public.
		const record = { ...incoming, editorial_rank: 0, featured: false, visibility: "draft" };
		return {
			write: record,
			merged: record,
			preserved: [],
			changed: Object.keys(record),
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

	// Excluded sources, at the entry level (#54). The examples are already refused
	// individually by `mergeExample`; this is about what the *entry* claims. If every
	// source behind it has been excluded, the entry is not rewritten at all: a crawl
	// that keeps refreshing an entry whose whole provenance has been taken down is
	// re-asserting a claim somebody asked us to withdraw. If only some are excluded,
	// the entry is written as usual and the count is reported, because the remaining
	// sources are still evidence.
	const sources = sourceIdsOf(incoming);
	if (sources.length) {
		const exclusions = activeExclusions(options);
		const excluded = sources.filter((fullName) =>
			exclusions.some(
				(exclusion) =>
					exclusion.scope === "repository" && exclusion.match === fullName.toLowerCase(),
			),
		);
		if (excluded.length === sources.length) {
			result.write = {};
			result.changed = [];
			result.notes = [
				`not written: every source behind this entry is excluded from ingestion (${excluded.join(", ")})`,
			];
		} else if (excluded.length) {
			result.notes.push(
				`${excluded.length} of ${sources.length} source(s) are excluded from ingestion (${excluded.join(", ")}); the rest still stand as evidence`,
			);
		}
	}

	result.merged = { ...existing, ...result.write };
	return result;
}

/** The repositories an incoming possibility was built from, from `source_ids`. */
const sourceIdsOf = (incoming: Record<string, unknown>): string[] =>
	String(incoming.source_ids ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);

/** The same policy for an example, with one extra rule about downloads. */
export function mergeExample(
	existing: Record<string, unknown> | null,
	incoming: Record<string, unknown>,
	options: MergeOptions = {},
): MergeResult {
	// --- A takedown outranks this run entirely (#54) -----------------------------
	//
	// Checked before anything else, including before the "is this new?" branch. An
	// excluded resource must not be *created* on a later run either: a crawl that
	// re-ingested something a creator asked to be removed would be doing the exact
	// thing the request stopped, and doing it silently.
	if (activeExclusions(options).length) {
		const exclusion = exclusionForExample(activeExclusions(options), {
			slug: String(incoming.source_id ?? incoming.slug ?? ""),
			sourceRepo: (incoming.source_repo as string | null) ?? null,
			sourcePath: (incoming.source_path as string | null) ?? null,
			contentHash: (incoming.content_hash as string | null) ?? null,
		});
		if (exclusion) {
			return {
				write: {},
				// The existing record, untouched. Nothing is deleted either: the
				// evidence a correction is made from stays exactly where it is.
				merged: existing ?? {},
				preserved: existing ? Object.keys(existing) : [],
				changed: [],
				notes: [
					`not written: this example is excluded from ingestion — ${exclusion.scope} ${exclusion.match}`,
				],
			};
		}
	}

	if (!existing) {
		const record = { ...incoming, featured: false, visibility: "draft" };
		return {
			write: record,
			merged: record,
			preserved: [],
			changed: Object.keys(record),
			notes: ["created as a draft"],
		};
	}
	const result: MergeResult = { write: {}, merged: {}, preserved: [], changed: [], notes: [] };
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

	// An open rights dispute holds the download off whatever the licence says
	// (#54). The gate that refuses the bytes lives in `src/lib/asset-use.ts` and
	// reads `dispute_state`; this is the belt to that braces, because
	// `downloadable` is what every other surface — the JSON contract, the use page,
	// an agent reading the record — takes as "this deployment will hand it over".
	// A refresh must not be the thing that puts it back.
	if (isDisputed(existing.dispute_state) && (existing.downloadable === true || existing.downloadable === 1)) {
		result.write.downloadable = false;
		result.changed.push("downloadable");
		result.notes.push(
			`download disabled: a rights dispute is open on this example (${String(existing.dispute_state)}), whatever the licence evidence says`,
		);
	}

	// A dispute is a human decision and the machine does not get to touch it. Not
	// listed among the written fields above at all, and reported as preserved so a
	// curator reading the run log can see it was considered rather than missed.
	for (const field of ["featured", "visibility"]) {
		if (field in existing) result.preserved.push(field);
	}
	for (const field of DISPUTE_FIELDS) {
		if (field in existing) result.preserved.push(field);
	}
	if (isDisputed(existing.dispute_state)) {
		result.notes.push(
			"this example is quarantined: its dispute state is preserved and nothing here can release it",
		);
	}
	result.merged = { ...existing, ...result.write };
	return result;
}

/**
 * The dispute fields on an example (#54).
 *
 * A person's decision, recorded on the record. The engine writes machine facts about
 * what a source says; it never writes whether somebody has complained about it, and
 * it never clears the complaint. A refresh that could un-quarantine an example would
 * make the whole withdrawal depend on nobody running a crawl.
 */
const DISPUTE_FIELDS = [
	"dispute_state",
	"dispute_reason",
	"dispute_note",
	"dispute_reported_at",
	"dispute_resolved_at",
] as const;

/** Whether an entry should be published after a merge. */
export function shouldPublish(existing: Record<string, unknown> | null): boolean {
	return String(existing?.visibility ?? "draft") === "published";
}
