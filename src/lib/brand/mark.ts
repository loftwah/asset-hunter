/**
 * The aperture mark — the single source of truth for the Asset Hunter identity.
 *
 * The mark used to be drawn twice: inline in `Wordmark.astro` and again by hand
 * in `public/favicon.svg`. Nothing compared the two, so they drifted. It is in
 * fact *already* drifted: the committed `apple-touch-icon.png` had lost the
 * inner ring entirely, which is the exact failure this module exists to make
 * impossible. Everything that draws the mark — the Astro component, the favicon,
 * the PNG icon set, the brand kit — goes through here, and `npm run brand:check`
 * plus `tests/brand.test.ts` fail if any of them stops agreeing.
 *
 * Two forms, because one form cannot do two jobs:
 *
 * - `full` is the mark. Two concentric rings, four sighting ticks and the
 *   lozenge. The ticks are what make it a *hunting sight* rather than a
 *   bullseye, and the lozenge is the thing being located.
 * - `compact` is the icon form, and it is not a shrunken `full`. Measured at
 *   favicon sizes, the `full` mark's ticks overlap the outer ring's stroke band
 *   (tick r 5.85–9.25, ring band 8.5–10.0) so they fuse, and its 42%-opacity
 *   ring dithers to a muddy brick over near-black. At 16px `full` is an
 *   orange donut with a cross in it. `compact` drops the ticks and the inner
 *   ring, drops the opacity, and thickens the remaining ring to two device
 *   pixels at 16px — the same idea, drawn at a size where it survives.
 *
 * Everything here is deterministic, synchronous and pure, so it is plain
 * TypeScript rather than Effect (AGENTS.md: domain logic stays plain). No
 * filesystem, no I/O, no `Math.random` — the byte-for-byte asset check depends
 * on that.
 */

/** The mark's drawing box, in units. Every variant uses this same grid. */
export const MARK_BOX = 24;

/**
 * The clear-space band, in mark units, on every side of the mark and of the
 * lockup. Three units is twice the `full` form's 1.5-unit stroke and four times
 * its lozenge half-width, so nothing else on the page can crowd the mark
 * without touching a stroke. Written into DESIGN.md §9.4 and asserted against
 * there by `tests/brand.test.ts`.
 */
export const MARK_CLEAR_SPACE = 3;

/**
 * Smallest rendered size each form is drawn at, in CSS pixels.
 *
 * `full` is 32 rather than 16 because it was measured, not guessed: the ticks
 * are already gone at the masthead's 20px. `compact` is 16, which is the
 * smallest a browser tab or an Android launcher is ever going to ask for.
 */
export const MARK_MIN_SIZE_PX = { full: 32, compact: 16 } as const;

/**
 * The three inks the mark is allowed to be drawn in, by name, so a variant can
 * never invent a fourth. Values are the DESIGN.md §2 tokens; `tests/brand.test.ts`
 * asserts they still match `src/styles/global.css`.
 */
export const MARK_INK = {
	canvas: "#08090a",
	ink: "#f4f2ee",
	ember: "#ff5a1f",
} as const;

export type MarkInkName = keyof typeof MARK_INK;

/** Which form to draw. `full` is the mark; `compact` is the icon form. */
export type MarkDetail = "full" | "compact";

/**
 * One drawn element. `attrs` is the attribute map verbatim, so the Astro
 * component can spread it onto a real element and the serialiser can write it
 * into a file, and the two cannot disagree about what the mark looks like.
 */
export interface MarkElement {
	tag: "circle" | "path";
	attrs: Record<string, string>;
}

/** The lozenge — the thing being located. Identical in both forms. */
const LOZENGE = "M12 9.4 13.5 12 12 14.6 10.5 12Z";

/**
 * The full mark. Order matters: it is painted back to front, and the lozenge is
 * last so nothing can clip it.
 */
function fullShapes(ink: string): MarkElement[] {
	return [
		{
			tag: "circle",
			attrs: { cx: "12", cy: "12", r: "9.25", fill: "none", stroke: ink, "stroke-width": "1.5", opacity: ".42" },
		},
		{
			tag: "circle",
			attrs: { cx: "12", cy: "12", r: "5", fill: "none", stroke: ink, "stroke-width": "1.5" },
		},
		{
			tag: "path",
			attrs: {
				d: "M12 2.75v3.4M12 17.85v3.4M2.75 12h3.4M17.85 12h3.4",
				fill: "none",
				stroke: ink,
				"stroke-width": "1.5",
				"stroke-linecap": "round",
				opacity: ".42",
			},
		},
		{ tag: "path", attrs: { d: LOZENGE, fill: ink } },
	];
}

/**
 * The icon form. See the note at the top of this file for why each element of
 * `full` is absent here rather than merely scaled.
 *
 * The numbers come from rendering candidates at 16/20/32/48px and looking at
 * them (`docs/BRAND-DIRECTIONS.md` records the comparison):
 *
 * - A 2.5-unit stroke is 1.67px at the 16px floor — the thinnest ring that still
 *   reads as a ring rather than a hairline. 2.25 was tried and went grey; 3 was
 *   tried and read as a washer.
 * - The ring's inner edge sits at r 8.0, so there are 4.8 units — 3.2px at 16px —
 *   of clear negative space between the ring and the lozenge. That is what keeps
 *   it reading as a ring *around* something rather than a disc with a nick in it.
 * - The lozenge grows from 3×5.2 to 4×6.4 units. At 16px the full form's lozenge
 *   is 2×3.5px and is swallowed by the ring; this one is 2.7×4.3px and holds.
 *
 * The result carries one unit more ink than `full` (its outer edge is r 10.5
 * against the full mark's 10.0), which is deliberate: an icon wants more
 * presence at 16px, and at 48px the difference reads as weight rather than
 * error.
 */
function compactShapes(ink: string): MarkElement[] {
	return [
		{
			tag: "circle",
			attrs: { cx: "12", cy: "12", r: "9.25", fill: "none", stroke: ink, "stroke-width": "2.5" },
		},
		{ tag: "path", attrs: { d: "M12 8.8 14 12 12 15.2 10 12Z", fill: ink } },
	];
}

/**
 * The mark's elements, in paint order.
 *
 * `ink` defaults to `currentColor` so the inline component inherits ink on
 * every surface it lands on — masthead, footer, a light card — which is the
 * whole reason the component is inline SVG rather than an `<img>`.
 */
export function markShapes(detail: MarkDetail = "full", ink = "currentColor"): MarkElement[] {
	return detail === "compact" ? compactShapes(ink) : fullShapes(ink);
}

export interface MarkSvgOptions {
	/** Which form to draw. */
	detail?: MarkDetail;
	/** Ink colour, or `"currentColor"` for the inline form. */
	ink?: string;
	/** Opaque ground behind the mark. Omitted for transparent variants. */
	ground?: string;
	/** Intrinsic `width`/`height`. Omitted so a kit file scales freely. */
	size?: number;
	/** `aria-label`. Standalone files must have one; `scripts/check-specimens.mjs` requires it. */
	label?: string;
	/**
	 * Draw the mark at this fraction of the box, centred. Used by the maskable
	 * icon, where the mark has to stay inside Android's safe zone rather than
	 * run edge to edge where any launcher mask would crop it.
	 */
	scale?: number;
}

function serialiseElement({ tag, attrs }: MarkElement): string {
	const body = Object.entries(attrs)
		.map(([name, value]) => `${name}="${value}"`)
		.join(" ");
	return `\t<${tag} ${body} />`;
}

/**
 * A standalone `<svg>` document for a variant.
 *
 * Deterministic down to the whitespace, because `npm run brand:check` compares
 * the generated bytes with the committed bytes and `tests/brand.test.ts`
 * asserts the same files are still what this function returns. A pretty-printer
 * here would turn the check into a formatting lint instead of a drift check.
 */
export function markSvg({
	detail = "full",
	ink = MARK_INK.ink,
	ground,
	size,
	label,
	scale,
}: MarkSvgOptions = {}): string {
	const attrs: string[] = [`xmlns="http://www.w3.org/2000/svg"`, `viewBox="0 0 ${MARK_BOX} ${MARK_BOX}"`];
	if (size !== undefined) attrs.push(`width="${size}"`, `height="${size}"`);
	// A brand asset that can execute is a security problem, not a branding one
	// (#53), so the exported files carry no script, no external reference and no
	// event handler. `fill="none"` on the root keeps the lozenge's fill from
	// leaking onto the strokes if an element ever omits it.
	attrs.push(`fill="none"`, `role="img"`);
	if (label) attrs.push(`aria-label="${label}"`);

	const body: string[] = [];
	if (ground) body.push(`\t<rect width="${MARK_BOX}" height="${MARK_BOX}" fill="${ground}" />`);

	const shapes = markShapes(detail, ink);
	if (scale !== undefined && scale !== 1) {
		const offset = ((MARK_BOX - MARK_BOX * scale) / 2).toFixed(3).replace(/\.?0+$/, "");
		body.push(`\t<g transform="translate(${offset} ${offset}) scale(${scale})">`);
		for (const element of shapes) body.push(`\t${serialiseElement(element)}`);
		body.push("\t</g>");
	} else {
		for (const element of shapes) body.push(serialiseElement(element));
	}

	return `<svg ${attrs.join(" ")}>\n${body.join("\n")}\n</svg>\n`;
}

/**
 * The clear-space and minimum-size diagram, generated rather than drawn.
 *
 * It states `MARK_CLEAR_SPACE` and `MARK_MIN_SIZE_PX` in mark units and in
 * pixels, both read from the constants above. A hand-drawn version of this
 * diagram is how a brand document ends up asserting a clear space the code
 * does not honour, which is worse than having no diagram at all.
 *
 * Three panels on one baseline, spaced far enough apart that the labels cannot
 * collide — `scripts/check-specimens.mjs` measures label collisions and this
 * diagram is held to the same rule as a plate, because it is a plate.
 *
 * Mono annotations, `tag` voice, on the canvas ground — the same grammar as a
 * specimen plate (DESIGN.md §6), because a brand document is a plate too.
 */
export function clearSpaceSvg(label: string): string {
	const clear = MARK_CLEAR_SPACE;
	const font = 3.4;
	const baseline = 41;
	const width = 144;
	const height = 46;
	const text = (x: number, content: string) =>
		`\t<text x="${x}" y="${baseline}" font-family="ui-monospace, monospace" font-size="${font}" fill="#8b929a" text-anchor="middle">${content}</text>`;

	/** One panel: the mark on its 24-unit grid, optionally with its clear band. */
	const panel = (px: number, py: number, detail: MarkDetail, clearBand: boolean) => {
		const body = markShapes(detail, MARK_INK.ember)
			.map(({ tag, attrs }) => {
				const serialised = Object.entries(attrs)
					.map(([name, value]) => `${name}="${value}"`)
					.join(" ");
				return `\t\t<${tag} ${serialised} />`;
			})
			.join("\n");
		const band = clearBand
			? `\t<rect x="${px - clear}" y="${py - clear}" width="${MARK_BOX + clear * 2}" height="${MARK_BOX + clear * 2}" fill="none" stroke="#343b42" stroke-width="0.25" stroke-dasharray="1.2 1.2" />\n`
			: "";
		return `${band}\t<g transform="translate(${px} ${py})">\n${body}\n\t</g>`;
	};

	const left = 4;
	const middle = 58;
	const right = 109;
	/** Every panel's mark sits on the same baseline; only `x` varies. */
	const top = 6;

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">
	<rect width="${width}" height="${height}" fill="${MARK_INK.canvas}" />
${panel(left, top, "full", true)}
${panel(middle, top, "full", false)}
${panel(right, top, "compact", false)}
${text(left + MARK_BOX / 2, `clear space ${clear}u`)}
${text(middle + MARK_BOX / 2, `full ${MARK_MIN_SIZE_PX.full}px min`)}
${text(right + MARK_BOX / 2, `compact ${MARK_MIN_SIZE_PX.compact}px min`)}
</svg>
`;
}
