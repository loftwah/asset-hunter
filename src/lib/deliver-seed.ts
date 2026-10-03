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
	readonly data?: unknown;
}

export interface Seed {
	readonly collections?: ReadonlyArray<SeedCollection>;
	readonly content?: Readonly<Record<string, ReadonlyArray<SeedRow> | unknown>>;
}

export interface LiveDatabase {
	/** Collection slugs the database already has. */
	readonly collections: ReadonlySet<string>;
	/** Entry ids the deployed catalogue already serves. */
	readonly entries: ReadonlySet<string>;
}

/**
 * The collections whose entries are public.
 *
 * Deliberately the same list `check-deploy-parity` compares, and for the same
 * reason: the two must not drift, or the gate and its remedy would disagree about
 * what is missing. `examples` are served nested inside their possibility, so
 * planning them separately would create rows whose parent does not exist.
 */
export const PUBLISHED = ["possibilities", "collections"] as const;

/**
 * Stands in for the `--file` path of a content create.
 *
 * The plan is pure, so it cannot write a temp file; it names the row instead, and
 * the script swaps in a real path. A prefix rather than a bare marker so a
 * placeholder can never be mistaken for a real filename.
 */
export const DATA_PLACEHOLDER = "<data for ";

/** The marker {@link planDelivery} puts where a `--file` path will go. */
export function placeholderFor(id: string): string {
	return `${DATA_PLACEHOLDER}${id}>`;
}

/**
 * The id a placeholder names, or `null` if the last argument is not one.
 *
 * Both halves live here so the writer and the reader cannot disagree about the
 * format. They did once: the reader sliced the prefix and left the closing `>`
 * behind, and ten files were named `monoline-constant-weight>.json`. Harmless in a
 * dry run, and a confusing error in production.
 */
export function placeholderId(args: readonly string[]): string | null {
	const last = args.at(-1);
	if (typeof last !== "string") return null;
	if (!last.startsWith(DATA_PLACEHOLDER) || !last.endsWith(">")) return null;
	return last.slice(DATA_PLACEHOLDER.length, -1);
}

/** The only verbs this plan may ever emit. Asserted in the test by enumeration. */
const SAFE_VERBS = ["create", "add-field"] as const;

export interface DeliveryStep {
	/** One line naming what this step creates, for the person reading the list. */
	readonly what: string;
	/** Arguments for `npx emdash …`, without the leading binary. */
	readonly args: readonly string[];
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
		if (!slug || live.collections.has(slug)) continue;

		const create: string[] = ["schema", "create", slug, "--label", str(collection.label) ?? slug];
		const singular = str(collection.labelSingular);
		if (singular) create.push("--label-singular", singular);
		const description = str(collection.description);
		if (description) create.push("--description", description);
		steps.push({ what: `collection ${slug}`, args: create });

		let skipped = 0;
		for (const field of collection.fields ?? []) {
			const name = str(field?.slug);
			const type = str(field?.type);
			if (!name || !type) {
				skipped++;
				continue;
			}
			const add = ["schema", "add-field", slug, name, "--type", type];
			const label = str(field?.label);
			if (label) add.push("--label", label);
			if (field?.required === true) add.push("--required");
			steps.push({ what: `field ${slug}.${name}`, args: add });
		}
		if (skipped > 0) {
			steps.push({
				what: `warning for ${slug}`,
				args: [],
				warning: `${slug}: ${skipped} field(s) declared no slug or type and were not planned`,
			});
		}
	}

	for (const collection of PUBLISHED) {
		const rows = seed.content?.[collection];
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			const id = str(row?.id);
			if (!id || live.entries.has(id)) continue;
			steps.push({
				what: `${collection} ${id}`,
				args: ["content", "create", collection, "--slug", id, "--file", placeholderFor(id)],
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
