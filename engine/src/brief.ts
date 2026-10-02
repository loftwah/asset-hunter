/**
 * The hunt brief.
 *
 * A brief is the operator's statement of intent before anything is crawled. It
 * is validated rather than trusted: a brief that says "find logos" with no
 * vertical and no limit produces an unreviewable pile, and the failure is
 * discovered after the crawling rather than before it.
 *
 * The fields are deliberately few. Every one of them is a decision the operator
 * has to make, and a brief full of settings nobody changes is a form, not a
 * contract.
 */

export type RightsFloor = "any" | "attribution" | "cleared";

/**
 * What to do with material whose permission was never established.
 *
 * `keep` is the default and the honest one: the material demonstrates a real
 * possibility, and deleting it because nobody published a licence throws away
 * the evidence. `metadata-only` keeps the description and the evidence but not
 * the payload. `reject` is an explicit decision by the operator, never a
 * default — a catalogue that quietly drops everything unlicensed would report a
 * coverage that does not exist.
 */
export type UnlicensedPolicy = "keep" | "metadata-only" | "reject";

export interface HuntBudgets {
	/** Files read per repository. */
	maxFilesPerRepo?: number;
	/** Total bytes of file content read across the whole hunt. */
	maxBytes?: number;
}

export interface HuntConstraints {
	/**
	 * Repository topics/names that must not appear. A hunt for sound effects
	 * should not surface a game engine that merely mentions the word.
	 */
	excludeTopics?: string[];
	/**
	 * Repository topics to require. Almost always left empty: a `vertical` is
	 * where a result is filed in our taxonomy, not a claim about how the
	 * repository is tagged on GitHub, and requiring the match silently returns
	 * nothing.
	 */
	topicHints?: string[];
	/**
	 * Minimum stars. Not a quality judgement — a proxy for "is this maintained
	 * and looked at", and recorded as such so nobody treats it as one.
	 */
	minStars?: number;
	/** Reject repositories whose licence evidence is worse than this. */
	rightsFloor?: RightsFloor;
	/** Cap on repositories inspected per wave. */
	maxCandidates?: number;
	unlicensedPolicy?: UnlicensedPolicy;
	budgets?: HuntBudgets;
}

export interface HuntBrief {
	/** Operator's words for what they are looking for. Recorded verbatim. */
	intent: string;
	/** Taxonomy slugs the results are filed under. Must be declared terms. */
	verticals: string[];
	/** Search terms, in priority order. */
	queries: string[];
	constraints?: HuntConstraints;
	/** Free-text note carried into the report. */
	notes?: string;
}

export interface ValidatedBrief {
	brief: HuntBrief;
	/** Every problem found, not just the first, so one edit can fix them all. */
	problems: string[];
}

const MAX_INTENT = 400;
const MAX_QUERIES = 12;

/**
 * Validates a brief. Returns the problems rather than throwing, so the CLI can
 * print all of them; a brief that is wrong in three ways should not take three
 * round trips to find out.
 */
export function validateBrief(input: unknown): ValidatedBrief {
	const problems: string[] = [];
	if (typeof input !== "object" || input === null) {
		return { brief: { intent: "", verticals: [], queries: [] }, problems: ["brief is not an object"] };
	}
	const raw = input as Record<string, unknown>;

	const intent = typeof raw.intent === "string" ? raw.intent.trim() : "";
	if (!intent) problems.push("intent is required: it is the statement of what this hunt is for");
	else if (intent.length > MAX_INTENT) {
		problems.push(`intent is ${intent.length} characters, over the ${MAX_INTENT} limit`);
	}

	const verticals = Array.isArray(raw.verticals)
		? raw.verticals.filter((v): v is string => typeof v === "string" && v.length > 0)
		: [];
	if (!verticals.length) {
		problems.push("verticals is required: results cannot be filed under nothing");
	}

	const queries = Array.isArray(raw.queries)
		? raw.queries
				.map((q) => (typeof q === "string" ? q.trim() : ""))
				.filter((q) => q.length > 0)
		: [];
	if (!queries.length) problems.push("queries is required: there is nothing to search for");
	if (queries.length > MAX_QUERIES) {
		problems.push(`${queries.length} queries exceeds the ${MAX_QUERIES} limit`);
	}

	const constraints = (raw.constraints ?? {}) as Record<string, unknown>;
	if (constraints.rightsFloor !== undefined && !["any", "attribution", "cleared"].includes(
		String(constraints.rightsFloor),
	)) {
		problems.push(`constraints.rightsFloor must be any|attribution|cleared, got "${constraints.rightsFloor}"`);
	}
	if (constraints.minStars !== undefined && Number(constraints.minStars) < 0) {
		problems.push("constraints.minStars cannot be negative");
	}
	if (constraints.maxCandidates !== undefined && Number(constraints.maxCandidates) <= 0) {
		problems.push("constraints.maxCandidates must be greater than zero");
	}
	if (
		constraints.unlicensedPolicy !== undefined &&
		!["keep", "metadata-only", "reject"].includes(String(constraints.unlicensedPolicy))
	) {
		problems.push(
			`constraints.unlicensedPolicy must be keep|metadata-only|reject, got "${constraints.unlicensedPolicy}"`,
		);
	}
	// `budgets` is optional and its own fields are optional, so it is narrowed
	// explicitly rather than reached through `constraints.budgets?.x`. The old
	// form typechecked only because `constraints` was `Record<string, unknown>`
	// and every property read was unchecked; TypeScript 6 stopped allowing the
	// implicit `{}` it inferred, which is the correct complaint — a budget read
	// out of untyped JSON should be narrowed, not assumed.
	const budgets: Record<string, unknown> | undefined =
		typeof constraints.budgets === "object" && constraints.budgets !== null
			? (constraints.budgets as Record<string, unknown>)
			: undefined;
	if (budgets?.maxFilesPerRepo !== undefined && Number(budgets.maxFilesPerRepo) <= 0) {
		problems.push("constraints.budgets.maxFilesPerRepo must be greater than zero");
	}
	if (budgets?.maxBytes !== undefined && Number(budgets.maxBytes) <= 0) {
		problems.push("constraints.budgets.maxBytes must be greater than zero");
	}

	const brief: HuntBrief = {
		intent,
		verticals,
		queries,
		...(Array.isArray(constraints.excludeTopics)
			? { constraints: { ...constraints, excludeTopics: constraints.excludeTopics.map(String) } }
			: { constraints }),
		...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
	} as HuntBrief;

	return { brief, problems };
}

/**
 * A stable fingerprint of the brief's decisions, not its prose. Re-running the
 * same brief must not look like a new hunt; rewriting the operator's note must
 * not either, because notes are not inputs to discovery.
 */
export function briefFingerprint(brief: HuntBrief): string {
	const material = JSON.stringify({
		verticals: [...brief.verticals].sort(),
		queries: brief.queries,
		excludeTopics: [...(brief.constraints?.excludeTopics ?? [])].sort(),
		topicHints: [...(brief.constraints?.topicHints ?? [])].sort(),
		minStars: brief.constraints?.minStars ?? 0,
		rightsFloor: brief.constraints?.rightsFloor ?? "any",
		maxCandidates: brief.constraints?.maxCandidates ?? 0,
		unlicensedPolicy: brief.constraints?.unlicensedPolicy ?? "keep",
		maxFilesPerRepo: brief.constraints?.budgets?.maxFilesPerRepo ?? 0,
		maxBytes: brief.constraints?.budgets?.maxBytes ?? 0,
	});
	// FNV-1a: short, dependency-free and stable across runs. This identifies a
	// brief, it is not a security boundary.
	let hash = 0x811c9dc5;
	for (let i = 0; i < material.length; i++) {
		hash ^= material.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
