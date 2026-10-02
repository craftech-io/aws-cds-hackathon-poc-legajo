// `send_whatsapp` and `send_email` (docs/tool-catalog.md, target `messaging`): the wrapper already
// checked the session, the caller, the strict input, the trigger (`REMINDER` only in milestone or
// follow-up turns) and that every id belongs to the operation; here the call becomes a request of the
// outbound pipeline (outbound/), which resolves the recipient from the registry (`LAM-RECIPIENT`),
// decides, checks, fences, sends or defers, and leaves the message and its decision behind. The answer
// is the pipeline's: SENT, DEFERRED (with the instant already formatted for the deciding side) or the
// refusal of the rule or the check that stopped it.
import { type PolicyResult, ok } from "@legajo/shared";
import type { OutboundDeps } from "../../outbound/deps";
import { sendOutbound } from "../../outbound/pipeline";
import { instantText } from "../../outbound/texts";
import type { MessageRefsInput, OutboundCall, OutboundRequest, OutboundResult, TextSource } from "../../outbound/types";
import type { PolicyDecision } from "../../policy/types";
import { type ToolContext, type ToolImplementation, type ToolResponse, actorOf } from "../common/context";
import type { ToolInput } from "../common/define";
import type { MESSAGING_TOOLS } from "./schema";

export interface MessagingPorts {
  /** The pipeline's ports, built on first use (outbound/stage.ts in a Lambda, fakes in tests). */
  readonly outbound: () => OutboundDeps;
}

type SendWhatsAppInput = ToolInput<(typeof MESSAGING_TOOLS)["send_whatsapp"]>;
type SendEmailInput = ToolInput<(typeof MESSAGING_TOOLS)["send_email"]>;

interface Origin {
  readonly operationId: string;
  readonly author: OutboundRequest["author"];
  readonly textSource: TextSource;
  readonly eventAtSim: string;
  readonly trigger?: OutboundRequest["trigger"];
  readonly turnId?: string;
}

/** Who writes: the model in a turn, a person of the firm from the console, the code for the worker. */
export function originOf(ctx: Pick<ToolContext<unknown>, "scope" | "principal">): Origin {
  const { principal, scope } = ctx;
  const base = { operationId: scope.operationId, eventAtSim: scope.nowSim, author: actorOf(principal) };
  if (principal.kind === "SESSION") return { ...base, textSource: "MODEL", trigger: principal.trigger, turnId: principal.turnId };
  return { ...base, textSource: base.author.startsWith("BROKER:") ? "PERSON" : "CODE" };
}

export function outboundCall(ctx: Pick<ToolContext<unknown>, "principal" | "correlationId" | "log">): OutboundCall {
  const { principal } = ctx;
  const refs =
    principal.kind === "SESSION"
      ? { turnId: principal.turnId, ...(principal.eventId === undefined ? {} : { eventId: principal.eventId }) }
      : { ...(principal.caller.eventId === undefined ? {} : { eventId: principal.caller.eventId }), ...(principal.caller.brokerId === undefined ? {} : { brokerId: principal.caller.brokerId }) };
  return { actor: actorOf(principal), correlationId: ctx.correlationId, log: ctx.log, refs };
}

function refsOf(refs: SendWhatsAppInput["refs"]): MessageRefsInput | undefined {
  if (refs === undefined) return undefined;
  return { ...(refs.docTypes === undefined ? {} : { docTypes: refs.docTypes }), ...(refs.observationIds === undefined ? {} : { observationIds: refs.observationIds }) };
}

export function policyResultOf(decision: PolicyDecision): PolicyResult {
  return {
    allowed: decision.allowed,
    ruleIds: [...decision.ruleIds],
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.nextAllowedAt === undefined ? {} : { nextAllowedAt: decision.nextAllowedAt }),
  };
}

/** The tool's answer for a pipeline result (docs/tool-catalog.md, outputs of the send tools). */
export function answerOf(result: OutboundResult): ToolResponse {
  if (result.status === "REFUSED") return result.failure;
  const common = {
    messageId: result.messageId,
    status: result.status,
    ...(result.decision === undefined ? {} : { policyResult: policyResultOf(result.decision) }),
    ...(result.guardrail === undefined ? {} : { guardrail: { ...result.guardrail } }),
    ...(result.window === undefined ? {} : { windowState: result.window.state === "OPEN" ? "OPEN" : "TEMPLATE_REQUIRED" }),
  };
  if (result.status === "DEFERRED") {
    const deferredUntilText = result.zone === undefined ? result.nextAllowedAt : instantText(result.nextAllowedAt, result.zone);
    return ok({ ...common, deferredUntilText });
  }
  return ok({ ...common, ...(result.templateUsed === undefined ? {} : { templateUsed: result.templateUsed }) });
}

export function sendWhatsApp(ports: MessagingPorts): ToolImplementation<SendWhatsAppInput> {
  return async (ctx) => {
    const { input } = ctx;
    const refs = refsOf(input.refs);
    const request: OutboundRequest = {
      ...originOf(ctx),
      channel: "WHATSAPP",
      kind: input.kind,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.template === undefined ? {} : { template: { name: input.template.name, params: [...(input.template.params ?? [])] } }),
      ...(input.buttons === undefined ? {} : { buttons: input.buttons.map((button) => ({ action: button.action })) }),
      ...(refs === undefined ? {} : { refs }),
    };
    return answerOf(await sendOutbound(ports.outbound(), request, outboundCall(ctx)));
  };
}

export function sendEmail(ports: MessagingPorts): ToolImplementation<SendEmailInput> {
  return async (ctx) => {
    const { input } = ctx;
    const refs = refsOf(input.refs);
    const request: OutboundRequest = {
      ...originOf(ctx),
      channel: "EMAIL",
      counterpart: "SUPPLIER",
      kind: input.kind,
      text: input.text,
      ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
      ...(refs === undefined ? {} : { refs }),
    };
    return answerOf(await sendOutbound(ports.outbound(), request, outboundCall(ctx)));
  };
}
