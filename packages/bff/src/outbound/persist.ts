// What the pipeline leaves behind (docs/tool-catalog.md, target `messaging`): the `Message OUT` in
// `Conversations` with exactly what was sent and the decision it went out under, and one `AuditLog`
// row per decision (`ALLOW` with the message id and every rule evaluated, `DEFER` with its timer,
// `DENY` with the rule or the check that stopped it). `PolicyAudit` finds the `ALLOW` of every message
// that went out by its top-level `messageId` and re-evaluates it with its `trigger`; an email to the
// supplier always records its contact (`contactId`), the key its re-evaluation reads.
import type { AuditDecision, RuleId } from "@legajo/shared";
import type { MessageRef } from "../connector/index";
import type { DecisionRefs, EvaluatedRule } from "../domain/audit";
import { type NewEntity, utcInstant } from "../domain/common";
import type { Message, MessageButton } from "../domain/conversations";
import type { PolicyDecision } from "../policy/types";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import { OUTBOUND_ACTION, type OutboundCall, type OutboundRequest } from "./types";

/** `SEND_WHATSAPP` / `SEND_EMAIL`: the action of every decision about a send. */
export function actionOf(request: Pick<OutboundRequest, "channel">): string {
  return request.channel === "WHATSAPP" ? OUTBOUND_ACTION.WHATSAPP : OUTBOUND_ACTION.EMAIL;
}

export interface MessageContent {
  readonly to: string;
  readonly from: string;
  readonly body: string;
  readonly subject?: string;
  readonly template?: { readonly name: NonNullable<Message["template"]>["name"]; readonly params: readonly string[] };
  readonly buttons?: readonly MessageButton[];
  readonly references?: readonly string[];
  readonly inReplyTo?: string;
  readonly simulated: boolean;
}

export interface NewOutbound {
  readonly messageId: string;
  readonly request: OutboundRequest;
  readonly context: SendContext;
  readonly content: MessageContent;
  readonly status: "QUEUED" | "DEFERRED";
  readonly decision: PolicyDecision;
  readonly deferredTimerKey?: string;
  readonly sentAtReal: string;
  /** `sentAtSim` when it is not the decided instant: a deferred send is dated at `nextAllowedAt`. */
  readonly atSim?: string;
}

function policyOf(decision: PolicyDecision): Message["policy"] {
  return { decision: decision.outcome, ruleIds: [...decision.ruleIds], ...(decision.nextAllowedAt === undefined ? {} : { nextAllowedAt: decision.nextAllowedAt }) };
}

export function outboundMessage(input: NewOutbound): NewEntity<typeof Message> {
  const { request, context, content } = input;
  const { operation } = context;
  // `PolicyAudit` re-evaluates a supplier email by its contact: one without it would be a false violation.
  if (context.counterpart === "SUPPLIER" && context.contact === undefined) throw new RangeError("an email to the supplier always records its contact");
  return {
    messageId: input.messageId,
    operationId: operation.operationId,
    firmId: operation.firmId,
    clockId: operation.clockId,
    direction: "OUT",
    channel: request.channel,
    kind: request.kind,
    counterpart: context.counterpart,
    ...(context.counterpart === "IMPORTER" ? { importerId: operation.importerId } : {}),
    ...(context.contact === undefined || context.counterpart !== "SUPPLIER" ? {} : { contactId: context.contact.contactId }),
    to: content.to,
    from: content.from,
    body: content.body,
    ...(content.subject === undefined ? {} : { subject: content.subject }),
    ...(content.template === undefined ? {} : { template: { name: content.template.name, params: [...content.template.params] } }),
    buttons: [...(content.buttons ?? [])],
    status: input.status,
    ...(content.inReplyTo === undefined ? {} : { inReplyTo: content.inReplyTo }),
    references: [...(content.references ?? [])],
    policy: policyOf(input.decision),
    author: request.author,
    ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
    simulated: content.simulated,
    sentAtSim: utcInstant(input.atSim ?? request.eventAtSim),
    sentAtReal: input.sentAtReal,
    refs: {
      ...(request.refs?.docTypes === undefined ? {} : { docTypes: [...request.refs.docTypes] }),
      ...(request.refs?.observationIds === undefined ? {} : { observationIds: [...request.refs.observationIds] }),
    },
    ...(input.deferredTimerKey === undefined ? {} : { deferredTimerKey: input.deferredTimerKey }),
  };
}

export function messageRef(message: Pick<Message, "operationId" | "messageId" | "sentAtSim">): MessageRef {
  return { operationId: message.operationId, messageId: message.messageId, sentAtSim: message.sentAtSim };
}

export interface DecisionRecord {
  readonly decision: AuditDecision;
  readonly action: string;
  readonly ruleIds?: readonly RuleId[];
  readonly policy?: PolicyDecision;
  readonly messageId?: string;
  readonly reason?: string;
  readonly refs?: DecisionRefs;
  readonly detail?: Readonly<Record<string, unknown>>;
}

function evaluatedOf(policy: PolicyDecision | undefined): EvaluatedRule[] {
  return (policy?.evaluated ?? []).map((entry) => ({ ruleId: entry.ruleId, result: entry.result, detail: entry.detail }));
}

/** One `AuditLog` row of the send, in the operation's world at the instant it was decided. */
export async function recordDecision(deps: Pick<OutboundDeps, "data" | "wallClock">, call: OutboundCall, request: OutboundRequest, context: SendContext, record: DecisionRecord): Promise<void> {
  const { operation } = context;
  const counterpartRef =
    context.counterpart === "IMPORTER" ? { importerId: operation.importerId } : context.counterpart === "SUPPLIER" && context.contact !== undefined ? { contactId: context.contact.contactId } : {};
  await deps.data.audit.record({
    firmId: operation.firmId,
    decision: record.decision,
    action: record.action,
    ruleIds: [...(record.ruleIds ?? record.policy?.ruleIds ?? [])],
    evaluated: evaluatedOf(record.policy),
    actor: call.actor,
    ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
    refs: { ...(call.refs ?? {}), operationId: operation.operationId, ...counterpartRef, ...(record.messageId === undefined ? {} : { messageId: record.messageId }), ...(record.refs ?? {}) },
    ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
    ...(record.reason === undefined ? {} : { reason: record.reason.slice(0, 500) }),
    clockId: operation.clockId,
    operationId: operation.operationId,
    atSim: request.eventAtSim,
    atReal: deps.wallClock().toISOString(),
    correlationId: call.correlationId.slice(0, 64),
    ...(record.detail === undefined ? {} : { detail: { ...record.detail } }),
  });
}
