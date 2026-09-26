// Who is invoking a handler (docs/tool-catalog.md, Convenciones). Through the Gateway the identity is
// the `sessionToken` the worker signed for the turn, never an id written by the model; outside the
// Gateway it is an explicit `caller`. `caller` does not authenticate (a Lambda cannot see the role
// that invoked it): the fence is each Lambda's resource policy plus the XOR below (`LAM-CALLER`).
import { z } from "zod";
import { ConsoleRole } from "./enums";
import { BrokerId, FirmId } from "./ids";

export const CallerKind = z.enum(["WORKER", "CHANNEL", "CONSOLE", "QA", "SCHEDULER"]);
export type CallerKind = z.infer<typeof CallerKind>;

/** Kinds whose handlers are fenced to the firm of a server-built principal. */
const FIRM_BOUND_KINDS: ReadonlySet<CallerKind> = new Set<CallerKind>(["CONSOLE", "QA"]);

/** Roles the `QaDriver` may act as through the real `appRouter` (`brk-qa-runner`, `brk-qa-analyst`). */
export const QaConsoleRole = ConsoleRole.extract(["BROKER", "ANALYST"]);
export type QaConsoleRole = z.infer<typeof QaConsoleRole>;

export const Caller = z
  .object({
    kind: CallerKind,
    firmId: FirmId.optional(),
    brokerId: BrokerId.optional(),
    role: ConsoleRole.optional(),
    /** Queue or feed event the call belongs to (idempotency and correlation). */
    eventId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((caller, ctx) => {
    if (FIRM_BOUND_KINDS.has(caller.kind)) {
      if (caller.firmId === undefined) ctx.addIssue({ code: "custom", path: ["firmId"], message: `${caller.kind} caller needs its firm` });
      if (caller.role === undefined) ctx.addIssue({ code: "custom", path: ["role"], message: `${caller.kind} caller needs its role` });
    }
    if (caller.kind === "QA" && caller.role !== undefined && !QaConsoleRole.safeParse(caller.role).success) {
      ctx.addIssue({ code: "custom", path: ["role"], message: "QA acts as BROKER or ANALYST only" });
    }
  });
export type Caller = z.infer<typeof Caller>;

// `<sessionId>.<turnId>.<exp>.<HMAC-SHA256 base64url>`; `exp` is epoch seconds, at most 15 min ahead.
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/;
export const SESSION_TOKEN_MAX_TTL_SECONDS = 15 * 60;

export const SessionToken = z.string().regex(SESSION_TOKEN_PATTERN, "malformed session token");
export type SessionToken = z.infer<typeof SessionToken>;

export interface SessionTokenParts {
  readonly sessionId: string;
  readonly turnId: string;
  /** Epoch seconds. */
  readonly exp: number;
  readonly signature: string;
}

/** Splits without verifying: the signature needs the `session` subkey and is checked in the bff. */
export function splitSessionToken(token: string): SessionTokenParts {
  const [sessionId = "", turnId = "", exp = "0", signature = ""] = SessionToken.parse(token).split(".");
  return { sessionId, turnId, exp: Number(exp), signature };
}

/** Tokens live in real time; the caller injects `nowMs` (never the simulated clock of the world). */
export function isSessionTokenExpired(token: string, nowMs: number): boolean {
  return splitSessionToken(token).exp * 1000 <= nowMs;
}

/**
 * Every handler input carries exactly one of the two. The objects are not strict so the tool's own
 * fields pass through; each tool schema adds them and applies `.strict()` (`LAM-STRICT`).
 */
export const PrincipalInput = z.union([
  z.object({ sessionToken: SessionToken, caller: z.undefined().optional() }),
  z.object({ caller: Caller, sessionToken: z.undefined().optional() }),
]);
export type PrincipalInput = z.infer<typeof PrincipalInput>;

export function principalKind(input: PrincipalInput): "SESSION" | CallerKind {
  return input.sessionToken !== undefined ? "SESSION" : input.caller.kind;
}
