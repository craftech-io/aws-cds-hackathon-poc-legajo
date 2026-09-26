// Recipient fence of the single SES client, by sender profile (docs/architecture-integrations.md §1,
// docs/architecture.md §13, rule `CP-RECIPIENT-FENCE`). The caller declares the profile; the fence
// checks that the `From` belongs to it and that the recipient is one that profile may write to. The
// profile is never inferred from the recipient. Every profile refuses reserved domains and anything
// the strict parser refuses.
//
//   SYSTEM     From `avisos@legajo…`, or the live thread address of the operation it writes about
//              (`op-*@legajo…`); to `*@sim.legajo…`, `*@simulator.amazonses.com` or a registered demo
//              recipient (`SeedOverrides.demoRecipients`); never an `op-*@` thread.
//   SIMULATOR  To exactly one thread address that verifies by HMAC and resolves to a live operation
//              (no tombstone); in a reply, the `from` of the verified outbound mail it answers, and in
//              `SEND_NOW`, that operation's own address. From: the registered address of an ACTIVE
//              contact of that operation's supplier (and, in a reply, the `to` of the verified mail).
//   QA         From the injector `qainject-…@sim…` (never a party) or a registered party of a `qa-*`
//              world that is not an ACTIVE contact of the destination's supplier. To `qa-*@sim…`, or an
//              `op-*@` address of a `qa-*` clock or of no operation at all (an unknown number or a tag
//              that does not verify); an address of a demo, judge or `GLOBAL#firm-qa` world is refused.
//
// A `From` that does not match its profile is `INVALID`; a recipient outside the profile's set is
// `RECIPIENT_NOT_ALLOWED`. outbound/recipient-fence.ts (the pipeline) and the `QaDriver`'s
// `fence.probe` call this same function.
import { type MailAwaiting, NOTICES_ADDRESS, QA_INJECTOR_PREFIX, QA_PARTY_PREFIX, SES_MAILBOX_SIMULATOR_DOMAIN, SIM_MAIL_DOMAIN, parseClockId, parseThreadAddress } from "@legajo/shared";
import type { PartiesPort } from "../../connector/ports";
import type { Operation } from "../../domain/operations";
import { type ParsedAddress, isReserved, parseAddress } from "./address";
import type { ThreadResolution } from "./thread";

/** What the SIMULATOR profile is doing: answering one verified outbound mail, or a `SEND_NOW`. */
export type SimulatorPurpose =
  | { readonly kind: "REPLY"; readonly answered: { readonly from: string; readonly to: string } }
  | { readonly kind: "SEND_NOW"; readonly operationId: string };

export type FenceIntent =
  /** `operationId`: the operation a mail from its thread address is about (required with an `op-*` From). */
  | { readonly profile: "SYSTEM"; readonly from: string; readonly to: string; readonly operationId?: string }
  | { readonly profile: "SIMULATOR"; readonly from: string; readonly to: string; readonly purpose: SimulatorPurpose }
  | { readonly profile: "QA"; readonly from: string; readonly to: string };

export const FENCE_REASONS = [
  "FROM_ADDRESS_INVALID",
  "TO_ADDRESS_INVALID",
  "RESERVED_DOMAIN",
  "SYSTEM_FROM",
  "SYSTEM_TO_THREAD",
  "SYSTEM_RECIPIENT",
  "SIMULATOR_RECIPIENT",
  "SIMULATOR_NOT_ANSWERED_THREAD",
  "SIMULATOR_FROM",
  "QA_RECIPIENT",
  "QA_FROM",
  "QA_FROM_ACTIVE_CONTACT",
] as const;
export type FenceReason = (typeof FENCE_REASONS)[number];

export type FenceDecision =
  | { readonly allowed: true; readonly from: ParsedAddress; readonly to: ParsedAddress; readonly awaiting: MailAwaiting; readonly operation?: Operation }
  | { readonly allowed: false; readonly code: "INVALID" | "RECIPIENT_NOT_ALLOWED"; readonly reason: FenceReason };

export interface FenceDeps {
  readonly resolveThread: (address: string) => Promise<ThreadResolution>;
  readonly parties: Pick<PartiesPort, "listContacts" | "findContactsByEmailHash">;
  /** Keyed hash of an address (`email-hash` subkey), the key of `Parties GSI2`. */
  readonly emailHash: (address: string) => string;
  /** `SeedOverrides.demoRecipients.emails` (real team inboxes: PII, never logged). */
  readonly demoRecipients: () => readonly string[];
}

const invalid = (reason: FenceReason): FenceDecision => ({ allowed: false, code: "INVALID", reason });
const notAllowed = (reason: FenceReason): FenceDecision => ({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason });

async function isActiveContactOf(deps: FenceDeps, operation: Operation, address: string): Promise<boolean> {
  const contacts = await deps.parties.listContacts(operation.supplierId);
  return contacts.some((contact) => contact.status === "ACTIVE" && contact.email === address);
}

function operationOf(resolution: ThreadResolution): Operation | undefined {
  return resolution.status === "RESOLVED" || resolution.status === "TOMBSTONED" ? resolution.operation : undefined;
}

/** `avisos@`, or the live thread address of exactly the operation the mail is about. */
async function systemFromMatches(deps: FenceDeps, from: ParsedAddress, operationId: string | undefined): Promise<boolean> {
  if (from.address === NOTICES_ADDRESS) return true;
  if (parseThreadAddress(from.address) === undefined || operationId === undefined) return false;
  const resolution = await deps.resolveThread(from.address);
  return resolution.status === "RESOLVED" && resolution.operation.operationId === operationId;
}

async function systemFence(deps: FenceDeps, from: ParsedAddress, to: ParsedAddress, operationId: string | undefined): Promise<FenceDecision> {
  if (!(await systemFromMatches(deps, from, operationId))) return invalid("SYSTEM_FROM");
  if (parseThreadAddress(to.address) !== undefined) return notAllowed("SYSTEM_TO_THREAD");
  if (to.domain === SIM_MAIL_DOMAIN) return { allowed: true, from, to, awaiting: "SIMMAIL" };
  if (to.domain === SES_MAILBOX_SIMULATOR_DOMAIN || deps.demoRecipients().includes(to.address)) return { allowed: true, from, to, awaiting: "SES_EVENT" };
  return notAllowed("SYSTEM_RECIPIENT");
}

async function simulatorFence(deps: FenceDeps, from: ParsedAddress, to: ParsedAddress, purpose: SimulatorPurpose): Promise<FenceDecision> {
  const resolution = await deps.resolveThread(to.address);
  if (resolution.status !== "RESOLVED") return notAllowed("SIMULATOR_RECIPIENT");
  const { operation } = resolution;
  if (purpose.kind === "REPLY" && purpose.answered.from !== to.address) return notAllowed("SIMULATOR_NOT_ANSWERED_THREAD");
  if (purpose.kind === "SEND_NOW" && (purpose.operationId !== operation.operationId || operation.threadAddress !== to.address)) return notAllowed("SIMULATOR_NOT_ANSWERED_THREAD");
  if (purpose.kind === "REPLY" && purpose.answered.to !== from.address) return invalid("SIMULATOR_FROM");
  if (!(await isActiveContactOf(deps, operation, from.address))) return invalid("SIMULATOR_FROM");
  return { allowed: true, from, to, awaiting: "INBOUND", operation };
}

async function isQaWorldParty(deps: FenceDeps, from: ParsedAddress): Promise<boolean> {
  const contacts = await deps.parties.findContactsByEmailHash(deps.emailHash(from.address));
  return contacts.some((contact) => contact.email === from.address && parseClockId(contact.clockId)?.scope === "QA");
}

async function qaFence(deps: FenceDeps, from: ParsedAddress, to: ParsedAddress): Promise<FenceDecision> {
  let awaiting: MailAwaiting;
  let destination: Operation | undefined;
  if (to.domain === SIM_MAIL_DOMAIN && to.local.startsWith(QA_PARTY_PREFIX)) awaiting = "SIMMAIL";
  else {
    const resolution = await deps.resolveThread(to.address);
    destination = operationOf(resolution);
    const reachable = destination === undefined ? resolution.status === "INVALID" || resolution.status === "UNKNOWN" : parseClockId(destination.clockId)?.scope === "QA";
    if (!reachable) return notAllowed("QA_RECIPIENT");
    awaiting = "INBOUND";
  }
  const injector = from.domain === SIM_MAIL_DOMAIN && from.local.startsWith(QA_INJECTOR_PREFIX);
  if (!injector && !(await isQaWorldParty(deps, from))) return invalid("QA_FROM");
  // QA can never make a mail InboundEmail would trust: not from an ACTIVE contact of the destination.
  if (destination !== undefined && (await isActiveContactOf(deps, destination, from.address))) return invalid("QA_FROM_ACTIVE_CONTACT");
  return destination === undefined ? { allowed: true, from, to, awaiting } : { allowed: true, from, to, awaiting, operation: destination };
}

export async function checkFence(deps: FenceDeps, intent: FenceIntent): Promise<FenceDecision> {
  const to = parseAddress(intent.to);
  if (!to.ok) return invalid("TO_ADDRESS_INVALID");
  const from = parseAddress(intent.from);
  if (!from.ok) return invalid("FROM_ADDRESS_INVALID");
  if (isReserved(to.value)) return notAllowed("RESERVED_DOMAIN");
  switch (intent.profile) {
    case "SYSTEM":
      return systemFence(deps, from.value, to.value, intent.operationId);
    case "SIMULATOR":
      return simulatorFence(deps, from.value, to.value, intent.purpose);
    case "QA":
      return qaFence(deps, from.value, to.value);
  }
}
