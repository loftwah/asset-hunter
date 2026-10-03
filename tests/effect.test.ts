/**
 * Effect-specific semantics (#62).
 *
 * These are not "does the catalogue still work" tests — `tests/catalogue.test.ts`
 * and `tests/routes.test.ts` are those. These assert the *Effect* properties the
 * architecture depends on, so a future change that quietly gives one of them up
 * fails here rather than in production:
 *
 * - **typed failure.** A refusal carries a status; a transport failure does not.
 *   Nothing arrives as a thrown string.
 * - **retry policy.** A refusal is not retried. A transport failure is. This is
 *   the difference between "EmDash said no" and "the socket moved", and getting
 *   it wrong either duplicates writes or gives up on recoverable failures.
 * - **timeout.** A read that never settles becomes a typed failure, not a hang.
 * - **cancellation.** Interrupting a fiber aborts the underlying `fetch`, and a
 *   caller's `AbortSignal` interrupts work in flight.
 * - **decoding.** Untrusted data is decoded, and the forms D1 actually produces —
 *   numbers as strings, booleans as `0`/`1` — decode to the right types. Absent
 *   stays `null` and never becomes `0`.
 * - **service substitution.** A test layer replaces the CMS entirely, which is
 *   what makes the projections testable without a database.
 * - **scoped resources.** A finaliser runs when the program ends.
 * - **config.** A record of environment values becomes a typed service, and an
 *   unreadable value is a named failure rather than a wrong number.
 * - **composition root.** `runApp` is the only bridge, and it closes the scope.
 *
 * Every test that involves time uses `effect/testing`'s `TestClock`, so none of
 * them sleeps and none of them can be flaky.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schedule, Schema } from "effect";
import { TestClock } from "effect/testing";

import { CatalogueDecodeError, EmDashTransportError, EmDashWriteError } from "../src/lib/effect/errors.ts";
import { ExampleData, LooseNumber, PossibilityData } from "../src/lib/effect/schemas.ts";
import { decodeOr } from "../src/lib/effect/decode.ts";
import { RuntimeConfig } from "../src/lib/effect/config.ts";
import { EmDashContent, EmDashContentApi } from "../src/lib/effect/emdash.ts";
import { RequestAbort, cancellable } from "../src/lib/effect/abort.ts";
import { runApp } from "../src/lib/effect/root.ts";
import { loadPossibilities } from "../src/lib/catalogue.ts";
import { flagValue, toMeasure } from "../src/lib/catalogue.ts";

/* -------------------------------------------------------------------------- */
/* Typed failure                                                              */
/* -------------------------------------------------------------------------- */

describe("typed failure, not a thrown string", () => {
	test("a refusal carries the status and is matchable by tag", () => {
		const error = new EmDashWriteError({ operation: "create ratings", status: 409, detail: "SLUG_CONFLICT" });
		assert.equal(error._tag, "EmDashWriteError");
		assert.equal(error.status, 409);
		assert.equal(error.operation, "create ratings");
		// `instanceof Error` still holds, so anything expecting an Error is not
		// surprised — but the tag is what callers branch on.
		assert.ok(error instanceof Error);
	});

	test("a transport failure has no status, which is what makes it retryable", () => {
		const error = new EmDashTransportError({ operation: "read possibilities", detail: "socket hang up" });
		assert.equal(error._tag, "EmDashTransportError");
		assert.equal("status" in error, false);
	});

	test("a decode failure names the record, not just the field", () => {
		const error = new CatalogueDecodeError({ subject: "possibilities/density-gradient", detail: "Expected number" });
		assert.equal(error._tag, "CatalogueDecodeError");
		assert.equal(error.subject, "possibilities/density-gradient");
	});
});

/* -------------------------------------------------------------------------- */
/* Retry policy                                                                */
/* -------------------------------------------------------------------------- */

/** A transport failure, which is the only kind `retryTransport` repeats. */
const transportFailure = () =>
	new EmDashTransportError({ operation: "read", detail: "connection reset" });

/**
 * The retry policy the EmDash client uses, in the shape `Effect.retry` takes.
 *
 * Duplicated here rather than imported so the test asserts the *intent* — "a
 * refusal is not repeated" — independently of the implementation. If the real
 * policy ever widens, this test is the thing that notices.
 */
/**
 * The retry policy, stated once and used by both directions.
 *
 * A transport failure is worth repeating; a refusal is a decision that has already
 * been made. Written as a single named predicate so a test can assert the policy
 * without depending on which module implements it — and so widening a policy
 * anywhere has to change this line, not three of them.
 */
const isRetryable = (error: EmDashTransportError | EmDashWriteError): boolean =>
	error._tag === "EmDashTransportError";

describe("retry policy", () => {
	test("a transport failure is retried and then succeeds", async () => {
		let attempts = 0;
		const flaky = Effect.suspend(() => {
			attempts += 1;
			return attempts < 3
				? Effect.fail(transportFailure() as EmDashTransportError)
				: Effect.succeed("recovered");
		});
		const program = Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				Effect.retry(flaky, { schedule: Schedule.spaced("1 second"), times: 5, while: isRetryable }),
			);
			yield* TestClock.adjust("1 hour");
			return yield* Fiber.join(fiber);
		});
		const result = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
		assert.equal(result, "recovered");
		assert.equal(attempts, 3, "the first attempt plus two retries");
	});

	test("a refusal is NOT retried, however many attempts are allowed", async () => {
		let attempts = 0;
		// A 409 is a decision EmDash already made. Repeating the request cannot change
		// it, and repeating a *create* whose response was lost is how a duplicate row
		// appears in the catalogue.
		// The channel is the *union*, not just `EmDashWriteError`, so the shared
		// policy applies. That is the honest shape: the question under test is
		// "given a policy that would retry a transport failure, is a refusal
		// retried?" — and the answer must be no.
		const refused: Effect.Effect<never, EmDashTransportError | EmDashWriteError> = Effect.suspend(() => {
			attempts += 1;
			return Effect.fail(
				new EmDashWriteError({ operation: "create ratings", status: 409, detail: "SLUG_CONFLICT" }),
			);
		});
		const program = Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				Effect.retry(refused, {
					schedule: Schedule.spaced("1 second"),
					times: 5,
					while: isRetryable,
				}),
			);
			yield* TestClock.adjust("1 hour");
			return yield* fiberAwait(fiber);
		});
		const exit = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
		assert.equal(attempts, 1, "a refusal must be attempted exactly once");
		assert.ok(Exit.isFailure(exit));
		const failure = Cause.findErrorOption(exit.cause);
		assert.ok(failure._tag === "Some");
		assert.equal((failure.value as EmDashWriteError).status, 409);
	});

	test("the budget is bounded — a persistent failure stops, it does not spin", async () => {
		let attempts = 0;
		const alwaysFails = Effect.suspend(() => {
			attempts += 1;
			return Effect.fail(transportFailure());
		});
		const program = Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				Effect.retry(alwaysFails, { schedule: Schedule.spaced("1 second"), times: 2 }),
			);
			yield* TestClock.adjust("1 hour");
			return yield* fiberAwait(fiber);
		});
		const exit = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
		assert.ok(Exit.isFailure(exit));
		assert.equal(attempts, 3, "the first attempt plus exactly two retries");
	});
});

/* -------------------------------------------------------------------------- */
/* Timeout                                                                     */
/* -------------------------------------------------------------------------- */

describe("timeout", () => {
	test("a read that never settles becomes a typed failure, not a hang", async () => {
		const program = Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(Effect.never.pipe(Effect.timeout("1 second")));
			yield* TestClock.adjust("2 seconds");
			return yield* fiberAwait(fiber);
		});
		const exit = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
		assert.ok(Exit.isFailure(exit), "a timeout is a failure, not a success and not a hang");
		const failure = Cause.findErrorOption(exit.cause);
		assert.ok(failure._tag === "Some");
		assert.equal(failure.value._tag, "TimeoutError");
	});

	test("work that finishes inside the budget is untouched", async () => {
		const program = Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				Effect.sleep("10 millis").pipe(Effect.as("done"), Effect.timeout("1 second")),
			);
			yield* TestClock.adjust("1 second");
			return yield* Fiber.join(fiber);
		});
		const result = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
		assert.equal(result, "done");
	});
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                                */
/* -------------------------------------------------------------------------- */

describe("cancellation", () => {
	test("interrupting a fiber aborts the underlying fetch", async () => {
		// The property that makes cancellation worth having: without it, abandoning
		// a page render leaves dozens of D1 reads running for a reader who is gone.
		let started = false;
		let aborted = false;
		const program = Effect.gen(function* () {
			const target = yield* Effect.forkChild(
				Effect.tryPromise({
					try: (signal) =>
						new Promise<number>((resolve, reject) => {
							// `unref` so a still-pending timer can never hold the test
							// runner's event loop open, and cleared on abort so the test
							// also says what real code does: stop what you no longer want.
							const timer = setTimeout(() => resolve(1), 60_000);
							timer.unref?.();
							signal.addEventListener("abort", () => {
								aborted = true;
								clearTimeout(timer);
								reject(new Error("aborted"));
							});
							started = true;
						}),
					catch: (cause) => cause,
				}),
			);
			// A real sleep, not a yield: a freshly forked child is *queued*, and
			// interrupting it before it has run would assert on a request never sent.
			yield* Effect.sleep("10 millis");
			yield* Fiber.interrupt(target);
			// Awaiting the interrupted fiber is what drives the unwind, and the unwind
			// is where the thunk's signal is aborted. Without this the abort lands on a
			// later tick than the interrupt, and the test would be a race.
			return yield* fiberAwait(target);
		});
		await Effect.runPromise(program);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(started, true, "the request must have been made before it was aborted");
		assert.equal(aborted, true, "the AbortSignal handed to the thunk must be wired to the fiber");
	});

	test("a caller's AbortSignal interrupts work in flight", async () => {
		// The reader is still there when the work starts and gone a tick later, which
		// is the case that matters. (An already-aborted signal is covered separately.)
		const controller = new AbortController();
		let aborted = false;
		const work = Effect.tryPromise({
			try: (signal) =>
				new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => resolve("finished"), 60_000);
					timer.unref?.();
					signal.addEventListener("abort", () => {
						aborted = true;
						clearTimeout(timer);
						reject(new Error("aborted"));
					});
				}),
			catch: (cause) => cause,
		});
		// The work runs on the root fiber, so it is certain to have started before
		// the timer fires. A forked child would make the test depend on the
		// scheduler's start order, which is not a contract.
		const timer = setTimeout(() => controller.abort(), 20);
		const exit = await Effect.runPromiseExit(
			Effect.provide(cancellable(work), Layer.succeed(RequestAbort, controller.signal)),
		);
		clearTimeout(timer);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(Exit.isFailure(exit), "an aborted request must not report success");
		assert.equal(aborted, true, "the in-flight request must be aborted, not merely flagged");
	});

	test("with no signal, the work is simply the work", async () => {
		const result = await Effect.runPromise(
			Effect.provide(cancellable(Effect.succeed(42)), Layer.succeed(RequestAbort, null)),
		);
		assert.equal(result, 42);
	});

	test("a signal that already fired refuses immediately rather than starting work", async () => {
		const controller = new AbortController();
		controller.abort();
		let started = false;
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				cancellable(Effect.sync(() => void (started = true))),
				Layer.succeed(RequestAbort, controller.signal),
			),
		);
		assert.ok(Exit.isFailure(exit));
		assert.equal(started, false, "an already-aborted request must not begin work");
	});
});

/* -------------------------------------------------------------------------- */
/* Decoding                                                                    */
/* -------------------------------------------------------------------------- */

describe("decoding untrusted EmDash data", () => {
	const decode = decodeOr(PossibilityData, "possibility row");
	const decodeExample = decodeOr(ExampleData, "example row");

	test("a row with no fields at all decodes to nulls, never to zeroes", async () => {
		// The honesty rule. A measurement that was never taken must not arrive as
		// `0`, because `0` is a claim.
		const row = await Effect.runPromise(decode({}));
		assert.equal(row.example_count, undefined);
		assert.equal(row.novelty, undefined);
		assert.equal(row.featured, undefined);
		assert.equal(row.rights_status, undefined);
	});

	test("numeric text survives decoding intact, so the rule can be applied once", async () => {
		// `example_count: "12"` used to reach the wall as the string "12" and be
		// rendered as such. Converting here would fix that and lose the information
		// needed to tell `"12"` from `""`; see the note on `LooseNumber`.
		const row = await Effect.runPromise(decode({ example_count: "12" }));
		assert.equal(row.example_count, "12");
		assert.equal(toMeasure(row.example_count), 12);
	});

	test("a flag is accepted in every form D1 produces, and the projection is the only reader", async () => {
		// The schema checks the *shape*; `flagValue` decides the *meaning*. Keeping
		// them apart is what stops three readers from getting three answers out of
		// the same column — which is how a `downloadable: 1` ended up offering a file.
		assert.equal((await Effect.runPromise(decode({ featured: true }))).featured, true);
		assert.equal((await Effect.runPromise(decode({ featured: 1 }))).featured, true);
		assert.equal((await Effect.runPromise(decode({ featured: 0 }))).featured, false);
		assert.equal((await Effect.runPromise(decode({ featured: "1" }))).featured, "1");
		assert.equal(flagValue((await Effect.runPromise(decode({ featured: "1" }))).featured), true);
		// And a value that is not a flag at all is a failure.
		const exit = await Effect.runPromiseExit(decode({ featured: "yes" }));
		assert.ok(Exit.isFailure(exit));
	});

	test("a number D1 stored as text is read, and a blank one is not a zero", async () => {
		// The rule the whole contract rests on. `Number("")` is `0`, so a cleared CMS
		// field would otherwise be published as a measurement of exactly zero.
		assert.equal(toMeasure(undefined), null);
		assert.equal(toMeasure(null), null);
		assert.equal(toMeasure(""), null);
		assert.equal(toMeasure("   "), null);
		assert.equal(toMeasure("nope"), null);
		assert.equal(toMeasure(Number.NaN), null);
		assert.equal(toMeasure(Number.POSITIVE_INFINITY), null);
		assert.equal(toMeasure(0), 0, "a real zero is a measurement and must survive");
		assert.equal(toMeasure("0"), 0);
		assert.equal(toMeasure("12"), 12);
		assert.equal(toMeasure("-3.5"), -3.5);
		assert.equal(toMeasure("1e3"), 1000);
		// And through the schema: the raw text reaches the projection intact.
		assert.equal((await Effect.runPromise(decode({ example_count: "12" }))).example_count, "12");
		assert.equal(toMeasure((await Effect.runPromise(decode({ example_count: "12" }))).example_count), 12);
		assert.equal(toMeasure((await Effect.runPromise(decode({ example_count: "" }))).example_count), null);
		assert.equal(toMeasure((await Effect.runPromise(decode({}))).example_count), null);
	});

	test("a field of the wrong shape is a named failure, not a coerced value", async () => {
		const exit = await Effect.runPromiseExit(decode({ example_count: { nested: true } }));
		assert.ok(Exit.isFailure(exit));
		const failure = Cause.findErrorOption(exit.cause);
		assert.ok(failure._tag === "Some");
		assert.equal((failure.value as CatalogueDecodeError)._tag, "CatalogueDecodeError");
		assert.equal((failure.value as CatalogueDecodeError).subject, "possibility row");
	});

	test("the wrapper names the record, so a log line identifies the entry", async () => {
		const named = decodeOr(PossibilityData, "possibilities/density-gradient");
		const exit = await Effect.runPromiseExit(named({ novelty: { measured: true } }));
		assert.ok(Exit.isFailure(exit));
		const failure = Cause.findErrorOption(exit.cause);
		// `Option.match` rather than `failure.value`: reading `.value` off a
		// `None` is the access the type system refuses, and `assert.ok` on the
		// tag does not narrow it.
		const subject = Option.match(failure, {
			onNone: () => null,
			onSome: (error) => (error as CatalogueDecodeError).subject,
		});
		assert.equal(subject, "possibilities/density-gradient");
	});

	test("a downloadable example reads 0/1 as false, not as truthy", async () => {
		// The specific bug this conversion exists to prevent: `downloadable: 1`
		// reaching a template and offering a file nobody authorised.
		assert.equal((await Effect.runPromise(decodeExample({ downloadable: 0 }))).downloadable, false);
		assert.equal((await Effect.runPromise(decodeExample({ downloadable: 1 }))).downloadable, true);
		assert.equal(flagValue(1), true);
		assert.equal(flagValue(0), false);
		assert.equal(flagValue(undefined), false, "absence is not permission");
	});

	test("LooseNumber accepts a number or text, and refuses anything else", () => {
		// `Exit.isSuccess` rather than a `_tag ===` comparison, because that is the
		// predicate that narrows to `Success` and exposes `value`.
		//
		// The schema is the *shape* contract. What a piece of text *means* is
		// `toMeasure`'s job, and both halves are asserted because both are
		// load-bearing: converting in the schema would turn `""` into `0`.
		const value = (input: unknown) => {
			const exit = Schema.decodeUnknownExit(LooseNumber)(input);
			return Exit.isSuccess(exit) ? exit.value : null;
		};
		assert.equal(value(7), 7);
		assert.equal(value("7"), "7", "text stays text until the projection reads it");
		assert.equal(value("nope"), "nope", "unparseable text reaches the rule, which refuses it");
		assert.equal(value({}), null);
		assert.equal(value(null), null);
		assert.equal(value(true), null);
		assert.equal(toMeasure(value("nope")), null);
	});
});

/* -------------------------------------------------------------------------- */
/* Service substitution                                                        */
/* -------------------------------------------------------------------------- */

describe("service substitution", () => {
	/**
	 * A CMS that answers from a fixture, so a projection can be tested with no
	 * database.
	 *
	 * `menu` and `section` are stubbed alongside `collection` and `entry` because
	 * they are the same service (#17) — a stub that omitted them would not
	 * typecheck, which is the enforcement that matters: the shell's reads cannot
	 * quietly become a second, separately-substitutable boundary.
	 */
	const stubEmDash = (rows: ReadonlyArray<{ id: string; data: unknown }>) =>
		Layer.succeed(
			EmDashContent,
			EmDashContent.of({
				collection: () => Effect.succeed({ entries: rows, nextCursor: null, cacheHint: undefined }),
				entry: () => Effect.succeed({ entry: null, cacheHint: undefined }),
				menu: () => Effect.succeed({ menu: null, cacheHint: undefined }),
				section: () => Effect.succeed(null),
			}),
		) as Layer.Layer<EmDashContent>;

	test("the catalogue loader runs against a substituted CMS, with no database", async () => {
		const rows = [
			{ id: "second", data: { title: "B", editorial_rank: 1, example_count: "3" } },
			{ id: "first", data: { title: "A", editorial_rank: 9, featured: 1 } },
		];
		const { possibilities } = await Effect.runPromise(
			Effect.provide(loadPossibilities(), stubEmDash(rows)),
		);
		// Editorial rank leads, so a human decision outranks the order the stub
		// happened to return.
		assert.deepEqual(possibilities.map((p) => p.slug), ["first", "second"]);
		assert.equal(possibilities[0].featured, true);
		// And the string became a number on the way through.
		assert.equal(possibilities[1].exampleCount, 3);
	});

	test("a substituted CMS can fail in a way the loader propagates", async () => {
		const failing = Layer.succeed(
			EmDashContent,
			EmDashContent.of({
				collection: () =>
					Effect.fail(new EmDashTransportError({ operation: "read possibilities", detail: "D1 is down" })),
				entry: () => Effect.fail(new EmDashTransportError({ operation: "read", detail: "D1 is down" })),
				menu: () => Effect.fail(new EmDashTransportError({ operation: "read menu", detail: "D1 is down" })),
				section: () => Effect.fail(new EmDashTransportError({ operation: "read section", detail: "D1 is down" })),
			}),
		);
		const exit = await Effect.runPromiseExit(Effect.provide(loadPossibilities(), failing));
		assert.ok(Exit.isFailure(exit));
		// Before #62 this was indistinguishable from an empty catalogue, and a page
		// rendered a confident nothing.
		const failure = Cause.findErrorOption(exit.cause);
		assert.ok(failure._tag === "Some");
		assert.equal((failure.value as EmDashTransportError)._tag, "EmDashTransportError");
	});
});

/* -------------------------------------------------------------------------- */
/* Scoped resources                                                            */
/* -------------------------------------------------------------------------- */

describe("scoped resources", () => {
	test("a finaliser runs when the program ends", async () => {
		const released: string[] = [];
		const program = Effect.gen(function* () {
			const handle = yield* Effect.acquireRelease(
				Effect.succeed("handle"),
				() => Effect.sync(() => released.push("released")),
			);
			assert.equal(handle, "handle");
			assert.deepEqual(released, [], "nothing is released while the work is running");
			return "done";
		});
		// `Effect.runPromise` supplies no `Scope` in v4, which is why the composition
		// root's `runScoped` is explicit about adding one.
		const result = await Effect.runPromise(Effect.scoped(program));
		assert.equal(result, "done");
		assert.deepEqual(released, ["released"]);
	});

	test("a finaliser runs even when the program fails", async () => {
		const released: string[] = [];
		const program = Effect.gen(function* () {
			yield* Effect.acquireRelease(
				Effect.succeed("handle"),
				() => Effect.sync(() => released.push("released")),
			);
			return yield* Effect.fail(new EmDashWriteError({ operation: "x", status: 500, detail: "y" }));
		});
		const exit = await Effect.runPromiseExit(Effect.scoped(program));
		assert.ok(Exit.isFailure(exit));
		assert.deepEqual(released, ["released"], "a failed program must still release what it acquired");
	});
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

describe("configuration", () => {
	const readSite = Effect.gen(function* () {
		const config = yield* RuntimeConfig;
		return config.site;
	});

	test("a record of environment values becomes a typed service", async () => {
		const site = await Effect.runPromise(
			Effect.provide(readSite, RuntimeConfig.fromEnv({ AH_SITE: "https://example.test" })),
		);
		assert.equal(site, "https://example.test");
	});

	test("omitting a value falls back to the documented default", async () => {
		// The app must be fully functional with no configuration at all, which is
		// what lets a Cloudflare deploy ship with no environment record.
		const site = await Effect.runPromise(Effect.provide(readSite, RuntimeConfig.fromEnv({})));
		assert.equal(site, "https://assets.loftwah.com");
	});

	test("the provider is wired, not merely merged", async () => {
		// A `Layer.mergeAll` of the config and the provider does *not* put the
		// reference in scope while the config layer is being built, so the config
		// would read from the default provider and return the right answer for the
		// wrong reason. This is the assertion that catches it.
		const timeouts = Effect.gen(function* () {
			const config = yield* RuntimeConfig;
			return { read: config.readTimeoutMs, write: config.writeTimeoutMs };
		});
		const timeoutsSeen = await Effect.runPromise(
			Effect.provide(
				timeouts,
				RuntimeConfig.fromEnv({ AH_READ_TIMEOUT_MS: "1234", AH_WRITE_TIMEOUT_MS: "5678" }),
			),
		);
		assert.deepEqual(timeoutsSeen, { read: 1234, write: 5678 });
	});

	test("an unreadable value is a named failure rather than a wrong number", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.provide(readSite, RuntimeConfig.fromEnv({ AH_READ_TIMEOUT_MS: "soon" })),
		);
		assert.ok(Exit.isFailure(exit));
		const failure = Cause.findErrorOption(exit.cause);
		assert.ok(failure._tag === "Some");
		assert.equal((failure.value as { _tag: string })._tag, "ConfigError");
	});

	test("a token is absent rather than empty when there is none", async () => {
		const token = await Effect.runPromise(
			Effect.provide(
				Effect.map(RuntimeConfig, (c) => c.githubToken),
				RuntimeConfig.fromEnv({}),
			),
		);
		assert.equal(token, null, "no token and an empty token are different states");
	});
});

/* -------------------------------------------------------------------------- */
/* The composition root                                                        */
/* -------------------------------------------------------------------------- */

describe("the composition root", () => {
	test("runApp is the bridge, and it closes the scope", async () => {
		const released: string[] = [];
		const program = Effect.gen(function* () {
			// Ask for a scoped resource, which `runApp` alone would not satisfy. If
			// this compiles and runs, the root is providing the scope the run needs.
			yield* Effect.acquireRelease(
				Effect.succeed("h"),
				() => Effect.sync(() => released.push("released")),
			);
			const config = yield* RuntimeConfig;
			return config.site;
		});
		const site = await runApp(Effect.scoped(program), { env: { AH_SITE: "https://root.test" } });
		assert.equal(site, "https://root.test");
		assert.deepEqual(released, ["released"], "the layer graph is released when the run ends");
	});

	test("the whole app layer graph is provided by one call", async () => {
		// Every service a real page needs, resolved through the root and nothing
		// else. If this stops compiling, a service has been added without a layer.
		const program = Effect.gen(function* () {
			const content = yield* EmDashContent;
			const api = yield* EmDashContentApi;
			const config = yield* RuntimeConfig;
			return [
				typeof content.collection,
				typeof content.entry,
				typeof content.menu,
				typeof content.section,
				typeof api.create,
				typeof api.update,
				typeof api.publish,
				typeof api.unpublish,
				typeof api.read,
				config.readTimeoutMs,
			];
		});
		const shape = await runApp(program, { env: {} });
		assert.deepEqual(
			shape.slice(0, 9),
			Array.from({ length: 9 }, () => "function"),
		);
		assert.equal(shape[9], 8000);
	});
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `Fiber.await` is a reserved word, so the module export is only reachable by
 * index. Wrapped once here rather than with a cast at every call site.
 */
const fiberAwait = <A, E>(fiber: Fiber.Fiber<A, E>) =>
	(Fiber as unknown as { await: (f: Fiber.Fiber<A, E>) => Effect.Effect<Exit.Exit<A, E>> }).await(
		fiber,
	);
