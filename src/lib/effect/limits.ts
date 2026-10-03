/**
 * Abuse limits for the public write endpoints (#53).
 *
 * ## Why this is a service and not a table
 *
 * The authoritative rate limit for a Cloudflare deployment is a platform-native
 * Rate Limiting Rule in the zone, not application code — see `docs/DEPLOY.md`.
 * This is the second layer underneath it, and it exists for a different reason:
 * to make the *damage* of a flood bounded even when the edge rule is not
 * configured, and to keep the storage-level consequence deterministic rather
 * than probabilistic.
 *
 * Two mechanisms, deliberately not one:
 *
 * 1. {@link RateLimits.take} — a per-isolate fixed window over an identity. It
 *    is honest about its scope: on Workers a module-level map is per isolate, so
 *    this blunts a flood rather than stopping it, and it is named for what it is
 *    so nobody later mistakes it for an edge limiter. `Clock` is read through
 *    Effect, so `TestClock` makes the window testable without waiting.
 * 2. The deterministic slugs in `src/lib/signals.ts` — the part that actually
 *    bounds storage. A limit that only refuses the *request* leaves rows behind
 *    the moment the window rolls; a derived slug makes the duplicate collide
 *    with itself, which is a storage guarantee and not a timing accident.
 *
 * The map is bounded and pruned on write. An unbounded map keyed by an
 * attacker-controlled string is itself a memory-exhaustion vector, which would be
 * a poor way to mitigate one.
 */
import { Clock, Context, Effect, Layer, Ref } from "effect";

/** One window, one decision. */
export interface RateDecision {
	readonly allowed: boolean;
	/** What to tell a reader, in words. Never an internal counter. */
	readonly reason: string;
	/** Whole seconds before another attempt would be allowed. Zero when allowed. */
	readonly retryAfterSeconds: number;
}

/** How many identities one isolate remembers at once. */
export const MAX_TRACKED = 2048;

export class RateLimits extends Context.Service<
	RateLimits,
	{
		/**
		 * Records one attempt by `identity` and answers whether it may proceed.
		 *
		 * Fixed window, per isolate, in memory. Returns the decision rather than
		 * failing, because every caller wants to turn it into a reader-facing
		 * sentence rather than an exception.
		 */
		readonly take: (input: {
			readonly identity: string;
			readonly limit: number;
			readonly windowMs: number;
			readonly subject: string;
		}) => Effect.Effect<RateDecision>;
	}
>()("asset-hunter/RateLimits") {
	/**
	 * The windows, held at module scope rather than inside the layer (#53).
	 *
	 * This is the one service in the graph whose *identity across requests* is the
	 * whole point, and `appLayer()` builds a fresh graph per call — deliberately,
	 * so an EmDash client is never retained for the life of the isolate. Built
	 * inside `RateLimits.layer`, that also meant a fresh `Ref` for every request,
	 * so every caller was the first caller: `count` was always `1`, the limit was
	 * never reached, and the limiter refused nothing.
	 *
	 * It was measured rather than assumed. 70 rapid `POST /api/board` against a
	 * 60-per-minute policy answered `303` seventy times and `429` never — and
	 * `429` is the only status `/api/board` can produce from this decision.
	 *
	 * A module-level `Ref` is still per-isolate (Workers never share one), which
	 * is what the window has always been honest about, and `Clock` is still read
	 * through Effect, so `TestClock` still drives it without waiting.
	 */
	private static readonly windows: Ref.Ref<Map<string, { at: number; count: number }>> = Ref.makeUnsafe(
		new Map<string, { at: number; count: number }>(),
	);

	static readonly service: RateLimits["Service"] = ({
		take: (input) =>
			Effect.gen(function* () {
				const millis = yield* Clock.currentTimeMillis;
				const key = `${input.subject}:${input.identity}`;
				const held = yield* Ref.get(RateLimits.windows);

				// Prune first, so a flood of new identities cannot grow the map
				// faster than entries expire.
				if (held.size > MAX_TRACKED) {
					const live = new Map<string, { at: number; count: number }>();
					for (const [k, v] of held) {
						if (millis - v.at < input.windowMs) live.set(k, v);
					}
					yield* Ref.set(RateLimits.windows, live);
				}

				const current = held.get(key);
				if (!current || millis - current.at >= input.windowMs) {
					yield* Ref.set(
						RateLimits.windows,
						new Map(held).set(key, { at: millis, count: 1 }),
					);
					return { allowed: true, reason: "", retryAfterSeconds: 0 };
				}

				if (current.count >= input.limit) {
					const waitMs = input.windowMs - (millis - current.at);
					return {
						allowed: false,
						reason: `That is enough for now — ${input.subject} is limited to ${input.limit} in a ${Math.round(
							input.windowMs / 1000,
						)}-second window. Try again shortly.`,
						retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
					};
				}

				yield* Ref.set(
					RateLimits.windows,
					new Map(held).set(key, { ...current, count: current.count + 1 }),
				);
				return { allowed: true, reason: "", retryAfterSeconds: 0 };
			}),
	});

	static readonly layer: Layer.Layer<RateLimits> = Layer.succeed(RateLimits, RateLimits.service);
}

/** The default policy for a rating: revise freely, but not in a loop. */
export const RATING_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/**
 * The default policy for a report.
 *
 * Lower than a rating because a report is the endpoint a spammer actually wants:
 * it is the one that creates rows, and it is the one an editor has to read.
 */
export const REPORT_LIMIT = { limit: 5, windowMs: 60_000 } as const;

/**
 * The board endpoint's policy.
 *
 * Much looser, because a board POST writes one cookie and nothing else — there
 * is no row to fill and no queue to poison. The cap exists to stop a script
 * using the endpoint as a write amplifier against the CMS read behind the
 * slug validation, not to ration a person using the shortlist.
 */
export const BOARD_LIMIT = { limit: 60, windowMs: 60_000 } as const;