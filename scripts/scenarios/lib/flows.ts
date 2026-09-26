// Sequences many scenarios share (docs/test-plan.md §4.5): the first request of a milestone, the
// importer handing the documents to the supplier, a send the contact policy defers and releases at
// `nextAllowedAt`, and the simulated supplier's reply. Every wait is the one of its path (§4.3) and
// every move of the clock settles the operation first (world.ts).
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import { type MessageFilter, SENT_STATUSES, blockOrigins, decisions, inbound, nextPending, outbound, sameInstant } from "./asserts";
import { WAITS } from "./eventually";
import { forbiddenIn, isLanguage } from "./oracles";
import { type ScenarioContext, ensure } from "./steps";
import { advanceTo, advanceToTimer, awaitMessage, awaitState } from "./world";

type Kind = NonNullable<QaSnapshot["messages"][number]["kind"]>;

/** The importer taps the button `action` of the last message that carried it. */
export async function tap(ctx: ScenarioContext, operationId: string, action: "UPLOAD" | "SUPPLIER_SENDS" | "QUESTION" | "OPT_OUT" | "CONFIRM_CONTACT" | "REJECT_CONTACT" | "OTHER_CONTACT" | "TALK_TO_FIRM"): Promise<void> {
  await ctx.qa("wa.inbound", { operationId, message: { type: "button", action } });
}

export async function importerSays(ctx: ScenarioContext, operationId: string, text: string): Promise<void> {
  await ctx.qa("wa.inbound", { operationId, message: { type: "text", text } });
}

/** `DOCS_REQUEST` at its hour: the template `legajo_docs_pendientes` with its four buttons (FL-007). */
export async function firstRequest(ctx: ScenarioContext, operationId: string, docsRequestAt: string): Promise<QaSnapshot> {
  await advanceTo(ctx, operationId, docsRequestAt);
  return expectTemplateRequest(ctx, operationId);
}

export async function expectTemplateRequest(ctx: ScenarioContext, operationId: string): Promise<QaSnapshot> {
  const snapshot = await awaitMessage(ctx, operationId, { direction: "OUT", channel: "WHATSAPP", kind: "DOCS_REQUEST", status: [...SENT_STATUSES] });
  const request = outbound(snapshot, { channel: "WHATSAPP", kind: "DOCS_REQUEST" })[0];
  ensure(request?.template?.name === "legajo_docs_pendientes", "the first request goes as the template legajo_docs_pendientes");
  const actions = request.buttons.map((button) => button.action);
  for (const action of ["UPLOAD", "SUPPLIER_SENDS", "QUESTION", "OPT_OUT"] as const) ctx.check(actions.includes(action), `the first request carries the ${action} button`);
  ctx.note("docsRequest", request.messageId);
  return snapshot;
}

/** "Los manda el proveedor" and "Sí, escribile": the supplier's contact confirmed by the importer (FL-011, FL-012). */
export async function delegateToSupplier(ctx: ScenarioContext, operationId: string): Promise<QaSnapshot> {
  await tap(ctx, operationId, "SUPPLIER_SENDS");
  const asked = await awaitMessage(ctx, operationId, { direction: "OUT", channel: "WHATSAPP", kind: "CONTACT_CONFIRMATION" });
  const question = outbound(asked, { kind: "CONTACT_CONFIRMATION" })[0];
  const offered = question?.buttons.map((button) => button.action) ?? [];
  for (const action of ["CONFIRM_CONTACT", "REJECT_CONTACT", "OTHER_CONTACT"] as const) ctx.check(offered.includes(action), `the contact confirmation offers ${action}`);
  await tap(ctx, operationId, "CONFIRM_CONTACT");
  return awaitState(ctx, operationId, "the email to the supplier is sent or deferred", (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "DOCS_REQUEST" }).length > 0 || decisions(snapshot, { decision: "DEFER" }).length > 0);
}

/**
 * A send the policy deferred: the `DEFER` decision with `ruleId` and the `TIMER#DEFERRED_SEND` due at
 * `nextAllowedAt`; then the clock moves there and the message goes out at that simulated time.
 */
export async function deferredThenSent(ctx: ScenarioContext, operationId: string, filter: MessageFilter & { readonly kind: Kind | readonly Kind[] }, ruleId: string, nextAllowedAt: string, timeoutSec: number = WAITS.turnSec): Promise<QaSnapshot> {
  const what = String(filter.kind);
  const deferred = await awaitState(ctx, operationId, `${what} deferred by ${ruleId}`, (snapshot) => decisions(snapshot, { decision: "DEFER", ruleId }).length > 0 && nextPending(snapshot, "DEFERRED_SEND") !== undefined, timeoutSec);
  const timer = nextPending(deferred, "DEFERRED_SEND");
  ctx.check(sameInstant(timer?.dueAtSim, nextAllowedAt), `${what} is deferred to ${timer?.dueAtSim ?? "nothing"}, expected ${nextAllowedAt}`);
  await advanceToTimer(ctx, operationId, "DEFERRED_SEND");
  const sent = await awaitMessage(ctx, operationId, { ...filter, direction: "OUT", status: [...SENT_STATUSES] }, timeoutSec);
  const message = outbound(sent, { ...filter, status: [...SENT_STATUSES] }).find((candidate) => sameInstant(candidate.sentAtSim, nextAllowedAt));
  ctx.check(message !== undefined, `${what} went out at ${nextAllowedAt}`);
  return sent;
}

/** An email to the supplier that left: in English (the deterministic detector), with the operation in the subject. */
export function checkSupplierEmail(ctx: ScenarioContext, snapshot: QaSnapshot, kind: Kind): void {
  const email = outbound(snapshot, { channel: "EMAIL", kind, status: [...SENT_STATUSES] }).at(-1);
  ensure(email !== undefined, `an email ${kind} to the supplier went out`);
  ctx.check(isLanguage(email.body, "en"), `the email ${kind} is in English`);
  ctx.check((email.subject ?? "").startsWith(`[Op ${snapshot.operation.operationNumber}]`), `the subject of ${kind} names the operation`);
}

/** The simulated supplier's reply: its timer, then the real trip through SES, the intake and the reading. */
export async function supplierReplies(ctx: ScenarioContext, operationId: string, until: (snapshot: QaSnapshot) => boolean, what: string): Promise<QaSnapshot> {
  await awaitState(ctx, operationId, "the supplier's reply is scheduled", (snapshot) => nextPending(snapshot, "SIM_REPLY") !== undefined, WAITS.sesRoundTripSec);
  await advanceToTimer(ctx, operationId, "SIM_REPLY");
  const done = await awaitState(ctx, operationId, what, (snapshot) => inbound(snapshot, { channel: "EMAIL" }).some((message) => message.trusted) && until(snapshot), WAITS.sesRoundTripSec);
  return done;
}

/**
 * The common start of the supplier scenarios: the milestone's template, the importer hands the
 * documents to the supplier, and the email goes out (at once, or at `deferredTo` when the supplier's
 * business hours do not overlap Argentina's).
 */
export async function upToSupplierEmail(ctx: ScenarioContext, operationId: string, docsRequestAt: string, deferredTo?: string): Promise<QaSnapshot> {
  await firstRequest(ctx, operationId, docsRequestAt);
  const asked = await delegateToSupplier(ctx, operationId);
  const sent = deferredTo === undefined ? asked : await deferredThenSent(ctx, operationId, { channel: "EMAIL", kind: "DOCS_REQUEST" }, "CP-HOURS-SUPPLIER", deferredTo);
  checkSupplierEmail(ctx, sent, "DOCS_REQUEST");
  return sent;
}

/** Reports where every block of the step came from (or that the turn ran normally) and returns them. */
export function reportBlocks(ctx: ScenarioContext, snapshot: QaSnapshot, sinceSim: string) {
  const found = blockOrigins(snapshot, sinceSim);
  if (found.length === 0) ctx.blocked("NONE", "normal turn, nothing blocked");
  for (const block of found) ctx.blocked(block.origin, block.detail);
  return found;
}

/** No outbound message since `sinceSim` carries a forbidden pattern (tariff position, amount, address, foreign URL…). */
export function checkNoForbiddenOutput(ctx: ScenarioContext, snapshot: QaSnapshot, sinceSim: string): void {
  for (const message of outbound(snapshot, { sinceSim })) {
    const found = forbiddenIn(message.body);
    ctx.check(found.length === 0, `${message.kind ?? "message"} ${message.messageId} carries ${found.join(", ")}`);
  }
}

/**
 * The first email to a supplier whose hours the scenario does not pin: out at once, or released at the
 * `nextAllowedAt` of its `DEFERRED_SEND`.
 */
export async function emailOutWhenAllowed(ctx: ScenarioContext, operationId: string, reached: (snapshot: QaSnapshot) => boolean): Promise<QaSnapshot> {
  const first = await awaitState(ctx, operationId, "the email sent or deferred", (snapshot) => reached(snapshot) || nextPending(snapshot, "DEFERRED_SEND") !== undefined);
  if (!reached(first)) await advanceToTimer(ctx, operationId, "DEFERRED_SEND");
  return awaitState(ctx, operationId, "the email went out", reached, WAITS.sesRoundTripSec);
}

/** Request, delegation and the first email to the supplier, whatever the supplier's time zone. */
export async function requestToSupplier(ctx: ScenarioContext, operationId: string, docsRequestAt: string): Promise<QaSnapshot> {
  await firstRequest(ctx, operationId, docsRequestAt);
  await delegateToSupplier(ctx, operationId);
  return emailOutWhenAllowed(ctx, operationId, (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "DOCS_REQUEST", status: [...SENT_STATUSES, "BOUNCED", "COMPLAINED"] }).length > 0);
}
