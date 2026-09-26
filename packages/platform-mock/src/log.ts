// One JSON line per request of the platform mock. It only takes the fields declared below (route,
// status, operation, event id, error class): never a body, a header or a free-form value, so no
// personal data can reach a log line whatever a caller sends.
import { randomUUID } from "node:crypto";

export type PlatformLogLevel = "info" | "warn" | "error";

export interface PlatformLogFields {
  readonly method?: string;
  readonly route?: string;
  readonly status?: number;
  readonly firmId?: string;
  readonly operationNumber?: string;
  readonly eventId?: string;
  readonly replayed?: boolean;
  readonly reason?: string;
  readonly errorName?: string;
  readonly errorCode?: string;
}

export interface PlatformLogRecord extends PlatformLogFields {
  readonly level: PlatformLogLevel;
  readonly time: string;
  readonly correlationId: string;
  readonly message: string;
}

export type PlatformLogSink = (record: PlatformLogRecord) => void;

export function stdoutSink(record: PlatformLogRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** The caller's correlation id when it looks like one (the BFF sends it), else the platform's request id, else a new one. */
export function correlationIdOf(...candidates: ReadonlyArray<string | undefined>): string {
  return candidates.find((candidate): candidate is string => candidate !== undefined && CORRELATION_PATTERN.test(candidate)) ?? randomUUID();
}
