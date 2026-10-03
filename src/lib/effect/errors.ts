/**
 * Typed failures for the EmDash boundary (#62).
 *
 * Every failure that can leave this application crosses an EmDash call, and each
 * one used to arrive as a thrown `Error` whose message was the only thing the
 * caller could look at:
 *
 * ```ts
 * throw new Error(`create rating → HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
 * ```
 *
 * That is a string with the status buried in it, which means a caller can
 * neither branch on "is this worth retrying" nor log it as anything other than
 * prose. So the two genuinely different failures are two tagged errors:
 *
 * - {@link EmDashTransportError} — the request never produced a status. DNS, a
 *   dropped connection, or our own timeout. **Retryable**, and the only kind
 *   that is.
 * - {@link EmDashWriteError} — EmDash answered, and the answer was a refusal.
 *   Retrying a 401 or a 409 changes nothing; the response body is kept because
 *   EmDash puts the actual reason in it.
 *
 * `Schema.TaggedError` rather than a bare class because these are values that
 * cross a module boundary and are matched by `_tag`. The fields are the ones a
 * caller acts on — nothing else.
 *
 * The underlying cause is carried as a `string`, deliberately.
 * `Schema.Defect` and the `withDecodingDefault*` family are broken in
 * `effect@4.0.0` — they build a schema whose AST is `undefined` and the compiler
 * then throws `Invalid value used as weak map key`; see `docs/EFFECT_STYLE.md`.
 * A `string` is also the more honest record: a transport failure worth keeping is
 * worth keeping as something loggable.
 */
import { Cause, Schema } from "effect";

/** The request produced no status: connection failure, abort, or our timeout. */
export class EmDashTransportError extends Schema.TaggedError<EmDashTransportError>()(
	"EmDashTransportError",
	{
		/** What was being attempted, e.g. `read possibilities` or `create rating`. */
		operation: Schema.String,
		detail: Schema.String,
	},
) {}

/** EmDash answered with a refusal. `status` is the reason this is not retryable. */
export class EmDashWriteError extends Schema.TaggedError<EmDashWriteError>()("EmDashWriteError", {
	operation: Schema.String,
	status: Schema.Number,
	/** The first slice of EmDash's own message, which is where the reason is. */
	detail: Schema.String,
}) {}

/**
 * EmDash returned a body this application cannot read.
 *
 * The catalogue's honesty rules depend on `null` meaning "not measured", so a
 * field that arrives with the wrong shape has to be a *failure* rather than a
 * coerced value. Coercing it is how a licence status turns into a plausible
 * looking wrong one.
 */
export class CatalogueDecodeError extends Schema.TaggedError<CatalogueDecodeError>()(
	"CatalogueDecodeError",
	{
		/** What was being decoded, e.g. `possibilities/density-gradient`. */
		subject: Schema.String,
		detail: Schema.String,
	},
) {}

/** Anything that can go wrong talking to EmDash. */
export type EmDashError = EmDashTransportError | EmDashWriteError | CatalogueDecodeError;

/**
 * A one-line form for a log line or a reader-facing note.
 *
 * The old handlers interpolated the message straight into the reader-facing
 * string, which is how an HTTP status and a slice of a CMS error page ended up on
 * a public URL. The operation and the status stay; the detail is truncated and
 * belongs in the log, not in a redirect parameter.
 */
export function describeError(error: EmDashError): string {
	switch (error._tag) {
		case "EmDashTransportError":
			return `${error.operation} could not reach EmDash`;
		case "EmDashWriteError":
			return `${error.operation} was refused by EmDash with HTTP ${error.status}`;
		case "CatalogueDecodeError":
			return `${error.subject} did not match the catalogue contract`;
	}
}

/** The truncated detail, for a log line. Never for a reader. */
export function describeDetail(error: EmDashError): string {
	const detail =
		error._tag === "EmDashTransportError"
			? error.detail
			: error._tag === "EmDashWriteError"
				? error.detail
				: error.detail;
	return detail.length <= 160 ? detail : `${detail.slice(0, 160)}…`;
}

/**
 * A cause rendered for a **log line**, detail included.
 *
 * `Cause.pretty` prints the error's `message`, and every error in this file sets
 * `message` to nothing on purpose — the detail goes to the log and a reader gets a
 * sentence, so a reader-facing string and a diagnostic string are different fields.
 * That left the two log sites using `Cause.pretty` printing
 *
 *     catalogue.json: build failed EmDashTransportError:
 *
 * with nothing after the colon, while the cause carried
 * `detail: "limit: Too big: expected number to be <=100"`.
 *
 * Not a cosmetic gap. It is why a 503 that had been live in production — masked for
 * a while by the endpoint's own body cache — took ten turns to trace to a hard
 * 100-row cap that five call sites exceeded. A diagnostic that cannot name the
 * diagnostic is how a five-minute bug becomes an afternoon one.
 *
 * So this keeps `Cause.pretty`'s structure and appends every `detail` it finds,
 * because a log line is the one place the detail belongs.
 */
export function describeCauseForLog(cause: unknown): string {
	const rendered = Cause.pretty(cause as Cause.Cause<unknown>);
	const details: string[] = [];
	const visit = (node: unknown): void => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		const record = node as Record<string, unknown>;
		if (typeof record.detail === "string" && record.detail.trim() !== "")
			details.push(record.detail.trim());
		if (record.error !== undefined) visit(record.error);
		if (record.left !== undefined) visit(record.left);
		if (record.right !== undefined) visit(record.right);
	};
	visit((cause as { failure?: unknown })?.failure ?? cause);
	const unique = [...new Set(details)];
	return unique.length === 0 ? rendered : `${rendered} — ${unique.join(" | ")}`;
}
