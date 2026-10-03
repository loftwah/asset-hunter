/**
 * Reading and writing ratings and reports through EmDash.
 *
 * Both are EmDash content, not a side table, which is what makes moderation the
 * CMS's job rather than a second system somebody has to remember to check. The
 * collections are low volume by nature — a handful of rows per subject — so they
 * do not have the problem the architecture warns about for hunt state, where
 * thousands of rows would make the admin useless.
 *
 * `Astro.locals.user` is EmDash's authenticated identity, so a rating is
 * attributable without this app inventing its own accounts.
 *
 * ## What #62 changed here
 *
 * This file was the clearest case in the repository of hand-rolled error
 * handling. Every write ended in a thrown string:
 *
 * ```ts
 * if (!created.ok) {
 *   throw new Error(`create rating → HTTP ${created.status} ${(await created.text()).slice(0, 120)}`)
 * }
 * ```
 *
 * and the route caught it with `err instanceof Error ? err.message : "unknown
 * error"` and pasted the result into a redirect note the reader sees. So an HTTP
 * status and a slice of a CMS error page were on their way to a public URL, a
 * retry decision was unanswerable, and a body that was not the shape we expected
 * was one `?.` away from being an empty object.
 *
 * Now: writes go through {@link EmDashContentApi}, which returns a typed
 * `EmDashWriteError` (with the status) or a typed `EmDashTransportError` (no
 * status at all, so the only retryable kind). Reads go through
 * {@link EmDashContent} and are Schema-decoded. The pure work — aggregation,
 * identity narrowing, the honest-count rules — stayed plain TypeScript, because
 * it is deterministic and had no business becoming an Effect.
 *
 * `actorFrom` in particular is still a plain function: `tests/signals.test.ts`
 * calls it with seven different junk values, and a synchronous predicate that
 * returns `Actor | null` is the right shape for that. Making it an Effect would
 * have added a runtime for no gain.
 */

import { Clock, Effect } from "effect";
import {
	EmDashContent,
	EmDashContentApi,
	type EmDashReadError,
	type EmDashRequest,
	type EmDashWrite,
} from "./effect/emdash.ts";
import { CatalogueDecodeError } from "./effect/errors.ts";
import { decodeOr } from "./effect/decode.ts";
import { slugSafe } from "./security.ts";
import { RatingData, ReportData, type RawEntryValue } from "./effect/schemas.ts";
import {
	aggregateRatings,
	reportsForSubject,
	parseReason,
	parseStars,
	parseSubjectType,
	type Aggregate,
	type Report,
	type ReportReason,
	type Rating,
	type Signal,
	type SubjectType,
} from "./rating.ts";

/** The failure channel of every read in this module. */
type SignalRead<A> = Effect.Effect<A, EmDashReadError, EmDashContent>;

/**
 * A CMS text field.
 *
 * A blank string is treated as absent, because an admin who clears a field
 * leaves `""` and there is no difference between that and never having set it.
 */
const str = (value: string | null | undefined): string | null =>
	typeof value === "string" && value.trim() ? value : null;

const decodeRatingRow = decodeOr(RatingData, "rating row");
const decodeReportRow = decodeOr(ReportData, "report row");

/** Names the record that failed, because a schema cannot know the slug. */
const named = (subject: string) =>
	Effect.mapError(
		(error: CatalogueDecodeError) => new CatalogueDecodeError({ subject, detail: error.detail }),
	);

/**
 * Every rating. Low volume by design, so one query and an in-memory fold.
 *
 * A row that cannot be read is *dropped*, not fatal: one malformed row must not
 * cost a reader the other four hundred ratings, and a rating that cannot be
 * parsed cannot be honestly displayed anyway. The alternative — failing the whole
 * page — turns one bad row into a blank wall.
 */
export function loadRatings(): SignalRead<Rating[]> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const page = yield* emdash.collection("ratings", { limit: 500 });
		const rows = yield* Effect.forEach(page.entries, (row) =>
			toRating(row).pipe(Effect.catchTag("CatalogueDecodeError", () => Effect.succeed(null))),
		);
		return rows.filter((rating): rating is Rating => rating !== null);
	});
}

/** Every report. Same tolerance as ratings, for the same reason. */
export function loadReports(): SignalRead<Report[]> {
	return Effect.gen(function* () {
		const emdash = yield* EmDashContent;
		const page = yield* emdash.collection("reports", { limit: 500 });
		const rows = yield* Effect.forEach(page.entries, (row) =>
			toReport(row).pipe(Effect.catchTag("CatalogueDecodeError", () => Effect.succeed(null))),
		);
		return rows.filter((report): report is Report => report !== null);
	});
}

/** Projects a validated rating row. The validation is the Effect part. */
function toRating(entry: RawEntryValue): Effect.Effect<Rating | null, CatalogueDecodeError> {
	return decodeRatingRow(entry.data).pipe(
		Effect.map((d): Rating | null => {
			const stars = parseStars(d.stars);
			const subjectType = parseSubjectType(d.subject_type);
			const subjectSlug = str(d.subject_slug);
			// The three refusals are the three the tests assert: no stars, no known
			// subject type, no subject. A rating missing any of them is not a rating,
			// and storing it would drag every average towards nothing.
			if (stars === null || !subjectType || !subjectSlug) return null;
			return {
				id: entry.id,
				subjectType,
				subjectSlug,
				stars,
				userId: str(d.user_id) ?? "",
				userEmail: str(d.user_email),
				signal: (str(d.signal) as Signal) ?? "community",
				createdAt: entry.createdAt ?? "",
				updatedAt: entry.updatedAt ?? "",
			};
		}),
		named(entry.id),
	);
}

/** Projects a validated report row. The validation is the Effect part. */
function toReport(entry: RawEntryValue): Effect.Effect<Report | null, CatalogueDecodeError> {
	return decodeReportRow(entry.data).pipe(
		Effect.map((d): Report | null => {
			const reason = parseReason(d.reason);
			const subjectType = parseSubjectType(d.subject_type);
			const subjectSlug = str(d.subject_slug);
			if (!reason || !subjectType || !subjectSlug) return null;
			return {
				id: entry.id,
				subjectType,
				subjectSlug,
				reason,
				detail: str(d.detail),
				userId: str(d.user_id),
				userEmail: str(d.user_email),
				resolution: str(d.resolution),
				createdAt: entry.createdAt ?? "",
				updatedAt: entry.updatedAt ?? "",
			};
		}),
		named(entry.id),
	);
}

/** Aggregates for every subject, in one pass. Pure and deterministic. */
export function aggregateBySubject(ratings: Rating[], viewerId?: string | null) {
	const groups = new Map<string, Rating[]>();
	for (const rating of ratings) {
		const key = `${rating.subjectType}:${rating.subjectSlug}`;
		const existing = groups.get(key);
		if (existing) existing.push(rating);
		else groups.set(key, [rating]);
	}
	const out = new Map<string, Aggregate>();
	for (const [key, list] of groups) out.set(key, aggregateRatings(list, viewerId));
	return out;
}

export interface Actor {
	id: string;
	email: string | null;
	name: string | null;
}

/**
 * EmDash's session user, narrowed to what this app stores.
 *
 * Plain and synchronous on purpose: it is a narrowing of an `unknown` EmDash
 * hands us, it is called from `.astro` frontmatter and from tests with seven
 * different junk values, and there is nothing effectful about it.
 */
export function actorFrom(user: unknown): Actor | null {
	if (!user || typeof user !== "object") return null;
	const u = user as Record<string, unknown>;
	const id = str(typeof u.id === "string" ? u.id : null);
	if (!id) return null;
	// A disabled account keeps its ratings but cannot add new ones; the auth layer
	// refuses the session, and this is the belt to that braces.
	if (u.disabled === true) return null;
	return {
		id,
		email: str(typeof u.email === "string" ? u.email : null),
		name: str(typeof u.name === "string" ? u.name : null),
	};
}

/**
 * The data half of a rating row. Named so the field set is written once, and so
 * a reader looking at the admin can see at a glance which of the three signals
 * this is.
 */
const ratingData = (
	subjectType: SubjectType,
	subjectSlug: string,
	stars: number,
	actor: Actor,
): Record<string, unknown> => ({
	title: `${stars}/5 — ${subjectSlug}`,
	subject_type: subjectType,
	subject_slug: subjectSlug,
	stars,
	user_id: actor.id,
	user_email: actor.email,
	signal: "community" as Signal,
});

/**
 * A rating's slug is derived from who and what, not from a counter.
 *
 * That is what makes "one person, one active rating" a property of the data
 * rather than of a code path: two clicks in the same second cannot produce two
 * rows, and a reader revising an opinion edits the same entry.
 */
const ratingSlug = (subjectType: SubjectType, subjectSlug: string, userId: string) =>
	`r-${subjectType}-${subjectSlug}-${userId}`.slice(0, 80);

/**
 * Writes a rating, replacing this reader's previous one for the same subject.
 *
 * Returns the id it ended up at, which is a pre-existing entry when the reader is
 * revising and a new one when they are not.
 *
 * Both paths publish.
 *
 * EmDash keeps an update as a draft revision until it is published, and the
 * public read shows the live revision. So an update that is not published
 * succeeds, returns 200, and changes nothing a reader can see — which is exactly
 * what happened the first time this was tested: "4/5" stayed "4/5" after a reader
 * changed it to five, with no error anywhere. The publish step is therefore
 * explicit, and its failure is a distinct typed error rather than a bare throw.
 */
export function saveRating(
	request: EmDashRequest,
	input: { subjectType: SubjectType; subjectSlug: string; stars: number; actor: Actor },
): Effect.Effect<
	{ id: string; replaced: boolean },
	EmDashWrite | CatalogueDecodeError,
	EmDashContentApi | EmDashContent
> {
	return Effect.gen(function* () {
		const { subjectType, subjectSlug, stars, actor } = input;
		const api = yield* EmDashContentApi;
		const existing = yield* findRating(request, actor.id, subjectType, subjectSlug);
		const data = ratingData(subjectType, subjectSlug, stars, actor);
		const slug = existing
			? yield* Effect.gen(function* () {
					yield* api.update(request, "ratings", existing.id, data, existing.rev);
					return existing.id;
				})
			: yield* api.create(
					request,
					"ratings",
					ratingSlug(subjectType, subjectSlug, actor.id),
					data,
				);
		yield* api.publish(request, "ratings", slug);
		return { id: slug, replaced: Boolean(existing) };
	});
}

/**
 * This reader's existing rating for one subject, if any.
 *
 * ## Two paths, because the cheap one is nearly always the whole answer (#53)
 *
 * `ratingSlug` already decides the id a rating lands on, so the entry can be
 * read *directly* — one GET. The previous version ignored that and loaded the
 * whole ratings collection (up to 500 rows) on every single rating POST, purely
 * to discover the id. That made each write cost a full collection read, which is
 * the wrong shape for an endpoint reachable in a loop.
 *
 * The scan is kept as a fallback, for entries written before the naming scheme
 * or renamed by EmDash on a slug conflict. It only runs when the direct read
 * found nothing, which is the first rating a reader ever files.
 *
 * `null` rather than a failure when the entry cannot be read back: the next step
 * is a create-or-update decision, and "I cannot tell" is not a reason to refuse a
 * reader their rating. A genuine write failure later is still reported.
 */
function findRating(
	request: EmDashRequest,
	userId: string,
	subjectType: SubjectType,
	subjectSlug: string,
): Effect.Effect<
	{ id: string; rev: string } | null,
	EmDashWrite | CatalogueDecodeError,
	EmDashContentApi | EmDashContent
> {
	return Effect.gen(function* () {
		const api = yield* EmDashContentApi;
		const expected = ratingSlug(subjectType, subjectSlug, userId);
		const direct = yield* readEntry(api, request, expected);
		if (direct) return direct;
		const ratings = yield* loadRatings();
		const mine = ratings.find(
			(r) => r.userId === userId && r.subjectType === subjectType && r.subjectSlug === subjectSlug,
		);
		if (!mine || mine.id === expected) return null;
		return yield* readEntry(api, request, mine.id);
	});
}

/** One entry read, with "cannot read it" collapsed into "it is not there". */
function readEntry(
	api: EmDashContentApi["Service"],
	request: EmDashRequest,
	slug: string,
): Effect.Effect<{ id: string; rev: string } | null, EmDashWrite> {
	return api
		.read(request, "ratings", slug)
		.pipe(
			Effect.catchTag("EmDashWriteError", () => Effect.succeed(null)),
			Effect.catchTag("EmDashTransportError", () => Effect.succeed(null)),
		)
		.pipe(Effect.map((found) => (found?.rev ? { id: slug, rev: found.rev } : null)));
}

/**
 * Records a report. Never overwrites: a report is a history of concerns.
 *
 * ## The slug is derived, not generated (#53)
 *
 * It used to carry `Date.now()`, which makes every report a guaranteed-new row.
 * That is the right instinct for "a report is a history" and the wrong outcome
 * for abuse: one signed-in account could create unlimited rows in the
 * moderation queue at one request each, and the queue is the thing an editor has
 * to read.
 *
 * So the slug is `rep-<subject>-<reader>-<reason>-<window bucket>`. Two
 * consequences, both wanted:
 *
 * - filing the same concern about the same entry twice inside the window
 *   produces the *same* slug, so EmDash answers 409 instead of storing a second
 *   row. The route turns that into "Already filed", which is true.
 * - the identity is in the slug, so a reader's reports about one entry are
 *   greppable from the admin without decoding a field.
 *
 * The window is coarse on purpose. Ten minutes is long enough that a person who
 * mis-clicks, or who is arguing with the form and presses submit twice, is never
 * refused, and short enough that the storage bound is a handful of rows per
 * reader per entry per reason.
 */
export function createReport(
	request: EmDashRequest,
	input: {
		subjectType: SubjectType;
		subjectSlug: string;
		reason: ReportReason;
		detail: string | null;
		actor: Actor | null;
	},
): Effect.Effect<void, EmDashWrite, EmDashContentApi> {
	return Effect.gen(function* () {
		const { subjectType, subjectSlug, reason, detail, actor } = input;
		const data: Record<string, unknown> = {
			title: `${reason} — ${subjectSlug}`,
			subject_type: subjectType,
			subject_slug: subjectSlug,
			reason,
			detail,
			user_id: actor?.id ?? null,
			user_email: actor?.email ?? null,
		};
		const api = yield* EmDashContentApi;
		// `Clock`, not `Date.now()`, so a test can pin the window and the rule
		// stays substitutable — see `docs/EFFECT_STYLE.md`.
		const millis = yield* Clock.currentTimeMillis;
		const slug = yield* api.create(
			request,
			"reports",
			reportSlug({ subjectType, subjectSlug, reason, actorId: actor?.id ?? null, millis }),
			data,
		);
		yield* api.publish(request, "reports", slug);
	});
}

/** How long one reader has to wait before the same concern is a new report. */
export const REPORT_WINDOW_MS = 10 * 60_000;

/**
 * The slug a report lands on, given who, about what, and when.
 *
 * Takes the millis rather than reading the clock so the rule is a pure function
 * and `Clock` stays a dependency of the effect that uses it — see
 * `docs/EFFECT_STYLE.md`. The bucket is a plain division, so no date formatting
 * is involved and the value is stable across timezones and locales.
 *
 * Every component goes through `slugSafe`. The route validates `subjectSlug`
 * before it gets here, but a slug is also a URL segment and a column value, and
 * the function that builds one should not depend on a caller having checked
 * first: a `../` in a subject would otherwise become a path in EmDash's content
 * API URL.
 */
export function reportSlug(input: {
	subjectType: SubjectType;
	subjectSlug: string;
	reason: ReportReason;
	actorId: string | null;
	millis: number;
}): string {
	const bucket = Math.floor(input.millis / REPORT_WINDOW_MS).toString(36);
	return [
		"rep",
		slugSafe(input.subjectType, "unknown"),
		slugSafe(input.subjectSlug),
		slugSafe(input.actorId ?? "anonymous", "anon"),
		slugSafe(input.reason, "other"),
		bucket,
	].join("-").slice(0, 120);
}

/**
 * Re-exported because a page that already imports the signal loaders should not
 * also have to know that `reportsForSubject` lives in `./rating.ts`.
 */
export { reportsForSubject };
