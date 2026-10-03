/**
 * Editorial copy and vocabulary for the catalogue surface.
 *
 * Kept out of the Astro components so the wording can be reviewed as prose and
 * so terminology stays consistent between the wall, drill-in pages and the
 * rights legend. Vocabulary matches `seed/atlas.json`.
 */

export type RightsStatus = "cleared" | "attribution" | "review" | "reference";
/**
 * Where a possibility's representative media came from — or that there is none.
 *
 * `none` is a real value and it was missing. A discovered entry arrives from the
 * hunt engine with no plate: the engine records what it read, not what it
 * rendered, and `representative_origin: "generated"` claimed a plate that did not
 * exist. That is the exact failure this field exists to prevent — a generated
 * plate and a derived one are different claims about provenance, and "generated"
 * for something absent is a lie with a footnote.
 *
 * The honest value for "no representative media yet" is its own value, so the
 * tile, the use page and the JSON contract can each say so.
 */
export type Origin = "upstream" | "derived" | "generated" | "none";
export type Vertical = string;

/**
 * The per-example use state (#42).
 *
 * A rights status answers "what does the licence permit". A use state answers
 * "what may I do with the example in front of me", which is the question a
 * reader actually has on the drill-in and the only one the asset-use flow is
 * allowed to answer. The two are separate concepts and are never collapsed into
 * one another: `cleared` and `reusable` happen to be the same answer, and
 * `attribution` and `reusable-with-attribution` are the same answer, but the
 * tile shows the status and the use decision shows the state.
 *
 * Nothing here is a euphemism for "probably fine". There is no state whose
 * label is a softer word than its meaning — that is what `reference-only` and
 * `review-required` are for.
 */
export type UseState =
	| "reusable"
	| "reusable-with-attribution"
	| "review-required"
	| "reference-only";

export const USE_STATE_LABEL: Record<UseState, string> = {
	reusable: "Reusable",
	"reusable-with-attribution": "Reusable with attribution",
	"review-required": "Review required",
	"reference-only": "Reference only",
};

/**
 * A sentence per use state, not a word. Same rule as the rights meanings: the
 * most consequential sentence on the page has to be a complete one, and
 * "reference only" in particular must not read as a softer "reusable".
 */
export const USE_STATE_MEANING: Record<UseState, string> = {
	reusable: "A licence was read from the source and permits reuse. The original is handed over unmodified.",
	"reusable-with-attribution":
		"Reuse is permitted if the recorded credit travels with the asset. The credit is shown in full, not summarised.",
	"review-required":
		"Something was found but not understood well enough to rely on. Read the recorded licence evidence before using any of it.",
	"reference-only":
		"No licence was found, or reuse is not permitted. Look, and do not copy: this is the whole of its permission.",
};

/**
 * What the reader has to do. `null` means the use state places no obligation,
 * which is true of exactly one state — so this is also the check that
 * "reusable" is not a licence to be careless.
 */
export const USE_STATE_OBLIGATION: Record<UseState, string | null> = {
	reusable: null,
	"reusable-with-attribution":
		"Reproduce the recorded credit wherever the asset appears, including in anything you generate from it.",
	"review-required":
		"Read the recorded licence evidence and decide for yourself. Nothing here has been cleared on your behalf.",
	"reference-only":
		"Do not copy, ship or redistribute. Opening the canonical source is the extent of what is permitted from this page.",
};

/**
 * The colour token for a use state.
 *
 * It is the token the matching rights status already uses, because the two
 * always answer together — but the mapping lives here so no component derives a
 * CSS custom-property name out of a state slug, which is how a design token
 * ends up renamed on one surface and not another.
 */
export const USE_STATE_COLOR: Record<UseState, string> = {
	reusable: "var(--rights-cleared)",
	"reusable-with-attribution": "var(--rights-attribution)",
	"review-required": "var(--rights-review)",
	"reference-only": "var(--rights-reference)",
};

export const RIGHTS_LABEL: Record<RightsStatus, string> = {
	cleared: "Cleared",
	attribution: "Attribution",
	review: "Review",
	reference: "Reference only",
};

/**
 * Rights is the most consequential thing on the page, so each status gets a
 * sentence rather than a word. "Reference only" in particular must never read
 * as a softer version of "cleared".
 */
export const RIGHTS_MEANING: Record<RightsStatus, string> = {
	cleared: "Licence read from the source and recorded. Use is permitted for this example.",
	attribution: "Use permitted if the recorded attribution is reproduced with it.",
	review: "Something was detected but not understood well enough to rely on. Read before use.",
	reference: "No licence found, or reuse explicitly not permitted. Kept because it demonstrates a real possibility. This is the entire extent of its permission.",
};

export const ORIGIN_LABEL: Record<Origin, string> = {
	upstream: "Upstream",
	derived: "Derived",
	generated: "Generated",
	none: "No media yet",
};

export const ORIGIN_MEANING: Record<Origin, string> = {
	upstream: "Shown directly from discovered material.",
	derived: "A safe preview or showcase produced from discovered material.",
	generated: "Newly generated to demonstrate a known possibility. Not a reproduction of any source asset.",
	none: "No representative media has been produced for this entry yet. What is recorded here is the evidence that was read, not a picture of it.",
};

export const VERTICAL_LABEL: Record<string, string> = {
	games: "Games",
	"ui-web": "UI / Web",
	interaction: "Interaction",
	branding: "Branding",
	logos: "Logos",
	icons: "Icons",
	typography: "Typography",
	"motion-video": "Motion / Video",
	"audio-music": "Audio / Music",
	"3d": "3D",
	shaders: "Shaders",
	"software-architecture": "Software / Architecture",
	"ai-products": "AI Products",
};

/**
 * Public label for a vertical slug.
 *
 * Slugs are storage keys and read as `ui web` or `3d` if they are shown raw.
 * Vocabulary is the single place a term is spelled, so a label is looked up
 * rather than reformatted per surface — the filter rail, the search facets and
 * the coverage map all say `UI / Web`, not three different things.
 */
export function verticalLabel(slug: string | null | undefined): string {
	if (!slug) return "Unclassified";
	return VERTICAL_LABEL[slug] ?? slug.replace(/-/g, " ");
}

/**
 * One sentence saying what a vertical is, for the vertical's own page.
 *
 * `docs/VOCABULARY.md` owns what the words mean; this owns the sentence that
 * introduces a vertical when it is the subject of the page rather than a filter
 * on somebody else's. It is computed from the entries that actually rendered,
 * so the count can never disagree with the wall underneath it — the failure
 * `/search`'s empty state had when "covers 13 verticals" was a literal in copy
 * (#77).
 *
 * It also does not claim a representative exists. `origin: "none"` is a real
 * value for an entry the hunt engine read evidence about but produced no plate
 * for, and this sentence sits directly above tiles that read "No media yet" — so
 * "each with a representative example" is contradicted by the first row beneath
 * it. `withMedia` is counted rather than assumed.
 *
 * Kept here, beside the labels, because a vertical's name and its one-line
 * description are the same fact and splitting them across files is how one of
 * them goes stale.
 */
export function verticalBlurb(
	slug: string,
	count: number,
	withMedia: number = count,
): string {
	const entries = `${count} ${count === 1 ? "possibility" : "possibilities"}`;
	const coverage = withMedia
		? `${withMedia} with a representative example, and what is actually cleared for use`
		: "none with a representative example yet — what is recorded here is the evidence that was read";
	return `${entries} in ${VERTICAL_LABEL[slug] ?? slug.replace(/-/g, " ")}, ${coverage}. This is a map of what has been catalogued, not a claim that the space is covered.`;
}

/**
 * Public label for a rights status, or null when there is none to show.
 *
 * Falls back to the stored value rather than to nothing, because a status the
 * vocabulary has not been taught is still a fact about the record and hiding it
 * would make an unknown status look like a missing field. The fallback is also
 * what keeps a component from casting `string` into the union by hand, which is
 * how a fourth status ends up rendered three different ways.
 */
export function rightsLabelFor(status: string | null | undefined): string | null {
	if (!status) return null;
	return RIGHTS_LABEL[status as RightsStatus] ?? status;
}

/** Public label for an origin, with the same fallback rule as `rightsLabelFor`. */
export function originLabelFor(origin: string | null | undefined): string | null {
	if (!origin) return null;
	return ORIGIN_LABEL[origin as Origin] ?? origin;
}

export const MEDIA_LABEL: Record<string, string> = {
	image: "Image",
	motion: "Motion",
	audio: "Audio",
	"3d": "3D",
	code: "Code",
	shader: "Shader",
	type: "Typography",
};

export function rightsColor(status: string): string {
	return `var(--rights-${status}, var(--ink-3))`;
}

export function originColor(origin: string): string {
	return `var(--origin-${origin}, var(--ink-3))`;
}
