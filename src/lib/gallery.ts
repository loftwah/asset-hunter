/**
 * The gallery manifest: what the `/gallery` page shows and why.
 *
 * ## Why this exists rather than the page reading a directory
 *
 * Every image on the gallery is a **real capture of the running product** at a
 * real route. The project's own rule — DESIGN.md, `AGENTS.md`, and #48 — is that
 * marketing media comes from the product and never from a mock dashboard, and
 * the cheapest way to guarantee that is for the page to name its images
 * explicitly and for a test to assert every one of those names is a real file.
 *
 * A page that globbed a directory would satisfy that too, but it would also
 * mean an image's alt text and its provenance lived in a filename, which is
 * exactly the arrangement where a capture silently loses its caption and
 * nothing notices.
 *
 * ## Provenance
 *
 * `scripts/capture-reference.mjs` writes these files, from the same Playwright
 * pass that writes `reference/`. There is no second capture script and no
 * compositing step: what appears on the page is a screenshot of the product, so
 * it cannot be a prettier-than-real UI. Regenerate with:
 *
 * ```bash
 * npm run dev
 * npm run capture:reference
 * ```
 *
 * The alt text names the route and the viewport rather than describing how the
 * picture looks. A screen-reader user gets the same sentence a sighted user
 * gets from looking at it: this is the wall, this is the drill-in, at this width.
 */

export interface GalleryShot {
	/** Path under `/gallery`, as written by the capture script. */
	readonly file: string;
	/** The route the capture is of. Also the link target. */
	readonly route: string;
	/** What the capture shows, in words. Never "a screenshot of". */
	readonly caption: string;
	/** Short label for the tile. */
	readonly label: string;
	/** Intrinsic size, so the browser reserves the space and nothing shifts. */
	readonly width: number;
	readonly height: number;
	/** `true` for the phone capture, which is narrower than its neighbours. */
	readonly phone?: boolean;
}

/**
 * The order is the reading order: the wall first, because it is the product,
 * then the surfaces that answer the questions a first-time reader has.
 */
export const GALLERY_SHOTS: readonly GalleryShot[] = [
	{
		file: "/gallery/wall.png",
		route: "/",
		label: "The wall",
		caption:
			"The catalogue wall at 1280. One distinct possibility per plate, ordered by editorial rank, with the rights legend underneath.",
		width: 1280,
		height: 860,
	},
	{
		file: "/gallery/drill-in.png",
		route: "/possibilities/density-gradient",
		label: "One possibility",
		caption:
			"The drill-in for a single possibility: the technique, the build notes, a prompt scaffold, the rights in words, and every example recorded against it.",
		width: 1280,
		height: 860,
	},
	{
		file: "/gallery/search.png",
		route: "/search?q=seam",
		label: "Search",
		caption:
			"Search is a ranked list, not a grid, and each row says why it matched rather than repeating its own title.",
		width: 1280,
		height: 860,
	},
	{
		file: "/gallery/licensing.png",
		route: "/pages/licensing",
		label: "Licensing",
		caption:
			"Licensing states all four rights statuses in full sentences, because rights are never behind a hover.",
		width: 1280,
		height: 860,
	},
	{
		file: "/gallery/phone.png",
		route: "/",
		label: "On a phone",
		caption:
			"The wall at 390 wide. The catalogue is above the fold here too: the intro is a band, not a hero.",
		width: 390,
		height: 844,
		phone: true,
	},
];

/** The wide captures, in reading order. The phone capture is set apart. */
export const GALLERY_WIDE = GALLERY_SHOTS.filter((shot) => !shot.phone);

/** The phone capture, if the capture run produced one. */
export const GALLERY_PHONE = GALLERY_SHOTS.find((shot) => shot.phone) ?? null;
