// The outbound pipeline (docs/tool-catalog.md, target `messaging`; docs/design-brief.md §5.5-§5.7;
// ADR-0011 and ADR-0012): the one path every message takes out of the system. In order:
//
//   0. shape      a WhatsApp is a text or a template with its own buttons (render/whatsapp.ts); a
//                 redelivered request whose message already exists is answered from it, never sent twice,
//                 and so is the same WhatsApp asked twice in one turn (repeat.ts, after the context)
//   1. context    the operation and the recipient from the registry (`LAM-RECIPIENT`), the dated facts
//                 the policy rebuilds, the counterpart's recent messages and the turn's tool results
//   2. verdicts   the recipient fence of the SYSTEM profile (recipient-fence.ts, the SES client's own
//                 fence) and the foreign links of the text (links.ts), handed to the engine
//   3. policy     every `CP-*` rule in order (control first, `LAM-CONTROL`; the guest world's quota
//                 last, decide.ts); a denial is audited and answered with its rule's code
//   4. content    G2 over the model's free text and the deterministic verification (content.ts); a
//                 failure is `GROUNDING_FAIL`, audited
//   5. render     the Meta message with its nonces and upload link, or the email with the code's
//                 subject and headers (render/)
//   6. deferral   a time rule that deferred the send: `TIMER#DEFERRED_SEND#<messageId>` at
//                 `nextAllowedAt` and the `Message` `DEFERRED` (defer.ts); the timer re-runs steps 1-3,
//                 5 and 7 when it fires
//   7. delivery   the `Message` `QUEUED`, the `ALLOW` with every rule evaluated, the transport (SES
//                 through its fence, End User Messaging Social, or the simulated transport, always the
//                 simulated one in a guest world), then the message `SENT`/`DELIVERED` (deliver.ts)
//
// Nothing here throws to the caller for a refusal: the result says SENT, DEFERRED or REFUSED with the
// tool error (`{code, message, reason}`) the send tools answer. A shape the transports would refuse
// throws `ToolError INVALID` before anything is written; only an unexpected failure throws otherwise.
import { ERROR_REASON, NOTICES_ADDRESS, ToolError, fail, type RuleId } from "@legajo/shared";
import { countMetric } from "../channels/adapter";
import type { Message } from "../domain/conversations";
import type { PolicyDecision, PolicyVerdict } from "../policy/types";
import { type SendContext, loadSendContext, policyInputOf, responsiblesOf, workingContact } from "./context";
import { allowanceOf, textOf, textsOf } from "./content";
import { decideSend, deniedByQuota } from "./decide";
import { deferSend } from "./defer";
import type { OutboundDeps } from "./deps";
import { deliver } from "./deliver";
import { type LinkAllowance, foreignLinksVerdict } from "./links";
import { actionOf, recordDecision } from "./persist";
import { type Prepared, prepareContent } from "./prepare";
import { emailFence, isGuestWorld, whatsappFence } from "./recipient-fence";
import { repeatedInTurn } from "./repeat";
import { checkWhatsAppShape } from "./render/whatsapp";
import { OUTBOUND_REASON, type OutboundCall, type OutboundRefused, type OutboundRequest, type OutboundResult } from "./types";

export const POLICY_DENIALS_METRIC = "PolicyDenials";

/** Buttons whose nonce carries what only the code knows (a contact, an operation of a list). */
const CODE_ONLY_BUTTONS = new Set(["CONFIRM_CONTACT", "REJECT_CONTACT", "CHOOSE_OPERATION"]);
/** The contact buttons a `CONTACT_CONFIRMATION` may name: the code binds their nonces to the contact. */
const CONTACT_BUTTONS = new Set(["CONFIRM_CONTACT", "REJECT_CONTACT"]);

/** The SYSTEM fence (email) or the registry (WhatsApp) for the recipient the registry gave. */
export async function fenceVerdictOf(deps: OutboundDeps, request: OutboundRequest, context: SendContext): Promise<PolicyVerdict> {
  if (request.channel === "WHATSAPP") return whatsappFence({ to: context.to, registeredPhone: context.importer?.phoneE164 });
  // No contact at all is the supplier rules' to decide (`CP-SUPPLIER-AUTH`: "no registered contact").
  if (context.to === undefined) return { allowed: true, detail: "no registered contact to fence: CP-SUPPLIER-AUTH decides" };
  const from = context.counterpart === "SUPPLIER" ? context.operation.threadAddress : NOTICES_ADDRESS;
  return emailFence(deps.fence, { operation: context.operation, from, to: context.to });
}

function policyFailure(decision: PolicyDecision): ReturnType<typeof fail> {
  const reason = decision.reason ?? "the contact policy denied the send";
  if (deniedByQuota(decision)) return fail("POLICY_DENIED", reason, ERROR_REASON.QUOTA_EXCEEDED);
  return fail(decision.errorCode ?? "POLICY_DENIED", reason, decision.ruleIds[0]);
}

async function refuse(deps: OutboundDeps, call: OutboundCall, request: OutboundRequest, context: SendContext, refusal: Omit<OutboundRefused, "status">, detail?: Readonly<Record<string, unknown>>, action?: string): Promise<OutboundRefused> {
  await recordDecision(deps, call, request, context, {
    decision: "DENY",
    action: action ?? actionOf(request),
    ruleIds: refusal.ruleIds,
    ...(refusal.decision === undefined ? {} : { policy: refusal.decision }),
    ...(request.messageId === undefined ? {} : { refs: { messageId: request.messageId } }),
    reason: refusal.failure.error.reason === undefined ? refusal.failure.error.message : `${refusal.failure.error.reason}: ${refusal.failure.error.message}`,
    ...(detail === undefined ? {} : { detail }),
  });
  call.log.warn("outbound.refused", { code: refusal.failure.error.code, reason: refusal.failure.error.reason, rule: refusal.ruleIds[0] });
  return { status: "REFUSED", ...refusal };
}

export interface Decided {
  readonly context: SendContext;
  readonly decision: PolicyDecision;
  readonly allowance: LinkAllowance;
}

/**
 * Steps 1 to 3: the context, the verdicts and the policy, for a new send or a deferred one firing.
 * `kept` is what a deferred text was allowed to carry when it was checked (its turn's results expire).
 */
export async function decide(deps: OutboundDeps, call: OutboundCall, request: OutboundRequest, messageId: string, kept?: Pick<LinkAllowance, "links"> & { readonly numbers: readonly string[] }): Promise<Decided> {
  const context = await loadSendContext(deps, request);
  const clockId = context.operation.clockId;
  const whatsappMode = request.channel === "WHATSAPP" ? deps.whatsapp(clockId, context.importer?.phoneE164).mode : "simulated";
  const [fence, current, responsibles] = await Promise.all([fenceVerdictOf(deps, request, context), allowanceOf(deps, context), responsiblesOf(deps, request)]);
  const allowance: LinkAllowance = kept === undefined ? current : { ...current, links: [...current.links, ...kept.links], numbers: new Set([...current.numbers, ...kept.numbers]) };
  const foreignLinks = foreignLinksVerdict(textsOf(request), allowance);
  const text = textOf(request);
  const template = request.channel === "WHATSAPP" ? request.template : undefined;
  const input = policyInputOf(
    request,
    context,
    { messageId, ...(text === undefined ? {} : { text }), ...(template === undefined ? {} : { template }), ...(responsibles === undefined ? {} : { responsibles }), whatsappMode, realNow: deps.wallClock() },
    { fence, foreignLinks, worldQuota: { clockId } },
  );
  return { context, decision: await decideSend(deps, call.log, input, clockId), allowance };
}

/** Answers the refusal of a policy decision (audited `DENY` with its rule). */
export function refusePolicy(deps: OutboundDeps, call: OutboundCall, request: OutboundRequest, context: SendContext, decision: PolicyDecision, action?: string): Promise<OutboundRefused> {
  countMetric(call.log, POLICY_DENIALS_METRIC, { rule: decision.ruleIds[0], channel: request.channel, kind: request.kind });
  return refuse(deps, call, request, context, { failure: policyFailure(decision), ruleIds: [...decision.ruleIds], decision, ...(decision.window === undefined ? {} : { window: decision.window }) }, undefined, action);
}

async function refuseContent(deps: OutboundDeps, call: OutboundCall, request: OutboundRequest, context: SendContext, decision: PolicyDecision, prepared: Prepared): Promise<OutboundRefused> {
  const outcome = prepared.content;
  if (outcome.ok) throw new RangeError("refuseContent needs a failed content check");
  const guardrail = outcome.guardrail === undefined ? {} : { guardrail: outcome.guardrail };
  if (outcome.unavailable === true) {
    return refuse(deps, call, request, context, { failure: fail("UNAVAILABLE", "the output guardrail is not available; try again later", OUTBOUND_REASON.GUARDRAIL_UNAVAILABLE), ruleIds: ["G2"], decision, ...guardrail });
  }
  const message = `the text cannot go out: ${outcome.failures.map((failure) => failure.detail).join("; ")}. Use only values a tool returned in this turn, or escalate.`;
  const ruleIds: RuleId[] = outcome.g2 ? ["G2"] : [];
  if (outcome.g2Verdict !== undefined) call.log.warn("outbound.g2_refused", { kind: request.kind, ...outcome.g2Verdict });
  const detail = { checks: outcome.failures.map((failure) => failure.check), ...(outcome.g2Verdict === undefined ? {} : { g2: outcome.g2Verdict }) };
  return refuse(deps, call, request, context, { failure: fail("GROUNDING_FAIL", message.slice(0, 900), OUTBOUND_REASON.GROUNDING_FAIL), ruleIds, decision, ...guardrail }, detail);
}

/**
 * FL-011: a `CONTACT_CONFIRMATION` about the supplier's known contact names `CONFIRM_CONTACT` /
 * `REJECT_CONTACT`, and the code binds both nonces to the ACTIVE contact that works for the
 * operation's supplier (never to an id the caller wrote). Without one there is nothing to confirm.
 */
export async function bindContactButtons(deps: Pick<OutboundDeps, "data">, request: OutboundRequest): Promise<OutboundRequest> {
  if (request.channel !== "WHATSAPP" || request.kind !== "CONTACT_CONFIRMATION") return request;
  const buttons = request.buttons ?? [];
  if (!buttons.some((button) => CONTACT_BUTTONS.has(button.action) && button.payload === undefined)) return request;
  const operation = await deps.data.operations.getOperation(request.operationId);
  const contact = workingContact(await deps.data.parties.listContacts(operation.supplierId));
  if (contact === undefined) throw new ToolError("INVALID", "the supplier has no active contact to confirm; ask the importer for one", OUTBOUND_REASON.RESERVED_BUTTON);
  const payload = { supplierId: contact.supplierId, contactId: contact.contactId };
  return { ...request, buttons: buttons.map((button) => (CONTACT_BUTTONS.has(button.action) && button.payload === undefined ? { ...button, payload } : button)) };
}

/** Step 0: what the transports would refuse, before anything is issued or written. */
export function checkShape(request: OutboundRequest): void {
  if (request.channel !== "WHATSAPP") return;
  checkWhatsAppShape(request, request.kind);
  const reserved = (request.buttons ?? []).some((button) => CODE_ONLY_BUTTONS.has(button.action) && !(request.kind === "CONTACT_CONFIRMATION" && CONTACT_BUTTONS.has(button.action) && button.payload !== undefined));
  if (request.textSource === "MODEL" && reserved) {
    throw new ToolError("INVALID", "operation-choice buttons, and contact buttons outside a CONTACT_CONFIRMATION, are written by the code, never by a send", OUTBOUND_REASON.RESERVED_BUTTON);
  }
}

const SENT_STATUSES = new Set<Message["status"]>(["QUEUED", "SENT", "DELIVERED", "READ", "DELAYED", "BOUNCED", "COMPLAINED"]);

/** The answer of a request whose message already exists (a redelivered event never sends twice). */
export function replayOf(message: Message): OutboundResult {
  const { messageId } = message;
  if (message.status === "DEFERRED") {
    return { status: "DEFERRED", messageId, replayed: true, nextAllowedAt: message.policy?.nextAllowedAt ?? message.sentAtSim, timerKey: message.deferredTimerKey ?? "" };
  }
  if (SENT_STATUSES.has(message.status)) return { status: "SENT", messageId, replayed: true, ...(message.providerMessageId === undefined ? {} : { providerMessageId: message.providerMessageId }) };
  return { status: "REFUSED", failure: fail("CONFLICT", "this message was already decided and did not go out", OUTBOUND_REASON.SEND_FAILED), ruleIds: [...(message.policy?.ruleIds ?? [])] };
}

/** The pipeline for one send. */
export async function sendOutbound(deps: OutboundDeps, asked: OutboundRequest, call: OutboundCall): Promise<OutboundResult> {
  const log = call.log.child({ service: "outbound", channel: asked.channel, kind: asked.kind });
  const scoped: OutboundCall = { ...call, log };
  const request = await bindContactButtons(deps, asked);
  checkShape(request);
  if (request.messageId !== undefined) {
    const existing = await deps.data.conversations.getMessage(request.operationId, request.messageId);
    if (existing !== undefined) return replayOf(existing);
  }
  const messageId = request.messageId ?? `msg-${deps.newId()}`;
  const { context, decision, allowance } = await decide(deps, scoped, request, messageId);
  const repeated = repeatedInTurn(request, context.history);
  if (repeated !== undefined) {
    log.warn("outbound.repeated_in_turn", { messageId: repeated.messageId });
    return replayOf(repeated);
  }
  if (decision.outcome === "DENY") return refusePolicy(deps, scoped, request, context, decision);
  const prepared = await prepareContent(deps, request, context, messageId);
  if (!prepared.content.ok) return refuseContent(deps, scoped, request, context, decision, prepared);
  if (prepared.rendered === undefined) throw new ToolError("INVALID", "nothing to send", OUTBOUND_REASON.CONTENT_INVALID);
  const guardrail = prepared.content.guardrail === undefined ? {} : { guardrail: prepared.content.guardrail };
  if (decision.outcome === "DEFER") return deferSend(deps, scoped, { request, context, decision, messageId, rendered: prepared.rendered, allowance, ...guardrail });
  if (isGuestWorld(context.operation.clockId)) log.debug("outbound.guest_world", { simulatedOnly: true });
  return deliver(deps, scoped, { request, context, decision, messageId, rendered: prepared.rendered, ...guardrail });
}
