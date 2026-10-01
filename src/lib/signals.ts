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
 */

import { getEmDashCollection, getEmDashEntry } from "emdash";
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

interface RawEntry {
	id: string;
	data: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}

const str = (value: unknown): string | null =>
	typeof value === "string" && value.trim() ? value : null;

/** Every rating. Low volume by design, so one query and an in-memory fold. */
export async function loadRatings(): Promise<Rating[]> {
	const { entries } = await getEmDashCollection("ratings", {
		status: "published",
		limit: 500,
	});
	return (entries as unknown as RawEntry[])
		.map((entry) => {
			const d = entry.data;
			const stars = parseStars(d.stars);
			const subjectType = parseSubjectType(d.subject_type);
			const subjectSlug = str(d.subject_slug);
			if (stars === null || !subjectType || !subjectSlug) return null;
			return {
				id: entry.id,
				subjectType,
				subjectSlug,
				stars,
				userId: String(d.user_id ?? ""),
				userEmail: str(d.user_email),
				signal: (str(d.signal) as Signal) ?? "community",
				createdAt: entry.createdAt ?? "",
				updatedAt: entry.updatedAt ?? "",
			} satisfies Rating;
		})
		.filter((r): r is Rating => r !== null);
}

export async function loadReports(): Promise<Report[]> {
	const { entries } = await getEmDashCollection("reports", {
		status: "published",
		limit: 500,
	});
	return (entries as unknown as RawEntry[])
		.map((entry) => {
			const d = entry.data;
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
			} satisfies Report;
		})
		.filter((r): r is Report => r !== null);
}

/** Aggregates for every subject, in one pass. */
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

/** EmDash's session user, narrowed to what this app stores. */
export function actorFrom(user: unknown): Actor | null {
	if (!user || typeof user !== "object") return null;
	const u = user as Record<string, unknown>;
	const id = str(u.id);
	if (!id) return null;
	// A disabled account keeps its ratings but cannot add new ones; the auth layer
	// refuses the session, and this is the belt to that braces.
	if (u.disabled === true) return null;
	return { id, email: str(u.email), name: str(u.name) };
}

/**
 * Writes a rating, replacing this reader's previous one for the same subject.
 *
 * Returns the id it ended up at, which is a pre-existing entry when the reader
 * is revising and a new one when they are not.
 */
export async function saveRating(
	endpoint: string,
	headers: Record<string, string>,
	input: { subjectType: SubjectType; subjectSlug: string; stars: number; actor: Actor },
): Promise<{ id: string; replaced: boolean }> {
	const { subjectType, subjectSlug, stars, actor } = input;
	const existing = await findRating(endpoint, headers, actor.id, subjectType, subjectSlug);
	const data = {
		title: `${stars}/5 — ${subjectSlug}`,
		subject_type: subjectType,
		subject_slug: subjectSlug,
		stars,
		user_id: actor.id,
		user_email: actor.email,
		// Named on every row so a reader looking at the admin can tell at a glance
		// which of the three signals this is.
		signal: "community" as Signal,
	};

	// Both paths publish.
	//
	// EmDash keeps an update as a draft revision until it is published, and the
	// public read shows the live revision. So an update that is not published
	// succeeds, returns 200, and changes nothing a reader can see — which is
	// exactly what happened the first time this was tested: "4/5" stayed
	// "4/5" after a reader changed it to five, with no error anywhere.
	let slug = existing?.id ?? null;
	let replaced = Boolean(existing);

	if (!slug) {
		const created = await fetch(`${endpoint}/_emdash/api/content/ratings`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: `r-${subjectType}-${subjectSlug}-${actor.id}`.slice(0, 80),
				data,
			}),
		});
		if (!created.ok) {
			throw new Error(
				`create rating → HTTP ${created.status} ${(await created.text()).slice(0, 120)}`,
			);
		}
		const body = (await created.json()) as { data?: { item?: { slug?: string } } };
		slug = body.data?.item?.slug ?? null;
	} else {
		const updated = await fetch(`${endpoint}/_emdash/api/content/ratings/${slug}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ data, _rev: existing?.rev }),
		});
		if (!updated.ok) {
			throw new Error(`update rating → HTTP ${updated.status} `);
		}
	}

	if (slug) {
		const published = await fetch(
			`${endpoint}/_emdash/api/content/ratings/${slug}/publish`,
			{ method: "POST", headers },
		);
		if (!published.ok) {
			throw new Error(
				`publish rating → HTTP ${published.status}. The rating was saved but is not public yet.`,
			);
		}
	}
	return { id: slug ?? "", replaced };
}

/** This reader's existing rating for one subject, if any. */
async function findRating(
	endpoint: string,
	headers: Record<string, string>,
	userId: string,
	subjectType: SubjectType,
	subjectSlug: string,
): Promise<{ id: string; rev: string } | null> {
	const ratings = await loadRatings();
	const mine = ratings.find(
		(r) => r.userId === userId && r.subjectType === subjectType && r.subjectSlug === subjectSlug,
	);
	if (!mine) return null;
	const res = await fetch(`${endpoint}/_emdash/api/content/ratings/${mine.id}`, { headers });
	if (!res.ok) return null;
	const body = (await res.json()) as { data?: { _rev?: string } };
	const rev = body.data?._rev;
	return rev ? { id: mine.id, rev } : null;
}

/** Records a report. Never overwrites: a report is a history of concerns. */
export async function createReport(
	endpoint: string,
	headers: Record<string, string>,
	input: {
		subjectType: SubjectType;
		subjectSlug: string;
		reason: ReportReason;
		detail: string | null;
		actor: Actor | null;
	},
): Promise<void> {
	const { subjectType, subjectSlug, reason, detail, actor } = input;
	const data = {
		title: `${reason} — ${subjectSlug}`,
		subject_type: subjectType,
		subject_slug: subjectSlug,
		reason,
		detail,
		user_id: actor?.id ?? null,
		user_email: actor?.email ?? null,
	};
	const res = await fetch(`${endpoint}/_emdash/api/content/reports`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			slug: `rep-${subjectType}-${subjectSlug}-${Date.now().toString(36)}`,
			data,
		}),
	});
	if (!res.ok) throw new Error(`create report → HTTP ${res.status}`);
	const body = (await res.json()) as { data?: { item?: { slug?: string } } };
	const slug = body.data?.item?.slug;
	if (slug) {
		const published = await fetch(`${endpoint}/_emdash/api/content/reports/${slug}/publish`, {
			method: "POST",
			headers,
		});
		if (!published.ok) {
			throw new Error(
				`publish report → HTTP ${published.status}. It is stored but not visible to an editor.`,
			);
		}
	}
}

export { getEmDashEntry, reportsForSubject };