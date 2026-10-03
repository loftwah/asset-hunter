/**
 * Vertical vocabulary, declared here rather than imported.
 *
 * `docs/ARCHITECTURE.md` is explicit that the engine does not import app code:
 * the boundary between the two systems is an HTTP contract, not a shared module.
 * `exclusions.ts` already declares its scopes for the same reason and says so;
 * this is the second such declaration, with the same shape of answer.
 *
 * One vocabulary, two declarations, and a test in `tests/engine.test.ts` that
 * they agree — which is why the strings are written out rather than derived. A
 * shared import would make the boundary real code and untrue documentation at the
 * same time, and the failure would be silent: a vertical renamed in the app would
 * leave the engine filing entries under a label the catalogue does not have.
 */

/** The public label for each declared vertical. Mirrors `VERTICAL_LABEL`. */
export const VERTICAL_LABEL: Readonly<Record<string, string>> = {
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
 * The words a vertical covers, beyond the two in its label.
 *
 * The label is a *name*, and `verticalFit` needs to know what a vertical is
 * *about* before it can say whether a repository belongs in it. Matching on the
 * label alone is what produced a false refusal, and a false refusal is the worst
 * kind of bug here: it is silent, and it drops exactly the evidence a hunt was
 * sent out to find.
 *
 * The concrete case — a brief for "procedural sound effects" against
 * `audio-music`, whose label words are *audio* and *music*. A repository
 * described as "A granular texture sound generator" scores zero against both, and
 * its files are `.cpp`, not `.wav`, so the medium signal does not rescue it
 * either. The crawl refused it, and `tests/refresh-crawl.test.ts` lost its
 * payload entry and failed. The vocabulary was wrong, not the test.
 *
 * These are the words the trade actually uses for the same thing. They are
 * deliberately short and deliberately not a synonym ontology: a wrong extra term
 * costs a misfiled entry, and a missing one costs a dropped candidate, so this
 * errs towards the obvious.
 */
export const VERTICAL_TERMS: Readonly<Record<string, readonly string[]>> = {
	games: ["game", "gameplay", "player", "mechanic", "hud", "enemy", "level"],
	"ui-web": ["ui", "ux", "web", "interface", "component", "layout", "dashboard", "form"],
	interaction: ["interaction", "gesture", "drag", "hover", "click", "input", "control", "cursor"],
	branding: ["brand", "identity", "guideline", "logo", "wordmark", "mark", "lockup"],
	logos: ["logo", "logos", "mark", "wordmark", "monogram", "lettermark", "emblem", "badge"],
	icons: ["icon", "icons", "iconset", "glyph", "pictogram", "symbol"],
	typography: ["type", "typography", "font", "fonts", "lettering", "wordmark", "typeface"],
	"motion-video": ["motion", "animation", "animate", "video", "transition", "easing", "kinetic"],
	"audio-music": ["audio", "sound", "sfx", "music", "sonic", "synthesis", "sample", "granular"],
	"3d": ["3d", "model", "mesh", "render", "blender", "glb", "gltf", "scene"],
	shaders: ["shader", "glsl", "fragment", "vertex", "procedural", "noise", "raymarch"],
	"software-architecture": [
		"architecture",
		"pattern",
		"event",
		"sourced",
		"queue",
		"cache",
		"storage",
		"dev",
	],
	"ai-products": ["agent", "llm", "model", "inference", "ai", "copilot", "tool"],
};

/**
 * Every word that should pull a candidate towards a vertical: the label, plus
 * the terms above. A slug the vocabulary has not been taught contributes its own
 * hyphen-separated words, so a new vertical is matchable before anybody has
 * written terms for it.
 */
export function verticalTerms(slug: string): Set<string> {
	const words = new Set<string>();
	for (const word of verticalLabel(slug).split(/[^a-z0-9]+/i)) {
		if (word.length > 2) words.add(word.toLowerCase());
	}
	for (const term of VERTICAL_TERMS[slug] ?? []) {
		if (term.length > 2) words.add(term.toLowerCase());
	}
	for (const word of slug.split(/[^a-z0-9]+/i)) {
		if (word.length > 2) words.add(word.toLowerCase());
	}
	return words;
}

/**
 * The engine's spelling of a vertical slug, with the same fallback the app uses.
 *
 * Slugs are storage keys: a slug the vocabulary has not been taught still has to
 * produce something a reader can read, because silently dropping the entry would
 * hide a hunt's results without saying why.
 */
export function verticalLabel(slug: string | null | undefined): string {
	if (!slug) return "Unclassified";
	return VERTICAL_LABEL[slug] ?? slug.replace(/-/g, " ");
}
