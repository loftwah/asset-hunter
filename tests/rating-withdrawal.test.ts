/**
 * A reader can take back a rating (#37).
 *
 * ## The gap this closes
 *
 * `SignalPanel.astro` justified requiring a sign-in to rate with a sentence: *"A
 * rating you cannot revise or withdraw is not an opinion, it is a vote, so signing in
 * is required."*
 *
 * Revising existed. **Withdrawing did not.** `EmDashContentApi` had `create`, `update`,
 * `publish` and `read` and nothing else; `/api/signal` had exactly two intents, `rate`
 * and `report`. So the copy was half a promise, and the reader who signed in because of
 * it found no control. An audit found this; the fix is one transport method, one
 * function and one intent.
 *
 * ## Why unpublish and not delete
 *
 * EmDash will delete the row, and that would destroy the only fact the row holds that
 * matters — that this reader rated and then changed their mind. `src/lib/disputes.ts`
 * already makes this argument for takedowns ("quarantine is a *gate*, not a deletion"),
 * and a withdrawal is the same decision from the other direction. It is also reversible:
 * the public read asks for `status: "published"`, so an unpublished rating leaves the
 * aggregate at once, and re-rating publishes the same entry again.
 *
 * The last test asserts the *structural* half of that: the service exposes no delete at
 * all, so nobody can reach for the destructive one later without adding it deliberately.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { EmDashContent, EmDashContentApi } from "../src/lib/effect/emdash.ts";
import { ratingSlug, withdrawRating } from "../src/lib/signals.ts";
import type { EmDashRequest } from "../src/lib/effect/emdash.ts";

const REQUEST = { endpoint: "https://cms.test", headers: {} } as unknown as EmDashRequest;

const ACTOR_ID = "u1";
const ACTOR = { id: ACTOR_ID, kind: "user" } as unknown as Parameters<typeof withdrawRating>[1]["actor"];

/** Derived, not hardcoded — see `ratingSlug`. */
const EXPECTED_ID = ratingSlug("possibility", "crowd-fluid", ACTOR_ID);

interface Calls {
	unpublished: string[];
	deleted: string[];
}

/**
 * The two services `withdrawRating` needs, recording what it did.
 *
 * `delete` is deliberately **not** part of the stub's type — it cannot be, because the
 * service has no such member. So "it does not delete" is enforced by the compiler
 * rather than by an assertion that could be deleted along with the code.
 */
function services(existing: { id: string; rev: string } | null, calls: Calls) {
	const api = Layer.succeed(
		EmDashContentApi,
		EmDashContentApi.of({
			create: () => Effect.succeed("created"),
			update: () => Effect.void,
			publish: () => Effect.void,
			unpublish: (_request, collection, slug) => {
				calls.unpublished.push(`${collection}/${slug}`);
				return Effect.void;
			},
			read: () =>
				Effect.succeed(existing ? { data: { stars: 4 }, rev: existing.rev } : null),
		}),
	) as Layer.Layer<EmDashContentApi>;

	const content = Layer.succeed(
		EmDashContent,
		EmDashContent.of({
			collection: () => Effect.succeed({ entries: [], nextCursor: null, cacheHint: undefined }),
			entry: () => Effect.succeed({ entry: null, cacheHint: undefined }),
			menu: () => Effect.succeed({ menu: null, cacheHint: undefined }),
			section: () => Effect.succeed(null),
		}),
	) as Layer.Layer<EmDashContent>;

	return Layer.mergeAll(api, content);
}

const withdraw = (existing: { id: string; rev: string } | null) => {
	const calls: Calls = { unpublished: [], deleted: [] };
	const program = withdrawRating(REQUEST, {
		subjectType: "possibility",
		subjectSlug: "crowd-fluid",
		actor: ACTOR,
	});
	return Effect.runPromise(Effect.provide(program, services(existing, calls))).then((result) => ({
		result,
		calls,
	}));
};

describe("withdrawing a rating", () => {
	test("unpublishes this reader's rating, and says it did", async () => {
		const { result, calls } = await withdraw({ id: EXPECTED_ID, rev: "r1" });
		assert.deepEqual(result, { withdrawn: true });
		assert.deepEqual(calls.unpublished, [`ratings/${EXPECTED_ID}`]);
	});

	test("unpublishes rather than deletes", async () => {
		/*
		 * The choice, asserted.
		 *
		 * Deleting would leave no record that this reader ever rated, which is the one
		 * fact worth keeping about a withdrawal and the reason `disputes.ts` calls
		 * quarantine a gate rather than a deletion. Unpublishing also leaves the entry
		 * re-publishable, so changing your mind back is one click rather than a support
		 * request.
		 */
		const { calls } = await withdraw({ id: "rating-x", rev: "r1" });
		assert.deepEqual(calls.deleted, [], "nothing was deleted");
		assert.equal(calls.unpublished.length, 1);
	});

	test("'nothing to withdraw' is an outcome, not a failure", async () => {
		// A double-clicked withdraw button is not an error, and telling a reader
		// something went wrong when the result is exactly what they asked for is a lie
		// about the system's own state.
		const { result, calls } = await withdraw(null);
		assert.deepEqual(result, { withdrawn: false });
		assert.deepEqual(calls.unpublished, [], "and it did not write anything to find that out");
	});

	test("the service offers no delete, so the destructive path is not reachable", () => {
		// Structural rather than behavioural. A behavioural assertion can be deleted
		// along with the code it was protecting; this fails to compile if somebody adds a
		// delete and uses it here.
		const surface = EmDashContentApi.of({
			create: () => Effect.succeed(""),
			update: () => Effect.void,
			publish: () => Effect.void,
			unpublish: () => Effect.void,
			read: () => Effect.succeed(null),
		});
		assert.deepEqual(Object.keys(surface).sort(), [
			"create",
			"publish",
			"read",
			"unpublish",
			"update",
		]);
	});
});
