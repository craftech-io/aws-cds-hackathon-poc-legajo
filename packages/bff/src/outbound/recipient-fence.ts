// The recipient fence of the outbound pipeline (`CP-RECIPIENT-FENCE`, docs/architecture-integrations.md
// §1, docs/architecture.md §13). It is the same fence the single SES client applies inside `send`
// (channels/email/fence.ts `checkFence`, every sender profile: SYSTEM, SIMULATOR, QA and LEAD_NOTICE),
// asked before anything is rendered so a refused recipient is a policy decision with its rule, and asked
// again by the client right before SES. For WhatsApp the fence is the registry: the only recipient is
// the registered phone of the operation's importer (`LAM-RECIPIENT`), and a guest world never reaches
// a real phone because its WhatsApp always goes through the simulated transport.
//
// `probeFence` is the `fence.probe` of the `QaDriver` (docs/tool-catalog.md): the same verdict for an
// address, in test mode, without SES or End User Messaging Social.
import { NOTICES_ADDRESS, normalizePhone, parseClockId, type SenderProfile } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import { type FenceDecision, type FenceDeps, type FenceIntent, checkFence } from "../channels/email/fence";
import type { Operation } from "../domain/operations";
import type { PolicyVerdict } from "../policy/types";

export interface FenceVerdict extends PolicyVerdict {
  /** `RECIPIENT_NOT_ALLOWED` for a recipient outside the profile, `INVALID` for a `From` that is not the profile's. */
  readonly code?: "INVALID" | "RECIPIENT_NOT_ALLOWED";
  readonly reason?: string;
}

/** True for a world whose messages only ever reach simulated mailboxes and the simulated phone (ADR-0015 §4). */
export function isGuestWorld(clockId: string): boolean {
  return parseClockId(clockId)?.scope === "GUEST";
}

function verdictOf(decision: FenceDecision, profile: SenderProfile): FenceVerdict {
  if (decision.allowed) return { allowed: true, detail: `inside the ${profile} fence` };
  return { allowed: false, code: decision.code, reason: decision.reason, detail: `${profile} fence: ${decision.reason}` };
}

/** The fence of any sender profile, as a verdict the engine reads (`CP-RECIPIENT-FENCE`). */
export async function profileFence(deps: FenceDeps, intent: FenceIntent): Promise<FenceVerdict> {
  return verdictOf(await checkFence(deps, intent), intent.profile);
}

/** The SYSTEM fence of an email the pipeline sends about `operation`, from its thread address or `avisos@`. */
export function emailFence(deps: FenceDeps, input: { readonly operation: Pick<Operation, "operationId" | "clockId">; readonly from: string; readonly to: string }): Promise<FenceVerdict> {
  return profileFence(deps, { profile: "SYSTEM", from: input.from, to: input.to, operationId: input.operation.operationId, clockId: input.operation.clockId });
}

function samePhone(a: string, b: string): boolean {
  try {
    return normalizePhone(a) === normalizePhone(b);
  } catch {
    return false;
  }
}

/** WhatsApp goes only to the registered phone of the operation's importer. */
export function whatsappFence(input: { readonly to: string | undefined; readonly registeredPhone: string | undefined }): FenceVerdict {
  if (input.to === undefined || input.registeredPhone === undefined) return { allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "NO_REGISTERED_PHONE", detail: "the importer has no registered phone" };
  return samePhone(input.to, input.registeredPhone)
    ? { allowed: true, detail: "the WhatsApp goes to the importer's registered phone" }
    : { allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "NOT_REGISTERED_PHONE", detail: "the WhatsApp does not go to the importer's registered phone" };
}

/**
 * The fence of a contact address the importer proposed (`propose_supplier_contact`, FL-014/FL-015):
 * the pipeline would write to it from the operation's thread address, so it must pass that fence now.
 */
export function proposedContactFence(deps: FenceDeps, operation: Pick<Operation, "operationId" | "clockId" | "threadAddress">, address: string): Promise<FenceVerdict> {
  return emailFence(deps, { operation, from: operation.threadAddress, to: address });
}

export interface FenceProbeInput {
  readonly clockId: string;
  readonly profile: SenderProfile;
  readonly channel: "EMAIL" | "WHATSAPP";
  readonly to: string;
  readonly operationId?: string;
}

export interface FenceProbeResult {
  readonly allowed: boolean;
  readonly ruleIds: readonly string[];
  readonly reason?: string;
}

export interface FenceProbeDeps {
  readonly fence: FenceDeps;
  readonly data: Pick<Connector, "operations" | "parties">;
}

function probeIntent(input: FenceProbeInput, operation: Operation | undefined): FenceIntent | undefined {
  const from = operation?.threadAddress ?? NOTICES_ADDRESS;
  switch (input.profile) {
    case "SYSTEM":
      return { profile: "SYSTEM", from, to: input.to, clockId: input.clockId, ...(operation === undefined ? {} : { operationId: operation.operationId }) };
    case "LEAD_NOTICE":
      return { profile: "LEAD_NOTICE", from: NOTICES_ADDRESS, to: input.to };
    // The simulator and QA profiles need a verified mail to answer or an injector of the run: a probe
    // of an address alone cannot build their `From`, so it is refused rather than guessed.
    case "SIMULATOR":
    case "QA":
      return undefined;
  }
}

/** `fence.probe`: the fence (and, for WhatsApp, the registry) for one address; never sends. */
export async function probeFence(deps: FenceProbeDeps, input: FenceProbeInput): Promise<FenceProbeResult> {
  const operation = input.operationId === undefined ? undefined : await deps.data.operations.findOperation(input.operationId);
  if (operation !== undefined && operation.clockId !== input.clockId) return { allowed: false, ruleIds: ["LAM-OP-SCOPE"], reason: "OPERATION_OF_ANOTHER_WORLD" };
  if (input.channel === "WHATSAPP") {
    const importer = operation === undefined ? undefined : await deps.data.parties.findImporter(operation.importerId);
    const verdict = whatsappFence({ to: input.to, registeredPhone: importer?.phoneE164 });
    return verdict.allowed ? { allowed: true, ruleIds: ["CP-RECIPIENT-FENCE"] } : { allowed: false, ruleIds: ["CP-RECIPIENT-FENCE"], reason: verdict.reason ?? "RECIPIENT_NOT_ALLOWED" };
  }
  const intent = probeIntent(input, operation);
  if (intent === undefined) return { allowed: false, ruleIds: ["CP-RECIPIENT-FENCE"], reason: "PROFILE_NEEDS_A_MAIL" };
  const decision = await checkFence(deps.fence, intent);
  return decision.allowed ? { allowed: true, ruleIds: ["CP-RECIPIENT-FENCE"] } : { allowed: false, ruleIds: ["CP-RECIPIENT-FENCE"], reason: decision.reason };
}
