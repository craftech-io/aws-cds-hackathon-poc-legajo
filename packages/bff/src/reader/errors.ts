// What a call to the document reader can end in, besides a reading. The client retries what is worth
// retrying by itself, so every `ReaderError` is final for the call that got it:
//
//   READER_UNAVAILABLE  retries exhausted (429, 503, timeouts), a `Retry-After` longer than a
//                       Lambda can wait, or the reader refused our signature. The version stays
//                       RECEIVED and the intake schedules `TIMER#READER_RETRY` (FL-096).
//   INVALID_RESPONSE    a 200 whose body is not a `Reading` of the contract: never used as a reading.
//   INVALID_REQUEST     400: our request or the source URL was rejected.
//   FILE_TOO_LARGE      413: the file is over the reader's 10 MB.
//   NOT_FOUND           404 of `getReading`.
export const READER_FAILURE_CODES = ["READER_UNAVAILABLE", "INVALID_RESPONSE", "INVALID_REQUEST", "FILE_TOO_LARGE", "NOT_FOUND"] as const;
export type ReaderFailureCode = (typeof READER_FAILURE_CODES)[number];

export interface ReaderErrorDetails {
  /** Attempts made, the first one included. */
  readonly attempts: number;
  /** HTTP status of the last answer, when there was one. */
  readonly status?: number;
  /** `Retry-After` of the last answer, in milliseconds. */
  readonly retryAfterMs?: number;
}

export class ReaderError extends Error {
  override readonly name = "ReaderError";
  /** Final: the client already spent its retries. */
  readonly retryable = false;
  constructor(
    readonly code: ReaderFailureCode,
    message: string,
    readonly details: ReaderErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isReaderUnavailable(error: unknown): error is ReaderError {
  return error instanceof ReaderError && error.code === "READER_UNAVAILABLE";
}
