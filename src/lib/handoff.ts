/**
 * The implementation handoff (#51).
 *
 * Discovery ends with a choice, and this module is what the choice becomes. A
 * reader who has kept two or three possibilities on a board has, at that moment,
 * everything needed to build something and nothing that says how. The handoff is
 * the document that carries the decision across the gap: what to achieve, what
 * the chosen possibilities actually demonstrate, which of their examples may be
 * reused, and which must be looked at and not copied.
 *
 * ## Why this is not a second catalogue
 *
 * It reads the *same* records through the *same* loaders the pages and
 * `/api/catalogue.json` use (`loadPossibilities`, `loadExamplesFor`), and it
 * derives every use state through `useDecision` in `src/lib/asset-use.ts`, the
 * single place the rights-status → use-state mapping is made. There is no second
 * store, no shadow table and no second opinion: if the handoff and `/use/<slug>`
 * disagree about what a reader may do with an example, one of them has a bug and
 * both of them will fail together.
 *
 * It is also deliberately *selective*. The JSON catalogue answers "what does the
 * whole catalogue know", so it carries community ratings, machine observations,
 * editorial rank and every collection membership. None of that helps somebody
 * build the thing. This document carries what an implementation needs and drops
 * the rest — an implementation brief that ends with a dump of catalogue metadata
 * is a README of the CMS rather than a way to start work.
 *
 * ## Why it is called a handoff and not a brief
 *
 * `docs/VOCABULARY.md` exists because one concept must have one word, and
 * "brief" is already taken inside this repository: `engine/src/brief.ts` is the
 * operator's statement of intent *before* anything is crawled. This is the output
 * *after* a choice. Two opposite ends of the same process sharing one word is
 * exactly the collision the vocabulary file was written to prevent, so the
 * document is a **handoff** and the vocabulary file records why.
 *
 * ## The honesty rules, each of which is a refusal
 *
 * 1. **Possibility is not permission.** Every example carries its recorded
 *    rights status, the use state derived from it, the obligation that state
 *    imposes, and whether this deployment holds a payload for it. `doNotCopy` is
 *    derived from those same decisions, so the section and the reference list
 *    cannot tell an agent two different stories.
 * 2. **The weakest example decides the entry, and it is computed, not stored.**
 *    `examplesUseState` is derived from the examples themselves rather than
 *    copied from `possibility.rightsStatus`, so a stale or wrongly-set entry
 *    status cannot make a board of reference-only material look reusable.
 * 3. **`null` is not `0`, here either.** A field the reader never recorded is
 *    `null` and is named in `objective.unrecorded`. `decision.recorded` is
 *    `false` when nothing was marked chosen and `decision.chosen` is `null`
 *    rather than an empty array, because "no option was chosen" and "the choice
 *    was recorded as empty" are different facts and only one of them is reachable.
 * 4. **Nothing is invented.** No goal, no platform, no acceptance criteria are
 *    written for a reader who did not supply them. The catalogue knows what a
 *    possibility demonstrates; it does not know what you are building. The
 *    document names which parts are missing instead of filling them in.
 *
 * The serialisers, the rules above and the Markdown renderer are pure. The read
 * is the Effect at the bottom, so every honesty rule is testable without a
 * database, a clock or a request.
 */
import { DateTime, Effect } from "effect";
import { MAX_PER_BOARD, normaliseBoardName } from "./board.ts";
import {
	REFERENCE_CONCURRENCY,
	loadExamplesFor,
	loadPossibilities,
	mediaSrc,
	type Example,
	type Possibility,
} from "./catalogue.ts";
import { CATALOGUE_SCHEMA, fingerprint } from "./catalogue-json.ts";
import {
	assetUsePaths,
	selectionCreditText,
	summariseUse,
	summaryLine,
	useDecision,
	useStateFor,
	type HandoffBlock,
} from "./asset-use.ts";
import { EmDashContent, type EmDashReadError } from "./effect/emdash.ts";
import {
	MEDIA_LABEL,
	ORIGIN_MEANING,
	originLabelFor,
	rightsLabelFor,
	verticalLabel,
	type UseState,
} from "./vocabulary.ts";

/**
 * The version of this contract.
 *
 * `schema` is a version string, exactly as in `asset-hunter.catalogue/1`: a
 * field that disappears is a breaking change, a new field is not. Consumers read
 * what the version says is here.
 */
export const HANDOFF_SCHEMA = "asset-hunter.handoff/1";

/**
 * A recorded free-text field, capped.
 *
 * Trimmed, collapsed and capped at `MAX_FIELD_CHARS` because the value is
 * reflected back into the Markdown rendering and a 4KB address that produces a
 * 40KB document is a confusing way to fail. An empty or whitespace-only value is
 * `null`, never `""`, so "not recorded" and "recorded as blank" cannot both be
 * the same field.
 */
export const MAX_FIELD_CHARS = 400;

function field(value: string | null | undefined): string | null {
	const trimmed = (value ?? "").trim().replace(/\s+/gu, " ");
	if (!trimmed) return null;
	return trimmed.length > MAX_FIELD_CHARS ? `${trimmed.slice(0, MAX_FIELD_CHARS)}…` : trimmed;
}

/**
 * The paths this flow serves.
 *
 * `use`, `record` and `payload` come from `assetUsePaths` rather than being
 * written out again, so a change to one of those paths reaches the drill-in, the
 * use page, the asset-use routes, the handoff and the JSON contract at once.
 *
 * `json` and `markdown` both take the same bare query string and add their own
 * separators, so a self-referential address cannot come out as `?a=1format=md`.
 */

/** A query string without its leading `?`, whatever shape it arrived in. */
const bare = (query: string): string => query.replace(/^\?/, "");
export const handoffPaths = {
	/** The drill-in for one possibility. */
	possibility: (slug: string) => `/possibilities/${encodeURIComponent(slug)}`,
	/** The selection half, where the same use states are shown in words. */
	use: (slug: string) => assetUsePaths.use(slug),
	/** This document, as JSON. Takes a bare query string, with or without `?`. */
	json: (query = "") => `/api/handoff.json${query ? `?${bare(query)}` : ""}`,
	/** This document, as Markdown. The same fields, not a different document. */
	markdown: (query = "") =>
		`/api/handoff.json${query ? `?${bare(query)}&` : "?"}format=md`,
	/** The catalogue this was built from. */
	catalogue: () => "/api/catalogue.json",
} as const;

/** What a reader recorded about the work. Every field is optional. */
export interface HandoffObjective {
	/** What the work is for. Null when the reader did not say. */
	goal: string | null;
	/** What is being produced — a screen, a loop, a model, a font. */
	surface: string | null;
	/** Devices, platforms or runtimes the work has to hold on. */
	platform: string | null;
	/** Anything that rules the work out: budgets, formats, libraries. */
	constraints: string | null;
	/** What has to be shown for the work to count as done. */
	acceptance: string | null;
	/** Which of those five the reader left blank, by field name. */
	unrecorded: string[];
}

/** One example: where it came from, and what may be done with it. */
export interface HandoffExample {
	id: string;
	title: string;
	/** `upstream` | `derived` | `generated`, and what that means in words. */
	origin: string | null;
	originMeaning: string | null;
	/** The plate or image, referenced rather than inlined. Absolute. */
	preview: string | null;
	/** A fact about the licence, as recorded on this example. */
	rightsStatus: string | null;
	rightsLabel: string | null;
	rightsNote: string | null;
	/** The answer to "what may I do with this file". Derived, never stored. */
	useState: UseState;
	useStateLabel: string;
	useStateMeaning: string;
	obligation: string | null;
	/** What this deployment can hand over, and the rule that held it back. */
	handoff: "payload" | "record";
	blockedBy: HandoffBlock;
	provenance: {
		sourceUrl: string | null;
		sourceRepo: string | null;
		sourceRef: string | null;
		sourcePath: string | null;
		contentHash: string | null;
	};
	licence: { spdx: string | null; evidence: string | null };
	attribution: string | null;
	/** The `/api/record/<example>` document, absolute. Ungated by design. */
	record: string;
}

/** What the reader marked, as opposed to what they merely kept. */
export type HandoffDecision = "chosen" | "candidate" | "rejected";

/** One chosen possibility, with everything an implementer needs from it. */
export interface HandoffPossibility {
	id: string;
	title: string;
	tagline: string | null;
	summary: string;
	/** What the entry demonstrates and how it is built. Editorially written. */
	technique: string | null;
	buildNotes: string | null;
	/** The recreation recipe, where one was recorded. */
	recipe: string | null;
	decision: HandoffDecision;
	vertical: string | null;
	verticalLabel: string | null;
	mediaKind: string | null;
	media: string | null;
	preview: string | null;
	representativeOrigin: string | null;
	representativeOriginMeaning: string | null;
	/**
	 * The stored entry status. Weakest across the examples by contract, but it is
	 * the *stored* value — read `examplesUseState` for the answer computed from
	 * the examples themselves.
	 */
	rightsStatus: string | null;
	rightsLabel: string | null;
	rightsNote: string | null;
	/**
	 * The weakest use state across this entry's examples, computed here.
	 *
	 * Deliberately not `rightsStatus` re-spelled: deriving it from the examples
	 * means a stale entry status cannot make a board look cleared, and a test can
	 * assert that the weakest example is the one named.
	 */
	examplesUseState: UseState;
	url: string;
	useUrl: string;
	examples: HandoffExample[];
}

export interface HandoffDocument {
	schema: string;
	site: string;
	generated: string;
	/** Content digest of the references and the decision, not of the timestamp. */
	fingerprint: string;
	/** Where this came from and what else is in it. */
	contract: {
		json: string;
		markdown: string;
		catalogue: { schema: string; url: string };
	};
	board: {
		/** `slugs` when the slugs were named in the address, `cookie` from a board. */
		source: "slugs" | "cookie";
		name: string | null;
		requested: number;
		resolved: number;
		/** Named something the catalogue does not have. */
		unknown: string[];
		/** Asked for, cut by the per-board cap. */
		overflow: string[];
	};
	decision: {
		/** True only when the reader marked at least one option. */
		recorded: boolean;
		/** Null when nothing was marked, rather than an empty array. */
		chosen: string[] | null;
		rejected: string[];
	};
	objective: HandoffObjective;
	/** The prose a reader reads first. Derived; never invented. */
	achieve: string[];
	/** What must not be copied literally, worst first, from the use decisions. */
	doNotCopy: { subject: string; reason: string }[];
	possibilities: HandoffPossibility[];
	rights: {
		examples: number;
		byState: Record<UseState, number>;
		/** Retained originals this deployment will actually hand over. */
		payloads: number;
		/** One line naming each state that appears, worst first. */
		summary: string;
	};
	/** Every recorded credit in one block, or null when none is owed. */
	credits: string | null;
}

/* -------------------------------------------------------------------------- */
/* Input                                                                        */
/* -------------------------------------------------------------------------- */

/** What the caller asked for. Only the slugs or a board name are required. */
export interface HandoffRequest {
	/** Explicit possibility slugs. Wins over `board` when both are present. */
	slugs?: string[] | null;
	/** Which board of the reader's cookie to build from. */
	board?: string | null;
	/** Slugs the reader marked as the ones they are going with. */
	chose?: string[] | null;
	/** Slugs the reader ruled out. Recorded so the decision can be traced. */
	rejected?: string[] | null;
	goal?: string | null;
	surface?: string | null;
	platform?: string | null;
	constraints?: string | null;
	acceptance?: string | null;
}

/**
 * Splits a comma- or whitespace-separated slug list.
 *
 * `slugs=a,b` and `slugs=a%20b` are the two ways an address carries a list and
 * an agent will produce both. Empty entries are dropped rather than becoming a
 * slug that names nothing, because an empty string that 400s teaches less than
 * an address that works.
 */
export function parseSlugList(value: string | null | undefined): string[] {
	if (!value) return [];
	return [...new Set(value.split(/[\s,]+/u).map((s) => s.trim()).filter(Boolean))];
}

/** The same, over the array form the parameters arrive in. */
const slugList = (value: string[] | string | null | undefined): string[] =>
	(Array.isArray(value) ? value.flatMap((v) => parseSlugList(v)) : parseSlugList(value ?? null));

/**
 * Resolves which slugs a handoff is built from.
 *
 * A pure decision over the two inputs an address can carry, so the precedence is
 * testable without a request or a cookie: an explicit `slugs` list wins, a named
 * `board` falls back to the reader's own boards, and with neither there is no
 * handoff — which the route answers as a 400 saying how to ask, rather than
 * building a confident document about the empty selection.
 *
 * The board name goes through `normaliseBoardName`, the same function the board
 * page and the POST endpoint use, so there is one answer to "which board is
 * this" rather than one per caller.
 */
export function resolveHandoffSlugs(
	request: { slugs: string[]; board: string | null },
	boards: Record<string, string[]>,
): { slugs: string[]; source: "slugs" | "cookie"; name: string | null } | null {
	if (request.slugs.length > 0) {
		return { slugs: request.slugs, source: "slugs", name: null };
	}
	const name = normaliseBoardName(request.board);
	const fromBoard = boards[name];
	if (!fromBoard || fromBoard.length === 0) return null;
	return { slugs: fromBoard, source: "cookie", name };
}

/* -------------------------------------------------------------------------- */
/* Serialisation — pure                                                         */
/* -------------------------------------------------------------------------- */

/** Joins a site origin and a path. Absolute in the output. */
export function absolute(site: string, path: string | null): string | null {
	if (!path) return null;
	if (/^https?:\/\//i.test(path)) return path;
	return `${site.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The meaning of an origin, in words, or null.
 *
 * Falls back to the recorded value for an origin this vocabulary has not been
 * taught, the same rule as `originLabelFor` and `rightsLabelFor`: an unrecognised
 * word is still a fact about the record and hiding it would make an unknown
 * origin look like a missing field.
 */
function originMeaning(origin: string | null | undefined): string | null {
	if (!origin) return null;
	return ORIGIN_MEANING[origin as keyof typeof ORIGIN_MEANING] ?? origin;
}

function serialiseExample(site: string, example: Example): HandoffExample {
	const decision = useDecision(example);
	return {
		id: example.slug,
		title: example.title,
		origin: example.origin ?? null,
		originMeaning: originMeaning(example.origin),
		// `mediaSrc` with an empty fallback: an example with no plate has no
		// preview, and a handoff that shows `/specimens/placeholder.svg` as though
		// it were the thing is showing a lie about what there is to look at.
		preview: absolute(site, mediaSrc(example, "")),
		rightsStatus: decision.rightsStatus,
		rightsLabel: rightsLabelFor(decision.rightsStatus),
		rightsNote: example.rightsNote ?? null,
		useState: decision.state,
		useStateLabel: decision.label,
		useStateMeaning: decision.meaning,
		obligation: decision.obligation,
		handoff: decision.handoff.as,
		blockedBy: decision.handoff.blockedBy,
		provenance: {
			sourceUrl: example.sourceUrl ?? null,
			sourceRepo: example.sourceRepo ?? null,
			sourceRef: example.sourceRef ?? null,
			sourcePath: example.sourcePath ?? null,
			contentHash: example.contentHash ?? null,
		},
		licence: {
			spdx: example.licenceSpdx ?? null,
			evidence: example.licenceEvidence ?? null,
		},
		attribution: example.attribution ?? null,
		record: absolute(site, assetUsePaths.record(example.slug)) as string,
	};
}

/**
 * The worst use state in a set, worst-first.
 *
 * `null` for an empty set rather than a guess. A caller that needs an answer for
 * an entry with no examples asks `useStateFor` about the absence, which is
 * `reference-only` — an entry that shows its technique and no evidence grants
 * nothing.
 */
export function weakestUseState(states: UseState[]): UseState | null {
	if (states.length === 0) return null;
	// The order `summariseUse` uses, written out because this runs per possibility
	// where there is no selection summary to borrow it from. Kept adjacent to it so
	// a change to one is a change to both. Reduced over `states`, so an input that
	// contains no reference-only example cannot come out as one.
	const order: UseState[] = [
		"reference-only",
		"review-required",
		"reusable-with-attribution",
		"reusable",
	];
	return states.reduce((worst, state) =>
		order.indexOf(state) < order.indexOf(worst) ? state : worst,
	);
}

function serialisePossibility(
	site: string,
	possibility: Possibility,
	examples: Example[],
	decision: HandoffDecision,
): HandoffPossibility {
	const serialised = examples.map((e) => serialiseExample(site, e));
	const fromExamples = weakestUseState(serialised.map((e) => e.useState));
	return {
		id: possibility.slug,
		title: possibility.title,
		tagline: possibility.tagline ?? null,
		summary: possibility.summary ?? "",
		technique: possibility.technique ?? null,
		buildNotes: possibility.buildNotes ?? null,
		recipe: possibility.promptScaffold ?? null,
		decision,
		vertical: possibility.vertical ?? null,
		verticalLabel: verticalLabel(possibility.vertical),
		mediaKind: possibility.mediaKind ?? null,
		media: possibility.mediaKind ? (MEDIA_LABEL[possibility.mediaKind] ?? possibility.mediaKind) : null,
		preview: absolute(site, mediaSrc(possibility, "")),
		representativeOrigin: possibility.representativeOrigin ?? null,
		representativeOriginMeaning: originMeaning(possibility.representativeOrigin),
		rightsStatus: possibility.rightsStatus ?? null,
		rightsLabel: rightsLabelFor(possibility.rightsStatus),
		rightsNote: possibility.rightsNote ?? null,
		// An entry with no examples is treated as having no evidence, and the one
		// mapping decides that — not a second `reference-only` constant here.
		examplesUseState: fromExamples ?? useStateFor({ rightsStatus: null }),
		url: absolute(site, handoffPaths.possibility(possibility.slug)) as string,
		useUrl: absolute(site, handoffPaths.use(possibility.slug)) as string,
		examples: serialised,
	};
}

/* -------------------------------------------------------------------------- */
/* The document                                                                 */
/* -------------------------------------------------------------------------- */

/** The five recorded fields and which of them are blank. */
function objectiveOf(request: HandoffRequest): HandoffObjective {
	const goal = field(request.goal);
	const surface = field(request.surface);
	const platform = field(request.platform);
	const constraints = field(request.constraints);
	const acceptance = field(request.acceptance);
	const recorded: [string, string | null][] = [
		["goal", goal],
		["surface", surface],
		["platform", platform],
		["constraints", constraints],
		["acceptance", acceptance],
	];
	return {
		goal,
		surface,
		platform,
		constraints,
		acceptance,
		unrecorded: recorded.filter(([, value]) => value === null).map(([name]) => name),
	};
}

/**
 * The prose a reader reads first.
 *
 * Built from the recorded fields and the decision, in that order, and from
 * nothing else. When the goal is blank the first line says so, rather than
 * paraphrasing the tagline of whichever possibility happens to sort first.
 */
function achieveOf(input: {
	objective: HandoffObjective;
	possibilities: HandoffPossibility[];
	chosen: string[];
	rejected: string[];
}): string[] {
	const { objective, possibilities, chosen, rejected } = input;
	const lines: string[] = [];

	lines.push(
		objective.goal
			? `Achieve: ${objective.goal}`
			: "No goal was recorded. What follows describes what each possibility demonstrates, not what it is for — say what you are building before handing this to an agent.",
	);
	if (objective.surface) lines.push(`Deliver on: ${objective.surface}`);
	if (objective.platform) lines.push(`Target: ${objective.platform}`);
	if (objective.constraints) lines.push(`Constraints: ${objective.constraints}`);
	if (objective.acceptance) lines.push(`Evidence required: ${objective.acceptance}`);

	const ids = possibilities.map((p) => p.id);
	lines.push(
		chosen.length > 0
			? `Chosen: ${chosen.join(", ")}. Anything else in this list is kept for comparison only.`
			: ids.length === 1
				? `Not yet chosen: ${ids[0]}. Nothing here says it was selected.`
				: `Not yet chosen: ${ids.length} candidates and no decision recorded. Mark the ones you are going with before this goes anywhere.`,
	);
	if (rejected.length > 0) {
		lines.push(`Ruled out: ${rejected.join(", ")}. Recorded so the decision can be traced later.`);
	}
	lines.push(
		"Possibility is not permission. Every example below states what its own licence evidence supports; read the use state per example, not the entry status.",
	);

	return lines;
}

/**
 * What must not be copied literally.
 *
 * Derived from the same `useDecision` calls as the reference list, so the two
 * cannot disagree. Ordered worst first, which is the order a reader needs: the
 * most restrictive statement is the one that has to be read before the rest.
 *
 * A reusable example contributes no entry, and the list is short because it
 * should be — a section padded with reassurance trains a reader to skip it.
 */
function doNotCopyOf(possibilities: HandoffPossibility[]): { subject: string; reason: string }[] {
	const entries: { subject: string; reason: string; rank: number }[] = [];

	for (const p of possibilities) {
		if (p.rightsNote?.trim()) {
			entries.push({ subject: `${p.id} (the possibility)`, reason: p.rightsNote.trim(), rank: 0 });
		}
		if (p.representativeOrigin === "generated" && p.preview) {
			// The origin sentence already says "not a reproduction of any source
			// asset", so nothing is added to it here — the point of this entry is
			// that the thing you can see is not the thing you would be reusing.
			entries.push({
				subject: `${p.id} preview`,
				reason: ORIGIN_MEANING.generated,
				rank: 1,
			});
		}
	}

	// Worst first, matching `USE_STATE_OBLIGATION`'s own order. `reusable` gets the
	// highest rank so it sorts last, and then is skipped entirely below.
	const rank: Record<UseState, number> = {
		"reference-only": 2,
		"review-required": 3,
		"reusable-with-attribution": 4,
		reusable: 5,
	};
	/*
	 * The subject names the kind of thing as well as the id, and that is not
	 * decoration. In this catalogue a possibility and its own generated plate
	 * routinely share a slug, so `density-gradient (the possibility)` and a bare
	 * `density-gradient` would otherwise be two entries about the same string — and
	 * an agent told not to copy "density-gradient" cannot tell which one it means.
	 */
	for (const p of possibilities) {
		for (const e of p.examples) {
			if (e.useState === "reusable") continue;
			entries.push({
				subject: `${e.id} (example: ${e.title})`,
				reason: `${e.useStateLabel}. ${e.obligation ?? e.useStateMeaning}`,
				rank: rank[e.useState],
			});
		}
	}

	return entries
		.sort((a, b) => a.rank - b.rank || a.subject.localeCompare(b.subject))
		.map(({ subject, reason }) => ({ subject, reason }));
}

/** The whole-handoff rights summary, with the honest zero left in. */
function rightsOf(examples: Example[]): HandoffDocument["rights"] {
	const summary = summariseUse(examples);
	return {
		examples: summary.total,
		byState: summary.byState,
		payloads: summary.payloads,
		summary: summaryLine(summary),
	};
}

/**
 * The credits this handoff owes, in the recorded text of `selectionCreditText`.
 *
 * Only from examples whose use state actually obliges a credit to be reproduced —
 * `reusable-with-attribution`, and nothing else. A handoff assembled entirely from
 * reference-only material therefore has no credit block at all, which is the
 * correct answer: there is nothing to reproduce, and the provenance those examples
 * do carry already travels per example in `provenance` rather than as a credits
 * file nobody is meant to publish.
 *
 * Filtering here rather than reaching into `asset-use` for a bespoke block is the
 * whole point: the use page and this document quote one recorded text.
 */
function creditsOf(examples: Example[]): string | null {
	return selectionCreditText(
		examples.filter((example) => useDecision(example).state === "reusable-with-attribution"),
		(example) => example.title || example.slug,
	);
}

/* -------------------------------------------------------------------------- */
/* The document                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Builds the handoff from already-loaded records.
 *
 * Pure, and the whole of the honesty argument lives in it. Nothing here reads a
 * clock, the CMS or the request: `buildHandoffEffect` does the reads and passes
 * the result in, which is what makes every rule below testable with no database
 * and no server.
 *
 * Two reporting rules are worth stating because both are the alternative to a
 * silent drop:
 *
 * - a slug that names nothing lands in `board.unknown`, because a handoff that
 *   quietly omits one of three requested possibilities is a handoff whose reader
 *   cannot tell a gap from a decision;
 * - a slug past the per-board cap lands in `board.overflow`, for the same
 *   reason — an uncapped fan-out from an address is a way to spend a Worker's
 *   subrequest budget on purpose.
 */
export function buildHandoff(input: {
	site: string;
	slugs: string[];
	source: "slugs" | "cookie";
	boardName: string | null;
	known: Map<string, Possibility>;
	examples: Map<string, Example[]>;
	request: HandoffRequest;
	now: Date;
	query: string;
}): HandoffDocument {
	const { site, slugs, source, boardName, known, examples, request, now } = input;

	const capped = slugs.slice(0, MAX_PER_BOARD);
	const overflow = slugs.slice(MAX_PER_BOARD);
	const resolved = capped.filter((slug) => known.has(slug));
	const unknown = capped.filter((slug) => !known.has(slug));

	const inHand = new Set(resolved);
	// A mark that names something this handoff does not contain would be a decision
	// about something the reader is not being handed, so it is dropped from the
	// decision rather than honoured against a record that is not here.
	const chosen = slugList(request.chose).filter((slug) => inHand.has(slug));
	const rejected = slugList(request.rejected).filter((slug) => inHand.has(slug));
	const mark = (slug: string): HandoffDecision =>
		chosen.includes(slug) ? "chosen" : rejected.includes(slug) ? "rejected" : "candidate";

	const possibilities = resolved
		.map((slug) =>
			serialisePossibility(site, known.get(slug) as Possibility, examples.get(slug) ?? [], mark(slug)),
		)
		// Chosen first, then candidates, then what was ruled out — the order a
		// person would read them in. Slugs break ties so the order is deterministic
		// rather than dependent on which CMS query returned first.
		.sort((a, b) => {
			const rank = { chosen: 0, candidate: 1, rejected: 2 } as const;
			return rank[a.decision] - rank[b.decision] || a.id.localeCompare(b.id);
		});

	const objective = objectiveOf(request);
	const everything = possibilities.flatMap((p) => examples.get(p.id) ?? []);
	const decision = {
		recorded: chosen.length > 0,
		chosen: chosen.length > 0 ? chosen : null,
		rejected,
	};

	// Everything except `contract` and `generated`. The timestamp changes on every
	// fetch by definition and the contract block echoes the address that asked,
	// so including either would make the digest change when nothing did — which is
	// the one thing a content fingerprint is for.
	const content = {
		board: {
			source,
			name: boardName,
			requested: slugs.length,
			resolved: possibilities.length,
			unknown,
			overflow,
		},
		decision,
		objective,
		achieve: achieveOf({ objective, possibilities, chosen, rejected }),
		doNotCopy: doNotCopyOf(possibilities),
		possibilities,
		rights: rightsOf(everything),
		credits: creditsOf(everything),
	};

	return {
		schema: HANDOFF_SCHEMA,
		site,
		generated: now.toISOString(),
		fingerprint: fingerprint(content),
		contract: {
			json: absolute(site, handoffPaths.json(input.query)) as string,
			markdown: absolute(site, handoffPaths.markdown(input.query)) as string,
			catalogue: { schema: CATALOGUE_SCHEMA, url: absolute(site, handoffPaths.catalogue()) as string },
		},
		...content,
	} satisfies HandoffDocument;
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                     */
/* -------------------------------------------------------------------------- */

/** A Markdown-safe one-liner, or null. The values are CMS prose; pipes matter. */
const md = (value: string | null | undefined): string | null => {
	if (value === null || value === undefined) return null;
	const trimmed = String(value).trim();
	return trimmed ? trimmed.replace(/\|/g, "\\|") : null;
};

const DECISION_LABEL: Record<HandoffDecision, string> = {
	chosen: "chosen",
	candidate: "candidate — not yet decided",
	rejected: "ruled out",
};

/**
 * The same document as Markdown.
 *
 * Two renderings of one set of fields rather than two documents: the JSON is what
 * an agent reads, this is what a person pastes into an issue, a `DESIGN.md` or
 * the top of a prompt. It carries nothing the JSON does not and drops nothing
 * that carries rights, so "read it as Markdown" cannot lose the obligations.
 *
 * Blank fields are printed under **Not recorded** rather than omitted, because an
 * omission reads as "there was nothing to say" and the truth is "nobody said".
 */
export function renderHandoffMarkdown(handoff: HandoffDocument): string {
	const out: string[] = [];
	const titles = handoff.possibilities.map((p) => p.title);

	out.push(`# Implementation handoff — ${titles.length === 1 ? titles[0] : `${titles.length} possibilities`}`);
	out.push("");
	out.push(
		`${handoff.schema} · ${handoff.contract.json} · fingerprint \`${handoff.fingerprint}\` · generated ${handoff.generated}`,
	);
	out.push("");

	out.push("## What to achieve");
	out.push("");
	for (const line of handoff.achieve) out.push(`- ${line}`);
	out.push("");

	out.push("## Do not copy these");
	out.push("");
	if (handoff.doNotCopy.length === 0) {
		out.push(
			"- Nothing on this handoff is reference-only. That is a claim about the recorded evidence, and it does not survive a change to it.",
		);
	} else {
		for (const entry of handoff.doNotCopy) out.push(`- **${entry.subject}** — ${entry.reason}`);
	}
	out.push("");

	out.push("## References");
	out.push("");
	for (const p of handoff.possibilities) {
		out.push(`### ${p.title} · ${DECISION_LABEL[p.decision]}`);
		out.push("");
		out.push(p.url);
		out.push("");
		if (md(p.tagline)) out.push(`- What it is: ${md(p.tagline)}`);
		if (md(p.summary)) out.push(`- What it demonstrates: ${md(p.summary)}`);
		if (md(p.technique)) out.push(`- Technique: ${md(p.technique)}`);
		if (md(p.buildNotes)) out.push(`- Build notes: ${md(p.buildNotes)}`);
		if (md(p.recipe)) out.push(`- Recreation recipe: ${md(p.recipe)}`);
		out.push(`- Area: ${p.verticalLabel ?? "unclassified"}${p.media ? ` · ${p.media}` : ""}`);
		if (p.preview) out.push(`- Preview: ${p.preview}`);
		out.push(`- Entry rights status: ${p.rightsLabel ?? "unstated"} · weakest example: ${p.examplesUseState}`);
		if (md(p.rightsNote)) out.push(`- Entry rights note: ${md(p.rightsNote)}`);
		out.push("");
		if (p.examples.length === 0) {
			out.push("- No examples are recorded against this entry, so nothing is cleared by it.");
			out.push("");
			continue;
		}
		out.push("Examples:");
		out.push("");
		for (const e of p.examples) {
			out.push(`- **${e.title}** (\`${e.id}\`) — ${e.useStateLabel}`);
			if (md(e.obligation)) out.push(`  - Obligation: ${md(e.obligation)}`);
			if (md(e.originMeaning)) out.push(`  - Origin: ${e.origin} — ${md(e.originMeaning)}`);
			const where = [e.provenance.sourceRepo, e.provenance.sourceRef, e.provenance.sourcePath]
				.filter(Boolean)
				.join(" · ");
			if (where) out.push(`  - Provenance: ${where}`);
			if (md(e.licence.spdx)) out.push(`  - Licence: ${md(e.licence.spdx)}`);
			if (md(e.licence.evidence)) out.push(`  - Licence evidence: ${md(e.licence.evidence)}`);
			if (md(e.attribution)) out.push(`  - Attribution: ${md(e.attribution)}`);
			if (e.provenance.contentHash) out.push(`  - Content hash: \`${e.provenance.contentHash}\``);
			out.push(`  - Record: ${e.record}`);
			out.push(
				`  - This deployment can hand over: ${
					e.handoff === "payload" ? "the retained original" : "nothing — the record only"
				}${e.blockedBy ? ` (blocked by ${e.blockedBy})` : ""}`,
			);
		}
		out.push("");
	}

	out.push("## Rights across this handoff");
	out.push("");
	out.push(`${handoff.rights.examples} example${handoff.rights.examples === 1 ? "" : "s"} · ${handoff.rights.summary}`);
	out.push("");
	out.push(
		`${handoff.rights.payloads} retained original${handoff.rights.payloads === 1 ? "" : "s"} to download. Everything else is the record only.`,
	);
	out.push("");

	if (handoff.credits) {
		out.push("## Credits");
		out.push("");
		out.push("Reproduced exactly as recorded. Paste wherever the asset appears.");
		out.push("");
		out.push("```");
		out.push(handoff.credits);
		out.push("```");
		out.push("");
	}

	out.push("## Not recorded");
	out.push("");
	if (handoff.objective.unrecorded.length === 0 && handoff.decision.recorded) {
		out.push("- Nothing. Every field was filled in and a choice was recorded.");
	} else {
		for (const name of handoff.objective.unrecorded) {
			out.push(`- \`${name}\` — not recorded. An agent will ask for it.`);
		}
		if (!handoff.decision.recorded) {
			out.push("- `chosen` — no option was marked. Every possibility here is still a candidate.");
		}
	}
	if (handoff.board.unknown.length > 0) {
		out.push(
			`- Unknown slugs: ${handoff.board.unknown.map((s) => `\`${s}\``).join(", ")} — named something the catalogue does not have.`,
		);
	}
	if (handoff.board.overflow.length > 0) {
		out.push(
			`- Cut by the ${MAX_PER_BOARD}-entry board limit: ${handoff.board.overflow.map((s) => `\`${s}\``).join(", ")}.`,
		);
	}
	out.push("");

	out.push("## Where this came from");
	out.push("");
	out.push(`- Catalogue contract: \`${handoff.contract.catalogue.schema}\` — ${handoff.contract.catalogue.url}`);
	out.push(`- This document: \`${handoff.schema}\` — ${handoff.contract.json}`);
	out.push(`- As Markdown: ${handoff.contract.markdown}`);
	out.push(
		`- Board: ${
			handoff.board.source === "cookie"
				? `the reader's board “${handoff.board.name ?? "shortlist"}”`
				: "slugs named in the address"
		} · ${handoff.board.resolved} of ${handoff.board.requested} resolved`,
	);
	out.push("");

	return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* The read                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Reads the catalogue and builds the handoff.
 *
 * Effectful for the same reason `buildCatalogue` is: this is the CMS boundary,
 * bounded by the same `REFERENCE_CONCURRENCY` because it pays the same N+1 that
 * EmDash's `reference` fields force. The wall is read once and filtered in memory
 * rather than a `loadPossibility` per slug — the expensive part is the example
 * fan-out and that is proportional to the requested slugs either way, while one
 * wall query also makes an unknown slug a genuine "not in the catalogue" instead
 * of a CMS miss that looks like one.
 *
 * The clock is read here rather than inside `buildHandoff`, so the document is a
 * pure function of the records and a timestamp, and a test can pin the second one
 * with `TestClock`.
 */
export function buildHandoffEffect(
	request: HandoffRequest,
	resolved: { slugs: string[]; source: "slugs" | "cookie"; name: string | null },
	options: { site: string; query: string },
): Effect.Effect<HandoffDocument, EmDashReadError, EmDashContent> {
	return Effect.gen(function* () {
		const { possibilities } = yield* loadPossibilities();
		const known = new Map(possibilities.map((p) => [p.slug, p]));

		const wanted = resolved.slugs.slice(0, MAX_PER_BOARD).filter((slug) => known.has(slug));
		const pairs = yield* Effect.forEach(
			wanted,
			(slug) => Effect.map(loadExamplesFor(slug), ({ examples }) => [slug, examples] as const),
			{ concurrency: REFERENCE_CONCURRENCY },
		);

		const now = yield* DateTime.nowAsDate;
		return buildHandoff({
			site: options.site,
			slugs: resolved.slugs,
			source: resolved.source,
			boardName: resolved.name,
			known,
			examples: new Map(pairs),
			request,
			now,
			query: options.query,
		});
	});
}