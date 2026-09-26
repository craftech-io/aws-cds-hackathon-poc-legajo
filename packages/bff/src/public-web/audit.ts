// What the upload page leaves behind (docs/architecture.md §11): every valid access is one `ACTION`
// row of the firm's audit log; a refusal of a known link is one `DENY UPLOAD_*` row per link and
// variant (docs/flows-catalog.md FL-010), never one per attempt; and every attempt with an invalid,
// expired or used token is counted in the `UploadLinkInvalid` metric through one log line, which the
// metric filter of infra/observability.ts turns into `LegajoAgent/UploadLinkInvalid`. No row and no
// log line carries the token, an object key, a name or a contact.
import type { RuleId } from "@legajo/shared";
import type { Connector } from "../connector/index";
import type { UploadLink } from "../domain/runtime";
import type { Logger } from "../lib/log";
import { type LinkRefusal, UPLOAD_MARK, markId } from "./links";

/** Accesses of the importer through a valid link. */
export type UploadAccess = "UPLOAD_LINK_OPENED" | "UPLOAD_PRESIGNED" | "UPLOAD_SESSION_DONE";

/** Refusals recorded once per link and variant. */
export type UploadDenial =
  | "UPLOAD_LINK_EXPIRED"
  | "UPLOAD_LINK_USED"
  | "UPLOAD_DOCTYPE_NOT_REQUESTED"
  | "UPLOAD_NOT_PDF"
  | "UPLOAD_TOO_LARGE"
  | "UPLOAD_PRESIGN_LIMIT"
  | "UPLOAD_FOREIGN_KEY";

/** Metric of docs/architecture.md §12 and the log fields its metric filter matches. */
export const UPLOAD_LINK_INVALID_METRIC = "UploadLinkInvalid";
export const UPLOAD_LINK_INVALID_LOG = "public_web.link_invalid";

/** Trigger of every decision the page records. */
const TRIGGER = "UPLOAD_LINK";

export interface AuditContext {
  readonly data: Connector;
  readonly log: Logger;
  readonly correlationId: string;
  /** Real time of the request. */
  readonly now: Date;
}

interface KnownLink {
  readonly link: UploadLink;
  readonly atSim: string;
}

function refsOf(link: UploadLink) {
  return { operationId: link.operationId, importerId: link.importerId };
}

export async function recordAccess(ctx: AuditContext, known: KnownLink, action: UploadAccess, detail: Readonly<Record<string, unknown>> = {}): Promise<void> {
  const { link } = known;
  await ctx.data.audit.record({
    firmId: link.firmId,
    clockId: link.clockId,
    decision: "ACTION",
    action,
    actor: "IMPORTER",
    trigger: TRIGGER,
    refs: refsOf(link),
    atSim: known.atSim,
    atReal: ctx.now.toISOString(),
    correlationId: ctx.correlationId,
    detail: { ...detail },
  });
}

export interface DenialInput {
  readonly denial: UploadDenial;
  readonly reason: string;
  readonly ruleIds?: readonly RuleId[];
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** `DENY` once per link and variant: a repeated attempt only logs. Returns whether a row was written. */
export async function recordDenial(ctx: AuditContext, known: KnownLink, input: DenialInput): Promise<boolean> {
  const { link } = known;
  const first = await ctx.data.runtime.claimIdempotency({ source: UPLOAD_MARK.deny, id: markId.deny(link.token, input.denial), atReal: ctx.now.toISOString() });
  ctx.log.info("public_web.denied", { denial: input.denial, operationId: link.operationId, recorded: first });
  if (!first) return false;
  await ctx.data.audit.record({
    firmId: link.firmId,
    clockId: link.clockId,
    decision: "DENY",
    action: input.denial,
    ruleIds: [...(input.ruleIds ?? [])],
    actor: "IMPORTER",
    trigger: TRIGGER,
    refs: refsOf(link),
    reason: input.reason,
    atSim: known.atSim,
    atReal: ctx.now.toISOString(),
    correlationId: ctx.correlationId,
    detail: { ...(input.detail ?? {}) },
  });
  return true;
}

const DENIAL_OF_REFUSAL: Readonly<Partial<Record<LinkRefusal, UploadDenial>>> = {
  EXPIRED: "UPLOAD_LINK_EXPIRED",
  WORLD_RESET: "UPLOAD_LINK_EXPIRED",
  USED: "UPLOAD_LINK_USED",
};

/**
 * An attempt with a token that does not open the page: always one metric line; plus, for a link that
 * exists, its `DENY` the first time. An unknown or malformed token has no firm to record it under.
 */
export async function recordRefusal(ctx: AuditContext, refusal: LinkRefusal, known: KnownLink | undefined): Promise<void> {
  ctx.log.warn(UPLOAD_LINK_INVALID_LOG, { metric: UPLOAD_LINK_INVALID_METRIC, reason: refusal });
  const denial = DENIAL_OF_REFUSAL[refusal];
  if (known === undefined || denial === undefined) return;
  await recordDenial(ctx, known, { denial, reason: `upload link ${refusal.toLowerCase().replace("_", " ")}`, detail: { refusal } });
}
