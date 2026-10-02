/**
 * Bridging a platform abort into Effect interruption (#62).
 *
 * `AbortSignal` and Effect's fiber interruption are the same idea expressed in
 * two runtimes, and nothing in this application connected them: an Astro request
 * that a reader abandoned left its EmDash reads running until they finished or
 * timed out. On a per-isolate runtime that is real — a wall rebuild is several
 * dozen queries, and every abandoned one is a query nobody is waiting for.
 *
 * The bridge is a scoped resource, which is the shape the problem actually has:
 * the listener is acquired for the life of the request's work and released when
 * that work ends, whether it completed, failed or was interrupted. The cleanup
 * effect returned from `Effect.callback`'s registration function is what makes
 * the last case true — without it every completed request would leave an `abort`
 * listener attached to a signal nobody reads again, and a long-lived isolate
 * would accumulate them.
 *
 * `Effect.tryPromise` already hands its thunk an `AbortSignal` wired to the
 * fiber, so interrupting really does abort the socket — asserted in
 * `tests/effect.test.ts`. What it does *not* do is notice the **caller** going
 * away, which is the direction this file adds.
 */
import { Context, Effect } from "effect";

/** The request went away before the work finished. Not a defect; an outcome. */
export class AbortedError extends Error {
	readonly _tag = "AbortedError";
	constructor(options: { readonly reason: string }) {
		super(`request ${options.reason}`);
		this.name = "AbortedError";
	}
}

/**
 * The abort signal for the work in scope, if there is one.
 *
 * A `Context.Reference` with a `null` default rather than a service with a
 * layer: a signal is a *value* that changes per request, and a reference already
 * means "a value that has a sensible default". `null` rather than a
 * never-aborting stand-in, so a program can tell "nobody asked me to stop" from
 * "I have a deadline", and so a caller that never supplies one pays nothing.
 *
 * Its requirement type is `never` — which is what makes it invisible in a
 * program's `R`. Cancellation is available, not mandatory.
 */
export const RequestAbort = Context.Reference<AbortSignal | null>("asset-hunter/RequestAbort", {
	defaultValue: () => null,
});

/**
 * Interrupts `work` if the request's signal fires.
 *
 * `Effect.raceFirst` is what turns "the signal fired" into interruption of work
 * already in flight, so an in-progress EmDash read is cancelled rather than
 * merely flagged. The abort surfaces as a typed {@link AbortedError} in the error
 * channel: a caller that wants to render anyway can, and a caller that does not
 * has something to match on rather than an opaque `Cause`.
 */
export const cancellable = <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | AbortedError, R> =>
	Effect.gen(function* () {
		const signal = yield* RequestAbort;
		if (!signal) return yield* work;
		// Checked *before* the race, not only inside the losing branch. `raceFirst`
		// is a race, and a synchronous `work` can win it — so a request that was
		// already aborted would run to completion and then report success, which is
		// the worst possible answer to "this reader is gone".
		if (signal.aborted) {
			return yield* Effect.fail(new AbortedError({ reason: "was already aborted" }));
		}
		return yield* Effect.raceFirst(
			work,
			Effect.callback<never, AbortedError>((resume) => {
				const onAbort = () => resume(Effect.fail(new AbortedError({ reason: "was aborted" })));
				signal.addEventListener("abort", onAbort, { once: true });
				// Runs when this branch is interrupted, which is exactly when the work
				// finished first and the listener is no longer needed.
				return Effect.sync(() => signal.removeEventListener("abort", onAbort));
			}),
		);
	});
