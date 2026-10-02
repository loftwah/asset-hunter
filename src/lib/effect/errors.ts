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
import { Schema } from "effect";

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
