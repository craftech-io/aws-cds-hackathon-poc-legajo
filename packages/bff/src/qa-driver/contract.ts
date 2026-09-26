// Contract of the `QaDriver` Lambda (docs/tool-catalog.md "Acciones del QaDriver", docs/test-plan.md
// §4, ADR-0005), shared by the Lambda and the scenario runner (scripts/scenarios/): the request
// envelope, the idempotency key every action carries, the result envelope and the provider ids
// derived from the key, so retrying a step never duplicates an effect.
//
//   request   { action, idempotencyKey: "<runId>/<scenario>/<step>[/<label>]", input }
//   result    { ok: true, replayed, result } | { ok: false, error: { code, message, reason? } }
//
// The inputs of every action are in contract-inputs.ts.
import { z } from "zod";
import { ErrorCode, sha256Hex } from "@legajo/shared";

/** Fixed name, so the bootstrap's `qa-runner` role fences it by ARN (docs/architecture.md §1). */
export const QA_DRIVER_FUNCTION_NAME = "aws-cds-hackathon-poc-legajo-poc-qa-driver";

export const QA_ACTIONS = [
  "world.create",
  "world.destroy",
  "clock.advance",
  "clock.advanceTo",
  "clock.advanceToNext",
  "clock.fireMilestone",
  "clock.unfreeze",
  "clock.freeze",
  "op.settle",
  "snapshot",
  "wa.inbound",
  "upload.presign",
  "upload.done",
  "supplier.setBehaviour",
  "supplier.sendNow",
  "reader.setFaults",
  "feed.eta",
  "feed.customs",
  "console",
  "email.inject",
  "mail.outcome",
  "email.redeliver",
  "link.expire",
  "nonce.expire",
  "schedule.fireStale",
  "fence.probe",
  "guardrail.probe",
  "turn.forceFailure",
  "event.poison",
  "dlq.find",
  "dlq.delete",
  "alarm.history",
  "platform.get",
  "probe.mocks",
  "memory.inspect",
  "policyAudit.run",
  "metrics.get",
  "batch.run",
] as const;
export const QaActionName = z.enum(QA_ACTIONS);
export type QaActionName = z.infer<typeof QaActionName>;

/**
 * Actions that only read: they are never cached under their key (a retry reads again) and never
 * reset the runner's quiescence mark. Every other action changes something.
 */
export const READ_ONLY_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>([
  "op.settle",
  "snapshot",
  "mail.outcome",
  "fence.probe",
  "guardrail.probe",
  "dlq.find",
  "alarm.history",
  "platform.get",
  "probe.mocks",
  "memory.inspect",
  "metrics.get",
]);

/** `<github run id>-<attempt>` in CI or `local-<ulid in lower case>` from a laptop (docs/test-plan.md §4.4). */
export const RunId = z.string().regex(/^(?:\d{1,20}-\d{1,3}|local-[0-9a-hjkmnp-tv-z]{26})$/, "expected <run id>-<attempt> or local-<ulid>");
export type RunId = z.infer<typeof RunId>;

/** Scenario slug of clocks, mailboxes and keys: `sc01`, `sc18-rate` (lower case, it ends up in addresses). */
export const ScenarioSlug = z.string().regex(/^sc\d{2}(?:-[a-z0-9]{1,8})?$/, "expected sc<nn> or sc<nn>-<suffix>");
export type ScenarioSlug = z.infer<typeof ScenarioSlug>;

/** `<runId>/<scenario>/<step>` plus an optional label per call inside the step. */
export const IdempotencyKey = z
  .string()
  .max(128)
  .regex(/^(?:\d{1,20}-\d{1,3}|local-[0-9a-hjkmnp-tv-z]{26})\/sc\d{2}(?:-[a-z0-9]{1,8})?\/\d{1,3}(?:\/[a-z0-9][a-z0-9.-]{0,31})?$/, "expected <runId>/<scenario>/<step>[/<label>]");
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export function idempotencyKeyOf(parts: { readonly runId: string; readonly scenario: string; readonly step: number; readonly label?: string }): IdempotencyKey {
  const base = `${parts.runId}/${parts.scenario}/${parts.step}`;
  return IdempotencyKey.parse(parts.label === undefined ? base : `${base}/${parts.label}`);
}

export const QaRequest = z
  .object({
    action: QaActionName,
    idempotencyKey: IdempotencyKey,
    input: z.unknown().optional(),
  })
  .strict();
export type QaRequest = z.infer<typeof QaRequest>;

export const QaError = z.object({ code: ErrorCode, message: z.string(), reason: z.string().optional() });
export type QaError = z.infer<typeof QaError>;

export type QaResponse<T = unknown> = { readonly ok: true; readonly replayed: boolean; readonly result: T } | { readonly ok: false; readonly error: QaError };

export const QaResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), replayed: z.boolean(), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: QaError }),
]);

/** Reasons the driver itself answers with (besides the domain's own). */
export const QA_REASON = {
  /** The fence of ADR-0005: firm not of QA type, clock outside the allowed set, action not in a closed list. */
  QA_FENCE: "QA_FENCE",
  /** The module the action drives is not deployed with this function yet. */
  NOT_WIRED: "NOT_WIRED",
  /** `op.settle` ran out of time with something still pending. */
  NOT_SETTLED: "NOT_SETTLED",
  /** `mail.outcome` found no probe for the mail in time. */
  NO_OUTCOME: "NO_OUTCOME",
  /** `memory.inspect` with `waitForExtraction` ran out of time; the message names the strategy. */
  EXTRACTION_INCOMPLETE: "EXTRACTION_INCOMPLETE",
} as const;

// ---- Ids derived from the idempotency key (docs/test-plan.md §4.4) --------------------------------

async function digest(key: string): Promise<string> {
  return sha256Hex(IdempotencyKey.parse(key));
}

/** `wamid.SIM.<sha256(key)>`: the simulated WhatsApp message id of `wa.inbound`. */
export async function simulatedWamid(key: string): Promise<string> {
  return `wamid.SIM.${await digest(key)}`;
}

/** `X-Legajo-Mail-Id` of a mail the driver makes someone send (`email.inject`, `supplier.sendNow`). */
export async function qaMailId(key: string): Promise<string> {
  return `qa${(await digest(key)).slice(0, 40)}`;
}

/** RFC 5322 `Message-ID` of `email.inject`, on the injector's own domain. */
export async function qaMessageId(key: string, domain: string): Promise<string> {
  return `<qa-${(await digest(key)).slice(0, 40)}@${domain}>`;
}

/** Event id of an event the driver enqueues (`event.poison`). */
export async function qaEventId(key: string): Promise<string> {
  return `qa-${(await digest(key)).slice(0, 40)}`;
}
