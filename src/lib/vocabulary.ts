/**
 * Editorial copy and vocabulary for the catalogue surface.
 *
 * Kept out of the Astro components so the wording can be reviewed as prose and
 * so terminology stays consistent between the wall, drill-in pages and the
 * rights legend. Vocabulary matches `seed/atlas.json`.
 */

export type RightsStatus = "cleared" | "attribution" | "review" | "reference";
export type Origin = "upstream" | "derived" | "generated";
export type Vertical = string;

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
};

export const ORIGIN_MEANING: Record<Origin, string> = {
	upstream: "Shown directly from discovered material.",
	derived: "A safe preview or showcase produced from discovered material.",
	generated: "Newly generated to demonstrate a known possibility. Not a reproduction of any source asset.",
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
