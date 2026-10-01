/**
 * Community ratings and problem reports (#37).
 *
 * Three signals exist and are kept apart on purpose:
 *
 * 1. **Machine quality** — `novelty`, `coverage`, file analysis. Derived by the
 *    engine, null when not measured.
 * 2. **Community rating** — one reader's stars. Stored here.
 * 3. **Editorial judgement** — `editorial_rank`, `featured`. A person's
 *    decision in the CMS.
 *
 * The temptation is to collapse them into one number. That is refused, because
 * a star from a reader and an inspection score are not the same kind of claim,
 * and a blend of them cannot be explained to anyone who asks what it means.
 * Ranking may use them; the raw values stay inspectable.
 *
 * **One person, one active rating.** Changing a rating updates the existing
 * entry rather than adding another, so a reader who revises their opinion
 * revises it rather than voting twice.
 */

export type SubjectType = "possibility" | "example";

/** The three signals, named so none of them can be mistaken for another. */
export type Signal = "community" | "editorial" | "machine";

export const SIGNAL_MEANING: Record<Signal, string> = {
	community: "One reader's stars. An average of these is not a quality score.",
	editorial: "A curator's decision in the admin. Not the same thing as popularity.",
	machine: "Derived by inspecting the source. Null when nothing was measured.",
};

export type ReportReason =
	| "wrong-classification"
	| "duplicate"
	| "broken-preview"
	| "licence-changed"
	| "dead-source"
	| "misleading-metadata"
	| "other";

/**
 * Report reasons, each with the action it implies.
 *
 * `licence-changed` is the one that matters most and is the reason reports are
 * not ratings: somebody noticed that a "cleared" example is no longer cleared,
 * and that is a correction, not a bad opinion. Averaging it into a star would
 * make the catalogue quietly wrong and unfixable.
 */
export const REPORTS: Record<
	ReportReason,
	{ label: string; means: string; action: string }
> = {
	"wrong-classification": {
		label: "Wrong classification or label",
		means: "The vertical, media kind or origin does not describe what is there.",
		action: "An editor checks the classification against the source.",
	},
	duplicate: {
		label: "Duplicate",
		means: "This demonstrates a possibility that is already catalogued.",
		action: "An editor merges it into the existing possibility.",
	},
	"broken-preview": {
		label: "Broken or missing preview",
		means: "The plate, image or preview does not render.",
		action: "An editor regenerates or replaces the representative media.",
	},
	"licence-changed": {
		label: "Licence or provenance looks wrong or has changed",
		means:
			"The rights status may no longer be justified by the source. This takes priority over every other reason here.",
		action:
			"An editor re-reads the licence evidence. Until they do, the status is treated as unverified, not as correct.",
	},
	"dead-source": {
		label: "Dead or moved source",
		means: "The upstream repository, file or URL no longer resolves.",
		action: "An editor checks for a rename or a replacement commit.",
	},
	"misleading-metadata": {
		label: "Misleading quality or metadata",
		means: "A count, a claim or a summary overstates what was measured.",
		action: "An editor reviews the field and lowers it to what the evidence supports.",
	},
	other: {
		label: "Something else",
		means: "Anything the reasons above do not cover.",
		action: "An editor reads the detail and decides.",
	},
};

export const REPORT_REASONS = Object.keys(REPORTS) as ReportReason[];

export const STARS_MIN = 1;
export const STARS_MAX = 5;

/** One reader's rating of one subject. */
export interface Rating {
	id: string;
	subjectType: SubjectType;
	subjectSlug: string;
	stars: number;
	userId: string;
	userEmail: string | null;
	signal: Signal;
	createdAt: string;
	updatedAt: string;
}

export interface Report {
	id: string;
	subjectType: SubjectType;
	subjectSlug: string;
	reason: ReportReason;
	detail: string | null;
	userId: string | null;
	userEmail: string | null;
	resolution: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * A rating is only a rating if it is a whole number in range.
 *
 * `NaN` from a form is the case worth thinking about: `Number("")` is 0,
 * `Number("five")` is NaN, and `stars: NaN` written into an aggregate turns
 * every average into NaN, which renders as an empty string. So it is refused at
 * the edge rather than repaired downstream.
 */
export function parseStars(input: unknown): number | null {
	const n = typeof input === "number" ? input : Number.parseInt(String(input ?? ""), 10);
	if (!Number.isFinite(n)) return null;
	if (n < STARS_MIN || n > STARS_MAX) return null;
	return Math.trunc(n);
}

export function parseSubjectType(input: unknown): SubjectType | null {
	return input === "possibility" || input === "example" ? input : null;
}

export function parseReason(input: unknown): ReportReason | null {
	const value = String(input ?? "");
	return REPORT_REASONS.includes(value as ReportReason) ? (value as ReportReason) : null;
}

export interface Aggregate {
	/** The mean, or null when there are no ratings. Zero is not the answer. */
	average: number | null;
	count: number;
	/** Star → count, always all five keys so the shape never changes. */
	distribution: Record<number, number>;
	/** What this reader gave it, or null if they have not rated it. */
	mine: number | null;
}

export const emptyAggregate = (): Aggregate => ({
	average: null,
	count: 0,
	distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
	mine: null,
});

/**
 * The aggregate for one subject.
 *
 * An average with one rating is reported with its count rather than hidden:
 * `1 rating` says something a bare `4.0★` does not, and hiding it would make a
 * single opinion look like a consensus.
 */
export function aggregateRatings(
	ratings: Pick<Rating, "stars" | "userId">[],
	viewerId?: string | null,
): Aggregate {
	const result = emptyAggregate();
	if (!ratings.length) return result;
	let total = 0;
	for (const rating of ratings) {
		const stars = parseStars(rating.stars);
		if (stars === null) continue;
		total += stars;
		result.distribution[stars] += 1;
		if (viewerId && rating.userId === viewerId) result.mine = stars;
	}
	result.count = Object.values(result.distribution).reduce((a, b) => a + b, 0);
	result.average = result.count > 0 ? Math.round((total / result.count) * 10) / 10 : null;
	return result;
}

/** A readable summary that never overstates what is known. */
export function ratingSummary(aggregate: Pick<Aggregate, "count" | "average">): string {
	if (!aggregate.count || aggregate.average === null) {
		return "No ratings yet. One reader's stars are not a quality score.";
	}
	const noun = aggregate.count === 1 ? "rating" : "ratings";
	return `${aggregate.average.toFixed(1)} from ${aggregate.count} ${noun}. Readers' opinion, not a quality score.`;
}

/** Star rendering that does not rely on a glyph font or on colour. */
export function starLabel(stars: number | null): string {
	if (stars === null) return "unrated";
	return `${stars} of 5`;
}

/**
 * Filters down to one subject.
 *
 * Constrained to the two fields that matter rather than the whole record, so a
 * caller can filter a list it has only partially mapped — which is what happens
 * when the same helper is used on both the CMS rows and a test fixture.
 */
type Subject = Pick<Rating, "subjectType" | "subjectSlug">;

export const forSubject = <T extends Subject>(ratings: T[], type: SubjectType, slug: string) =>
	ratings.filter((r) => r.subjectType === type && r.subjectSlug === slug);

export const reportsForSubject = <T extends Subject>(reports: T[], type: SubjectType, slug: string) =>
	reports.filter((r) => r.subjectType === type && r.subjectSlug === slug);