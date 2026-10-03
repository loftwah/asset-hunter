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
import {
	aggregateRatings,
	emptyAggregate,
	type Aggregate,
	type Report,
	type ReportReason,
} from "./rating.ts";
// Type-only: the lab is rendered with fixtures and must not open a CMS
// connection, so the reader identity is narrowed to its shape and nothing more.
import type { Actor } from "./signals.ts";

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
export const ORIGIN_FIXTURES: LabState[] = (["upstream", "derived", "generated", "none"] as const).map(
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
	/*
	 * `granular-texture`, not `grain-field`.
	 *
	 * The default named a plate that was never authored, so every one of the six
	 * use fixtures rendered a 404 in its `<img>` — a broken image on a page whose
	 * entire job is showing you what a file looks like. `check:visual` reported it
	 * once `/use/<slug>` had fixtures to check, which is the argument for having
	 * the page-level fixtures at all: a state nobody renders is a state nobody has
	 * looked at.
	 */
	specimen: plate("granular-texture"),
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

/* -------------------------------------------------------------------------- */
/* The whole use page, in every state (#47)                                    */
/* -------------------------------------------------------------------------- */

/**
 * A selection page per use state, not just a use block per use state.
 *
 * `USE_FIXTURES` above covers the four rights as *blocks* — the thing that
 * decides what a reader may do. It does not cover the page around them, and the
 * page is where half the copy lives: the summary line that counts states worst
 * first, "0 retained originals to download" against "2 retained originals", the
 * selection credit block, and the single download accent.
 *
 * None of that can be seen on a real route today. The catalogue is 24 of 24
 * `reference` (`/api/catalogue.json` says so), so `/use/<slug>` renders exactly
 * one of the four states and always with a payload count of zero. Three of the
 * four states — and every page that has anything to download — have never been
 * rendered by anybody.
 *
 * So each fixture is a whole selection: one possibility and the examples that
 * produce the page's counts. `src/pages/use/[slug].astro` resolves these in
 * `astro dev` only, which is how `/use/fixture-use-reusable` gets pixels without
 * a parallel page implementation — a mockup of the use page would prove that the
 * mockup works, which is the mistake the lab was built to stop making.
 *
 * One selection per state rather than one selection holding all four, because
 * `DESIGN.md` §9.6 allows at most one download on the page: a selection with two
 * retained originals puts two ember controls on one screen, and what that should
 * look like is a design decision, not a fixture decision. It is filed, not
 * rendered here.
 */
export interface UsePageFixture {
	/** The slug `/use/<slug>` answers to, in `astro dev` only. */
	slug: string;
	note: string;
	possibility: Possibility;
	examples: Example[];
}

const usePossibility = (slug: string, over: Partial<Possibility> & { title: string }): Possibility => ({
	slug,
	summary:
		"A fixture selection, so the use page can be seen in a state the catalogue does not hold yet.",
	technique: "Fixture",
	vertical: "ui-web",
	mediaKind: "image",
	specimen: plate("density-gradient"),
	image: null,
	representativeOrigin: "upstream",
	rightsStatus: "reference",
	rightsNote: null,
	buildNotes: null,
	promptScaffold: null,
	exampleCount: 1,
	distinctSources: 1,
	novelty: null,
	coverage: null,
	editorialRank: 0.5,
	featured: false,
	...over,
});

export const USE_PAGE_FIXTURES: UsePageFixture[] = [
	{
		slug: "fixture-use-page-reference",
		note: "the state the catalogue is actually in — one example, nothing to hand over",
		possibility: usePossibility("fixture-use-page-reference", {
			title: "A grain plate scanned from an uncredited archive",
		}),
		examples: [
			exampleOf({
				slug: "fixture-use-page-reference",
				title: "A grain plate scanned from an uncredited archive",
				rightsStatus: "reference",
				rightsNote: "The archive published no terms. It stays because the treatment is real.",
				note: "Newly generated to demonstrate a known possibility. Not a reproduction of any source asset.",
			}),
		],
	},
	{
		slug: "fixture-use-page-review",
		note: "review required — something found, nothing understood, and the evidence is quoted",
		possibility: usePossibility("fixture-use-page-review", {
			title: "Shared-economy icon set with a custom notice",
			rightsStatus: "review",
		}),
		examples: [
			exampleOf({
				slug: "fixture-use-page-review",
				title: "Shared-economy icon set with a custom notice",
				rightsStatus: "review",
				licenceSpdx: "LicenseRef-scene-share",
				licenceEvidence:
					'"Assets in this pack may be used in scenes sold to third parties, provided the pack is not redistributed in whole or in part."\n— LICENSE-NOTICE, read at the commit recorded below.',
				sourceUrl: "https://github.com/example/shared-economy-icons",
				sourceRepo: "example/shared-economy-icons",
				sourceRef: "a1b2c3d",
				sourcePath: "icons/LICENSE-NOTICE",
			}),
		],
	},
	{
		slug: "fixture-use-page-attribution",
		note: "reusable with attribution — the credit is reproduced and the obligation is written out",
		possibility: usePossibility("fixture-use-page-attribution", {
			title: "Paper texture set with a recorded credit",
			rightsStatus: "attribution",
		}),
		examples: [
			exampleOf({
				slug: "fixture-use-page-attribution",
				title: "Paper texture set with a recorded credit",
				rightsStatus: "attribution",
				licenceSpdx: "CC-BY-4.0",
				licenceEvidence:
					'"You are free to share and adapt this texture for any purpose, provided you give appropriate credit."\n— LICENSE, read at the commit recorded below.',
				attribution: '"Paper textures" by Wren Aliyeva, released under CC BY 4.0.',
				sourceUrl: "https://github.com/example/paper-textures",
				sourceRepo: "example/paper-textures",
				sourceRef: "9f8e7d6",
				sourcePath: "textures/paper-01.png",
				contentHash: HASH,
			}),
		],
	},
	{
		slug: "fixture-use-page-reusable",
		note: "reusable — retained, hashed, and the one page where a download control exists at all",
		possibility: usePossibility("fixture-use-page-reusable", {
			title: "Ambient loop cleared for reuse with the credit recorded",
			rightsStatus: "cleared",
		}),
		examples: [
			exampleOf({
				slug: "fixture-use-page-reusable",
				title: "Ambient loop cleared for reuse with the credit recorded",
				rightsStatus: "cleared",
				licenceSpdx: "CC0-1.0",
				licenceEvidence:
					'"This work has been released into the public domain."\n— LICENSE, read at the commit recorded below.',
				attribution: "Public domain. No attribution required, and none is claimed.",
				sourceUrl: "https://github.com/example/ambient-loops",
				sourceRepo: "example/ambient-loops",
				sourceRef: "c0ffee1",
				sourcePath: "loops/room-tone-90s.wav",
				contentHash: HASH,
				downloadable: true,
			}),
		],
	},
	{
		slug: "fixture-use-page-not-retained",
		note: "permitted and not retained — a count above zero with nothing behind it, which is a state the catalogue cannot reach either",
		possibility: usePossibility("fixture-use-page-not-retained", {
			title: "Noise floor cleared upstream and not kept here",
			rightsStatus: "cleared",
		}),
		examples: [
			exampleOf({
				slug: "fixture-use-page-not-retained",
				title: "Noise floor cleared upstream and not kept here",
				rightsStatus: "cleared",
				licenceSpdx: "MIT",
				licenceEvidence:
					'"Permission is hereby granted, free of charge, to any person obtaining a copy."\n— LICENSE, read at the commit recorded below.',
				attribution: '"noise-floor" by T. Okafor, MIT.',
				sourceUrl: "https://github.com/example/noise-floor",
				sourceRepo: "example/noise-floor",
				sourceRef: "beef123",
				sourcePath: "audio/floor.wav",
			}),
		],
	},
];

/** Every fixture selection slug is namespaced, so a fixture can never shadow a real entry. */
export const USE_PAGE_FIXTURE_PREFIX = "fixture-use-page-";

/**
 * The fixture selection for a slug, or null.
 *
 * A lookup rather than a filter so the caller can tell "no such fixture" from
 * "a fixture with no examples" — the second is a state a use page has to render
 * and the first is a 404. The prefix is part of the contract: no fixture slug may
 * collide with a catalogue slug, so this can never shadow a real entry.
 */
export function usePageFixtureFor(slug: string | undefined | null): UsePageFixture | null {
	if (!slug || !slug.startsWith(USE_PAGE_FIXTURE_PREFIX)) return null;
	return USE_PAGE_FIXTURES.find((fixture) => fixture.slug === slug) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Signals: ratings and reports (#37)                                          */
/* -------------------------------------------------------------------------- */

/**
 * A reader, for the states that require one.
 *
 * Only the fields the panel stores are present. It is a literal like every other
 * fixture here: nothing reads the clock or the database, so the same seven
 * states render the same pixels in a week.
 */
const reader = { id: "fixture-reader", email: "reader@example.invalid", name: "A reader" };

/** A row as `signals.ts` projects one, for the open-reports state. */
const report = (id: string, reason: ReportReason, detail: string | null): Report => ({
	id,
	subjectType: "possibility",
	subjectSlug: "fixture-signal",
	reason,
	detail,
	userId: reader.id,
	userEmail: reader.email,
	resolution: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * The rating and report states the drill-in can be in (#47).
 *
 * Until these existed, every one of these states was reachable only by signing
 * in to a live CMS and finding an entry somebody else had already rated. The
 * catalogue holds no ratings and no reports at all right now — `24 of 24`
 * entries are `reference` with `0` verified sources — so the drill-in renders
 * exactly one of the seven states below and the other six had never been seen.
 *
 * A single rating is deliberately included on its own: `ratingSummary` says
 * "1 rating" rather than hiding it, and the question is whether that still reads
 * as an opinion rather than a score. Whether it does is not answerable from the
 * source.
 */
export interface SignalFixture {
	note: string;
	/** EmDash's authenticated user, or null for the signed-out state. */
	viewer: Actor | null;
	community: Aggregate;
	openReports: Report[];
}

export const SIGNAL_FIXTURES: SignalFixture[] = [
	{
		note: "signed out, never rated — the state the catalogue is actually in",
		viewer: null,
		community: emptyAggregate(),
		openReports: [],
	},
	{
		note: "signed in, never rated — the form is live and nothing is chosen",
		viewer: reader,
		community: emptyAggregate(),
		openReports: [],
	},
	{
		note: "one rating from somebody else — a count, not a score",
		viewer: reader,
		community: aggregateRatings([{ stars: 4, userId: "someone-else" }]),
		openReports: [],
	},
	{
		note: "twelve ratings, spread across every star — the distribution bars",
		viewer: reader,
		community: aggregateRatings([
			...Array.from({ length: 5 }, () => ({ stars: 5, userId: "a" })),
			...Array.from({ length: 3 }, () => ({ stars: 4, userId: "b" })),
			...Array.from({ length: 2 }, () => ({ stars: 3, userId: "c" })),
			{ stars: 2, userId: "d" },
			{ stars: 1, userId: "e" },
		]),
		openReports: [],
	},
	{
		note: "rated by this reader — the control says Change, not Rate",
		viewer: reader,
		community: aggregateRatings(
			[
				{ stars: 3, userId: "a" },
				{ stars: 4, userId: "b" },
				{ stars: 5, userId: "c" },
				{ stars: 5, userId: reader.id },
			],
			reader.id,
		),
		openReports: [],
	},
	{
		note: "rated, but signed out — the numbers are public, the control is not",
		viewer: null,
		community: aggregateRatings([
			{ stars: 5, userId: "a" },
			{ stars: 4, userId: "b" },
			{ stars: 4, userId: "c" },
		]),
		openReports: [],
	},
	{
		note: "report filed and still open — including a licence concern",
		viewer: reader,
		community: aggregateRatings([{ stars: 2, userId: "a" }, { stars: 5, userId: reader.id }], reader.id),
		openReports: [
			report("fixture-report-1", "licence-changed", "The status no longer matches what the source says."),
			report("fixture-report-2", "dead-source", null),
		],
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
		why: "upstream, derived, generated and none. These must never be mixed in a row without their labels, and never be confusable at a glance.",
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