/**
 * What it would take to bring a deployed database up to what this repository
 * seeds — as a pure function, so the list can be read without touching anything.
 *
 * ## Why this is a list and not a command
 *
 * The gap this closes is invisible from inside the repository. Ten entries and
 * three collections were merged, gated, deployed and green in production, and the
 * only way to find out was to read the live database against the seed by hand.
 * Doing that by hand against production is how a list gets one entry wrong, so
 * the comparison lives in code, in this file, and the script only prints or runs
 * what this returns.
 *
 * ## The property that matters
 *
 * Every step is a **create**. There is no update, no delete, no
 * `--on-conflict=update`, and the test asserts that by enumerating the verbs —
 * because the useful claim is not "these commands are correct" but "this cannot
 * destroy anything". A seed is reproducible for content nobody has touched and is
 * not reproducible at all for content a curator has edited, so anything that
 * overwrites is wrong here regardless of how it is spelled.
 *
 * ## What a plan cannot reproduce, stated rather than glossed
 *
 * `emdash seed` applies `supports` — `possibilities` declares
 * `["drafts","revisions","search","seo"]`, `disputes` declares `["drafts","search"]`.
 * `emdash schema create` has no flag for it, and a collection created that way
 * arrives as `["drafts","revisions"]`: it gains revision history nobody declared
 * and loses its FTS table.
 *
 * For the three collections missing in production that is benign — nothing
 * searches a dispute, and the dispute state a reader sees is a field on the
 * example row, not a row in this collection. It would **not** be benign for
 * `possibilities`, which is why recreating an existing collection is never
 * planned: {@link planDelivery} skips anything already deployed, so the only
 * collections it will ever create are ones this repository has just introduced.
 * Verified against a throwaway collection on a local instance rather than assumed.
 */

/** A collection as `seed/seed.json` declares it, and all this function needs of it. */
export interface SeedCollection {
	readonly slug?: unknown;
	readonly label?: unknown;
	readonly labelSingular?: unknown;
	readonly description?: unknown;
	readonly fields?: ReadonlyArray<{
		readonly slug?: unknown;
		readonly label?: unknown;
		readonly type?: unknown;
		readonly required?: unknown;
	}>;
}

/** A content row as `seed/seed.json` declares it. */
export interface SeedRow {
	readonly id?: unknown;
	/**
	 * The row's public identity.
	 *
	 * Not always the `id`. An example is `id: "ex-adaptive-mark"` with
	 * `slug: "adaptive-mark"`, and it is the slug that everything else refers to —
	 * including the `possibility: "$ref:adaptive-mark"` on the row that points at it,
	 * and including the route a reader lands on. Delivering by `id` would create
	 * `ex-adaptive-mark` as a *slug*, which matches no reference and no URL.
	 *
	 * Possibilities happen to have `id === slug`, which is exactly why the first
	 * delivery was correct for them and would have been wrong for examples.
	 */
	readonly slug?: unknown;
	readonly data?: unknown;
}

export interface Seed {
	readonly collections?: ReadonlyArray<SeedCollection>;
	readonly content?: Readonly<Record<string, ReadonlyArray<SeedRow> | unknown>>;
}

export interface LiveDatabase {
	/** Collection slugs the database already has. */
	readonly collections: ReadonlySet<string>;
	/**
	 * Rows the database already has, as `"<collection>/<slug>"`.
	 *
	 * Keyed by collection because a slug is unique only *within* one. A flat set of
	 * slugs makes every example look delivered the moment its possibility exists —
	 * they share a slug — and the delivery then reports nothing to do while the
	 * catalogue serves ten entries with no specimen. That is the same shape of error
	 * as the id comparison that came before it: comparing across a boundary where the
	 * value is not unique.
	 */
	readonly entries: ReadonlySet<string>;
	/**
	 * Fields the database already has, as `"<collection slug>/<field slug>"`.
	 *
	 * Present because "the collection exists" is not the same as "the collection is
	 * finished". A run that creates `disputes` and then fails on its ninth field
	 * leaves a collection that exists and is wrong — and a plan keyed only on
	 * collection existence would skip it forever, turning one transient failure into
	 * a permanent half-built collection with no way to complete it through this
	 * script. Keying on fields makes the plan resumable, which is the only useful
	 * property for a step that talks to production.
	 */
	readonly fields?: ReadonlySet<string>;
}

/**
 * The collections a delivery creates, **in order**.
 *
 * Order is not cosmetic: an example carries `possibility: "$ref:<slug>"`, so its
 * row cannot be created before the possibility it points at exists.
 *
 * `examples` was missing from this list until it had already gone wrong once. The
 * reasoning that removed it was that examples are *served* nested inside their
 * possibility, so creating them separately would "create rows whose parent does not
 * exist". That conflated the API's response shape with storage: `seed.json` keeps
 * `content.examples` as its own collection of its own rows, and a delivery that
 * skips it produces ten possibilities with **no examples at all** — which is exactly
 * what the first delivery to production did.
 *
 * The same blind spot was in `check-deploy-parity`, so the gate agreed with the
 * remedy and neither noticed. The list is now shared deliberately rather than
 * derived, and the gate compares examples as a *pairing* — see
 * {@link LiveDatabase.seedPossessionsWithExamples} in `deploy-parity.ts` — because
 * `/api/catalogue.json` gives an example its possibility's slug as an `id`, so the
 * ids themselves are not comparable across the two sides.
 */
export const DELIVERED = ["possibilities", "examples", "collections"] as const;

/** How `seed.json` marks a relation field's target. */
const REF = "$ref:";

/** The only verbs this plan may ever emit. Asserted in the test by enumeration. */
const SAFE_VERBS = ["create", "add-field"] as const;

export interface DeliveryStep {
	/** One line naming what this step creates, for the person reading the list. */
	readonly what: string;
	readonly kind: "schema" | "content";
	/** Arguments for `npx emdash …`, without the leading binary. Schema steps only. */
	readonly args: readonly string[];
	/** What to POST. Content steps only. */
	readonly entry?: {
		readonly collection: string;
		readonly slug: string;
		readonly data: Readonly<Record<string, unknown>>;
		/**
		 * Relation fields, as `{field: [value]}`.
		 *
		 * These cannot go in `data`. EmDash refuses a payload that sets a field bound
		 * to a relation — "Reference fields bound to a relation are set through
		 * 'references', not 'data'" — and dropping it instead would report a
		 * successful write with nothing linked. They are also unreachable through
		 * `emdash content create`: its `--file` is the `data` bag, so a `references`
		 * key is rejected as an unknown field. The API is the only way to write one,
		 * which is why content steps are not CLI steps.
		 */
		readonly references: Readonly<Record<string, readonly string[]>>;
		/** Whether the seed says this row is published. */
		readonly publish: boolean;
	};
	/**
	 * A field this plan could not express, if any.
	 *
	 * Reported rather than skipped silently: a malformed field would otherwise
	 * fail at apply time against production, which is the moment a typo costs most.
	 */
	readonly warning?: string;
}

/**
 * Build the ordered list of creates that closes the gap.
 *
 * Schema first, then content, because a content row needs the collection and the
 * fields to already exist. Nothing already deployed is planned, so running this
 * against an up-to-date database returns an empty list rather than a second copy
 * of everything.
 */
export function planDelivery(seed: Seed, live: LiveDatabase): DeliveryStep[] {
	const steps: DeliveryStep[] = [];

	for (const collection of seed.collections ?? []) {
		const slug = typeof collection?.slug === "string" ? collection.slug : null;
		if (!slug) continue;

		// The collection is created only if it is absent, but its fields are planned
		// independently, so an interrupted run is finished rather than abandoned.
		if (!live.collections.has(slug)) {
			const create: string[] = ["schema", "create", slug, "--label", str(collection.label) ?? slug];
			const singular = str(collection.labelSingular);
			if (singular) create.push("--label-singular", singular);
			const description = str(collection.description);
			if (description) create.push("--description", description);
			steps.push({ what: `collection ${slug}`, kind: "schema", args: create });
		}

		let skipped = 0;
		for (const field of collection.fields ?? []) {
			const name = str(field?.slug);
			const type = str(field?.type);
			if (!name || !type) {
				skipped++;
				continue;
			}
			if (live.fields?.has(`${slug}/${name}`)) continue;
			const add = ["schema", "add-field", slug, name, "--type", type];
			const label = str(field?.label);
			if (label) add.push("--label", label);
			if (field?.required === true) add.push("--required");
			steps.push({ what: `field ${slug}.${name}`, kind: "schema", args: add });
		}
		if (skipped > 0) {
			steps.push({
				what: `warning for ${slug}`,
				kind: "schema",
				args: [],
				warning: `${slug}: ${skipped} field(s) declared no slug or type and were not planned`,
			});
		}
	}

	for (const collection of DELIVERED) {
		const rows = seed.content?.[collection];
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			// Identity is the slug, because that is what other rows reference and what
			// a reader's URL contains. `id` is the fallback for a collection whose two
			// coincide, which is every collection except `examples` today.
			const identity = str(row?.slug) ?? str(row?.id);
			if (!identity || live.entries.has(`${collection}/${identity}`)) continue;
			const data: Record<string, unknown> = {};
			const references: Record<string, string[]> = {};
			for (const [key, value] of Object.entries((row?.data ?? {}) as Record<string, unknown>)) {
				if (typeof value === "string" && value.startsWith(REF)) {
					references[key] = [value.slice(REF.length)];
				} else {
					data[key] = value;
				}
			}
			steps.push({
				what: `${collection} ${identity}`,
				kind: "content",
				args: [],
				entry: {
					collection,
					slug: identity,
					data,
					references,
					publish: (row as { status?: unknown })?.status !== "draft",
				},
			});
		}
	}

	return steps;
}

/** The command groups a step may address. Anything else is not a plan step. */
const GROUPS = ["schema", "content"] as const;

/**
 * The verb a step runs, or `null` if the step is not a recognisable command.
 *
 * The verb is the token *after* the group — `schema create`, `content create` —
 * so checking `args[0]` would compare a group name against a verb list and either
 * reject everything or, worse, accept a step like `content delete …` if the group
 * happened to share a name with a verb. Both are the kind of check that passes
 * because it never ran.
 */
export function stepVerb(args: readonly string[]): string | null {
	const [group, verb, ...rest] = args;
	if (!GROUPS.includes(group as (typeof GROUPS)[number])) return null;
	// A group with no verb, or one that swallowed a flag, is not a command.
	if (!verb || verb.startsWith("-")) return null;
	void rest;
	return verb;
}

/** Whether any step runs a verb outside {@link SAFE_VERBS}. */
export function hasUnsafeVerb(steps: readonly DeliveryStep[]): boolean {
	return steps.some((step) => {
		const verb = stepVerb(step.args);
		return verb !== null && !SAFE_VERBS.includes(verb as (typeof SAFE_VERBS)[number]);
	});
}

const str = (value: unknown): string | null =>
	typeof value === "string" && value.trim() !== "" ? value : null;
