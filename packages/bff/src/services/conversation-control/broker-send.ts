// `broker_send` (docs/tool-catalog.md, FL-068): the firm writes to the importer from the console. The
// console never sends: the handler enqueues `OUTBOUND_SEND` (`BROKER_MESSAGE`, `author BROKER:<id>`) and
// the worker runs it through the outbound pipeline, so the 24-hour window, the opt-in, the hours and
// the fence decide (`ALLOW`/`DENY` in the audit) exactly as for the agent.
//
//   - the firm took the conversation first (`control BROKER`, FL-067): otherwise `CONFLICT`;
//   - free text inside the window, or one of the firm's templates outside it, its parameters filled
//     here from the operation (never typed by a person): `legajo_escalado` (number, firm) and
//     `legajo_recordatorio` (number, the documents still missing, the deadline ETA − 3 days 10:00 in
//     Argentina); any other template is the system's, `INVALID`;
//   - the human action is counted.
import { ConversationSendInput, DocType, ToolError, type WhatsAppTemplateName } from "@legajo/shared";
import { missingDocumentsEsAR } from "../../copy/es-AR";
import type { Operation } from "../../domain/operations";
import { milestoneDueTimes } from "../../milestones/schedule";
import { ARGENTINA_TIME_ZONE, toZonedIso } from "../business-hours";
import { type DirectContext, createDirectHandler } from "../operations-admin/handler-kit";
import { countHumanAction } from "../operations-admin/human-actions";
import type { ServiceDeps } from "../operations-admin/ports";
import { fencedOperation } from "../operations-admin/world-scope";
import { brokerMessageSend, newConsoleEventId } from "./outbound-send";

/** The templates the firm may send itself (the rest belong to milestones, the agent or the system). */
export const BROKER_TEMPLATES = ["legajo_escalado", "legajo_recordatorio"] as const satisfies readonly WhatsAppTemplateName[];
type BrokerTemplate = (typeof BROKER_TEMPLATES)[number];

function isBrokerTemplate(name: WhatsAppTemplateName): name is BrokerTemplate {
  return (BROKER_TEMPLATES as readonly string[]).includes(name);
}

/** `19/10 10:00`: a simulated instant as the importer reads it, in Argentina's time. */
export function shortDateTimeEsAR(instant: string): string {
  const zoned = toZonedIso(new Date(Date.parse(instant)), ARGENTINA_TIME_ZONE);
  return `${zoned.slice(8, 10)}/${zoned.slice(5, 7)} ${zoned.slice(11, 16)}`;
}

/** The importer's deadline: the last reminder's instant (ETA − 3 days, 10:00 in Argentina). */
export function importerDeadlineText(eta: string): string {
  return shortDateTimeEsAR(milestoneDueTimes(eta).FOLLOWUP_FINAL);
}

async function templateParams(ctx: DirectContext<unknown>, operation: Operation, template: BrokerTemplate): Promise<string[]> {
  if (template === "legajo_escalado") return [operation.operationNumber, (await ctx.connector.firms.getFirm(operation.firmId)).name];
  const documents = await ctx.connector.documents.listDocuments(operation.operationId);
  const pending = new Set(documents.filter((document) => document.status !== "VALID").map((document) => document.docType));
  const missing = DocType.options.filter((docType) => pending.has(docType));
  if (missing.length === 0) throw new ToolError("INVALID", "nothing is missing: there is nothing to remind", "NOTHING_MISSING");
  return [operation.operationNumber, missingDocumentsEsAR(missing), importerDeadlineText(operation.eta)];
}

export function brokerSendHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "broker_send",
      input: ConversationSendInput,
      callers: ["CONSOLE", "QA"],
      async run(ctx) {
        const { input } = ctx;
        const operation = await fencedOperation(ctx, input.operationId);
        if (operation.control !== "BROKER") throw new ToolError("CONFLICT", "take the conversation before writing to the importer", "CONTROL_NOT_TAKEN");
        let content: Parameters<typeof brokerMessageSend>[0]["content"];
        if ("text" in input) {
          content = { text: input.text };
        } else {
          if (!isBrokerTemplate(input.template)) throw new ToolError("INVALID", "that template is not one the firm sends", "TEMPLATE_NOT_FOR_BROKER");
          content = { template: input.template, params: await templateParams(ctx, operation, input.template) };
        }
        const { atSim } = await ctx.world(operation.clockId);
        const eventId = newConsoleEventId(ctx.now().getTime());
        await deps.events.enqueue(brokerMessageSend({ operationId: operation.operationId, clockId: operation.clockId, firmId: operation.firmId, eventAtSim: atSim, correlationId: ctx.correlationId, eventId, author: ctx.actor, content }));
        await countHumanAction(ctx, operation, "SEND");
        return { operationId: operation.operationId, eventId, queued: true };
      },
    },
    deps,
  );
}
