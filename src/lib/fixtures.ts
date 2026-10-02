/**
 * Deterministic fixtures for the visual lab (#45).
 *
 * These are the shapes the catalogue has to survive: every media type the
 * handlers know about, every rights status, every community and editorial
 * signal, and every state a reader can land in. They exist as data rather than
 * as a screenshot so the lab renders the **real** components with the real
 * design tokens — a mockup of a card proves nothing about a card.
 *
 * Everything here is a literal. Nothing is generated at import time, nothing
 * depends on the clock, and no fixture reads from EmDash, so two runs a week
 * apart produce the same pixels and a screenshot diff means something.
 *
 * `lab.astro` is the only consumer, and it refuses to render outside `astro
 * dev`. The fixtures describe media that does not exist — a dead source, a
 * broken preview — and shipping them would put lies on the public site.
 */

import type { Example, Possibility } from "./catalogue.ts";
import type { RightsStatus } from "./vocabulary.ts";

export interface LabState {
	/** What the fixture is proving. Shown above it in the lab. */
	note: string;
	possibility: Possibility;
	/** Tile-level state flags the catalogue does not have yet. */
	flags?: {
		saved?: boolean;
		selected?: boolean;
		loading?: boolean;
		brokenPreview?: boolean;
		deadSource?: boolean;
	};
	/** The states a real interaction produces, not data-driven. */
	hover?: boolean;
	focus?: boolean;
}

/** A plate that exists, so a fixture shows media rather than the placeholder. */
const plate = (name: string) => `/specimens/${name}.svg`;

const base = (over: Partial<Possibility> & { slug: string }): Possibility => ({
	title: over.slug.replace(/-/g, " "),
	tagline: null,
	summary: "A fixture. It exists so the wall can be looked at.",
	technique: "Fixture",
	vertical: "games",
	mediaKind: "image",
	specimen: plate("crowd-fluid"),
	image: null,
	representativeOrigin: "generated",
	rightsStatus: "reference",
	rightsNote: "Reference only.",
	buildNotes: null,
	promptScaffold: null,
	exampleCount: 1,
	distinctSources: 0,
	novelty: null,
	coverage: null,
	editorialRank: 0.5,
	featured: false,
	...over,
});

/** Media types. One per handler family, so a new handler has to add a fixture. */
export const MEDIA_FIXTURES: LabState[] = [
	{
		note: "static image plate",
		possibility: base({ slug: "fixture-image", title: "One grid where emphasis steps down diagonally", mediaKind: "image", specimen: plate("density-gradient") }),
	},
	{
		note: "logo / mark",
		possibility: base({ slug: "fixture-logo", title: "Negative-space marks that only exist where two shapes meet", vertical: "logos", specimen: plate("negative-space-mark") }),
	},
	{
		note: "icon set",
		possibility: base({ slug: "fixture-icons", title: "Duotone icon sets that survive being small", vertical: "icons", specimen: plate("duotone-icons") }),
	},
	{
		note: "animation or video",
		possibility: base({ slug: "fixture-motion", title: "Kinetic type cut on the transient", vertical: "motion-video", mediaKind: "motion", specimen: plate("kinetic-type") }),
	},
	{
		note: "audio / SFX",
		possibility: base({ slug: "fixture-audio", title: "Timbre as a continuous parameter", vertical: "audio-music", mediaKind: "audio", specimen: plate("wavetable-morph") }),
	},
	{
		note: "font specimen",
		possibility: base({ slug: "fixture-type", title: "Optical size as a continuous axis", vertical: "typography", mediaKind: "type", specimen: plate("variable-width-type") }),
	},
	{
		note: "3D asset",
		possibility: base({ slug: "fixture-3d", title: "Edge-to-solid level of detail", vertical: "3d", mediaKind: "3d", specimen: plate("edge-fade") }),
	},
	{
		note: "shader or live code",
		possibility: base({ slug: "fixture-shader", title: "Geometry as a distance function", vertical: "shaders", mediaKind: "shader", specimen: plate("raymarched-sdf") }),
	},
	{
		note: "code / interaction",
		possibility: base({ slug: "fixture-code", title: "Command palette as the only navigation", vertical: "ui-web", mediaKind: "code", specimen: plate("command-palette") }),
	},
	{
		note: "no plate at all — the placeholder must say so",
		possibility: base({ slug: "fixture-no-plate", title: "A technique waiting for its plate", specimen: null }),
	},
	{
		note: "CMS media overrides the specimen path",
		possibility: base({
			slug: "fixture-cms-media", title: "A representative image managed in the CMS",
			specimen: plate("event-sourced-core"),
			image: { id: "fixture-image-id", src: plate("content-addressed"), alt: "CMS media replacing the plate" },
		}),
	},
];

const RIGHTS_TITLES: Record<string, string> = {
	cleared: "Sound effects synthesised from a noise budget",
	attribution: "A grain texture over a single chord",
	review: "Copyleft assets kept as reference only",
	reference: "A sound pack with no published licence",
};

const ORIGIN_TITLES: Record<string, string> = {
	upstream: "Shown directly from a discovered repository",
	derived: "A safe preview produced from discovered material",
	generated: "Newly generated to demonstrate a treatment",
};

const EVIDENCE_TITLES = [
	"Twelve sources collapsed into one treatment",
	"Three examples, none with a readable licence",
	"Nothing measured, and saying so",
];

/** Rights statuses, including the one that must never read as permissive. */
export const RIGHTS_FIXTURES: LabState[] = (
	["cleared", "attribution", "review", "reference"] as RightsStatus[]
).map((status, i) => ({
	note: `rights: ${status}`,
	possibility: base({
		slug: `fixture-rights-${status}`,
		title: RIGHTS_TITLES[status],
		rightsStatus: status,
		distinctSources: i + 1,
		specimen: plate(["minimap-breadcrumb", "uncertainty-output", "silhouette-legibility", "match-cut"][i]),
	}),
}));

/** Origin coding. Generated must never be confused with upstream. */
export const ORIGIN_FIXTURES: LabState[] = (["upstream", "derived", "generated"] as const).map(
	(origin) => ({
		note: `origin: ${origin}`,
		possibility: base({
			slug: `fixture-origin-${origin}`,
			title: ORIGIN_TITLES[origin],
			representativeOrigin: origin,
			rightsStatus: origin === "upstream" ? "attribution" : "reference",
		}),
	}),
);

/** Machine evidence. Zero and null have to be visibly different from a number. */
export const EVIDENCE_FIXTURES: LabState[] = [
	{
		note: "verified sources counted",
		possibility: base({ slug: "fixture-evidence-counted", title: "Twelve sources collapsed into one treatment", distinctSources: 7, exampleCount: 12 }),
	},
	{
		note: "no verified sources — an honest zero",
		possibility: base({ slug: "fixture-evidence-zero", title: "Three examples, none with a readable licence", distinctSources: 0, exampleCount: 3 }),
	},
	{
		note: "machine observations are null, never estimated",
		possibility: base({ slug: "fixture-evidence-null", title: "Nothing measured, and saying so", novelty: null, coverage: null, distinctSources: 0 }),
	},
];

/** Interaction and lifecycle states. */
export const STATE_FIXTURES: LabState[] = [
	{ note: "default", possibility: base({ slug: "fixture-state-default", title: "Crouds that move as a fluid, not as agents" }) },
	{
		note: "hover — plate lifts, border warms, media scales",
		possibility: base({ slug: "fixture-state-hover", title: "Adaptive marks redrawn per placement", specimen: plate("adaptive-mark") }),
		hover: true,
	},
	{
		note: "keyboard focus — 2px ember ring at 4px offset",
		possibility: base({ slug: "fixture-state-focus", title: "Granular texture from overlapping windows", specimen: plate("granular-texture") }),
		focus: true,
	},
	{
		note: "selected",
		possibility: base({ slug: "fixture-state-selected", title: "A loop closed by periodicity", specimen: plate("crowd-fluid") }),
		flags: { selected: true },
	},
	{
		note: "saved / shortlisted",
		possibility: base({ slug: "fixture-state-saved", title: "Diegetic damage read off the world", specimen: plate("seamless-loop") }),
		flags: { saved: true },
	},
	{
		note: "loading — geometry reserved, no spinner over content",
		possibility: base({ slug: "fixture-state-loading", title: "Health you read off the world, not off a bar", specimen: plate("diegetic-damage") }),
		flags: { loading: true },
	},
	{
		note: "broken preview — says what failed and what to do",
		possibility: base({ slug: "fixture-state-broken", title: "Interactive snippets rendering as content", specimen: plate("wavetable-morph") }),
		flags: { brokenPreview: true },
	},
	{
		note: "dead upstream source",
		possibility: base({ slug: "fixture-state-dead", title: "Velocity continuity instead of subject continuity", specimen: plate("physics-sheet") }),
		flags: { deadSource: true },
	},
	{
		note: "featured",
		possibility: base({ slug: "fixture-state-featured", title: "A density ramp a designer can actually ship", featured: true, specimen: plate("density-gradient") }),
	},
	{
		note: "long title and tagline — the wrapping case",
		possibility: base({
			slug: "fixture-state-long-title",
			title: "A title long enough that it has to wrap on a tile and must not be clipped mid-word",
			tagline: "And a tagline long enough to prove the label block has room for two lines",
			specimen: plate("uncertainty-output"),
		}),
	},
	{
		note: "missing everything — no title fallbacks, no empty pills",
		possibility: base({
			slug: "fixture-state-sparse",
			title: "fixture-state-sparse",
			tagline: null,
			vertical: null,
			mediaKind: null,
			rightsStatus: null,
			representativeOrigin: null,
			specimen: null,
		}),
	},
];

/* -------------------------------------------------------------------------- */
/* Asset use (#42)                                                             */
/* -------------------------------------------------------------------------- */

export interface UseFixture {
	/** What the fixture is proving. Shown above it in the lab. */
	note: string;
	example: Example;
}

/**
 * An example literal, so a use state can be rendered without a record behind it.
 *
 * The point of these fixtures is the four use states and the two handoff
 * outcomes, and the catalogue currently holds only one of them — a set of
 * generated plates that are all reference only. Without fixtures the three
 * reuse states would exist only in a unit test, which is exactly the "state that
 * only exists in a screenshot" problem the lab was built to prevent.
 */
const exampleOf = (over: Partial<Example> & { slug: string }): Example => ({
	title: over.slug.replace(/-/g, " "),
	origin: "upstream",
	mediaKind: "image",
	specimen: plate("grain-field"),
	image: null,
	rightsStatus: "reference",
	rightsNote: null,
	note: null,
	sourceUrl: null,
	sourceRepo: null,
	sourceRef: null,
	sourcePath: null,
	licenceSpdx: null,
	licenceEvidence: null,
	attribution: null,
	contentHash: null,
	downloadable: false,
	...over,
});

/** A well-formed SHA-256, so the hash fixtures look like real ones. */
const HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * The four use states, plus the three handoff outcomes that are not about rights.
 *
 * Ordered so the most restrictive answer is read first, which is the order the
 * selection summary on `/use/<slug>` uses.
 */
export const USE_FIXTURES: UseFixture[] = [
	{
		note: "reference only — no download, and the reason stated",
		example: exampleOf({
			slug: "fixture-use-reference",
			title: "Grain plate scanned from an uncredited archive",
			rightsStatus: "reference",
			rightsNote: "The archive published no terms. It stays because the treatment is real.",
		}),
	},
	{
		note: "review required — something found, nothing understood",
		example: exampleOf({
			slug: "fixture-use-review",
			title: "Shared-economy icon set with a custom notice",
			rightsStatus: "review",
			licenceSpdx: "LicenseRef-scene-share",
			licenceEvidence:
				"\"Assets in this pack may be used in scenes sold to third parties, provided the pack is not redistributed in whole or in part.\"\n— LICENSE-NOTICE, read at the commit recorded below.",
			sourceUrl: "https://github.com/example/shared-economy-icons",
			sourceRepo: "example/shared-economy-icons",
			sourceRef: "a1b2c3d",
			sourcePath: "icons/LICENSE-NOTICE",
		}),
	},
	{
		note: "reusable with attribution — the credit is shown, not summarised",
		example: exampleOf({
			slug: "fixture-use-attribution",
			title: "Paper texture set with a recorded credit",
			rightsStatus: "attribution",
			licenceSpdx: "CC-BY-4.0",
			licenceEvidence:
				"\"You are free to share and adapt this texture for any purpose, provided you give appropriate credit.\"\n— LICENSE, read at the commit recorded below.",
			attribution: "\"Paper textures\" by Wren Aliyeva, released under CC BY 4.0.",
			sourceUrl: "https://github.com/example/paper-textures",
			sourceRepo: "example/paper-textures",
			sourceRef: "9f8e7d6",
			sourcePath: "textures/paper-01.png",
			contentHash: HASH,
			downloadable: false,
		}),
	},
	{
		note: "reusable — retained, hashed, and offered for download",
		example: exampleOf({
			slug: "fixture-use-reusable",
			title: "Ambient loop cleared for reuse with the credit recorded",
			rightsStatus: "cleared",
			licenceSpdx: "CC0-1.0",
			licenceEvidence:
				"\"This work has been released into the public domain.\"\n— LICENSE, read at the commit recorded below.",
			attribution: "Public domain. No attribution required, and none is claimed.",
			sourceUrl: "https://github.com/example/ambient-loops",
			sourceRepo: "example/ambient-loops",
			sourceRef: "c0ffee1",
			sourcePath: "loops/room-tone-90s.wav",
			contentHash: HASH,
			downloadable: true,
		}),
	},
	{
		note: "reusable but not retained — permitted, and nothing to hand over",
		example: exampleOf({
			slug: "fixture-use-not-retained",
			title: "Noise floor cleared upstream and not kept here",
			rightsStatus: "cleared",
			licenceSpdx: "MIT",
			attribution: "\"noise-floor\" by T. Okafor, MIT.",
			sourceUrl: "https://github.com/example/noise-floor",
			sourceRepo: "example/noise-floor",
			sourcePath: "audio/floor.wav",
			downloadable: false,
		}),
	},
	{
		note: "retained without a hash — nothing served, because nothing can be proven",
		example: exampleOf({
			slug: "fixture-use-unverified",
			title: "A retained sprite sheet with no digest recorded",
			rightsStatus: "cleared",
			licenceSpdx: "CC0-1.0",
			attribution: "Public domain. No attribution required.",
			sourceUrl: "https://github.com/example/sprite-sheets",
			sourceRepo: "example/sprite-sheets",
			sourcePath: "sprites/run.png",
			contentHash: null,
			downloadable: true,
		}),
	},
];

export interface LabSection {
	id: string;
	title: string;
	why: string;
	fixtures: LabState[];
}

export const LAB_SECTIONS: LabSection[] = [
	{
		id: "media",
		title: "Media types",
		why: "Every handler family the catalogue knows about. A new handler adds a fixture here, so a media type cannot ship without evidence that it was looked at.",
		fixtures: MEDIA_FIXTURES,
	},
	{
		id: "rights",
		title: "Rights statuses",
		why: "The four statuses side by side, because the only way to know that 'reference only' does not read as a softer 'cleared' is to see them next to each other.",
		fixtures: RIGHTS_FIXTURES,
	},
	{
		id: "origin",
		title: "Origin coding",
		why: "upstream, derived and generated. These must never be mixed in a row without their labels, and never be confusable at a glance.",
		fixtures: ORIGIN_FIXTURES,
	},
	{
		id: "evidence",
		title: "Machine evidence",
		why: "Counted, honest zero, and not-measured. A reader has to be able to tell 'we found none' from 'we did not look'.",
		fixtures: EVIDENCE_FIXTURES,
	},
	{
		id: "state",
		title: "Interaction and lifecycle",
		why: "The states a reader can land in. Each one needs a real answer; an unhandled state is how a catalogue ends up looking broken on someone else's device.",
		fixtures: STATE_FIXTURES,
	},
];

/** Every fixture, flattened. Used by the visual-QA route list. */
export const allFixtures = (): LabState[] => LAB_SECTIONS.flatMap((s) => s.fixtures);