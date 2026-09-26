// Actions that drive a module the `QaDriver` does not own (ports.ts). The driver resolves every id the
// port needs from stored data (the nonce of the last button, the template of the operation, the
// registered address of a contact of the same world) and derives provider ids from the step's key,
// so the scenario never writes an id and a retried step never duplicates an effect.
import { QA_INJECTOR_PREFIX, SIM_MAIL_DOMAIN, ToolError } from "@legajo/shared";
import { qaEventId, qaMailId, qaMessageId, simulatedWamid } from "./contract";
import type { QaParsedInput } from "./contract-inputs";
import { lastNonce } from "./actions-state";
import type { ActionContext, QaPorts, WhatsAppInbound } from "./ports";

/** The world an operation named inside an input must belong to (the guard checks the top-level ids). */
async function operationInWorld(ctx: ActionContext, operationId: string) {
  const operation = await ctx.data.operations.findOperation(operationId);
  if (operation === undefined) throw new ToolError("NOT_FOUND", `no operation ${operationId}`);
  if (operation.clockId !== ctx.scope.clockId) throw new ToolError("FORBIDDEN", `${operationId} is not an operation of ${ctx.scope.clockId}`, "QA_FENCE");
  return operation;
}

/** `qainject-<runId>-<scenario>@sim…`, from the step's own key: the injector is never a party. */
export function injectorAddress(idempotencyKey: string): string {
  const [runId = "", scenario = ""] = idempotencyKey.split("/");
  return `${QA_INJECTOR_PREFIX}${runId}-${scenario}@${SIM_MAIL_DOMAIN}`;
}

async function choiceNonce(ctx: ActionContext, operationId: string, choose: string): Promise<string> {
  const messages = (await ctx.data.conversations.listMessages(operationId, { direction: "OUT" })).filter((message) => message.kind === "OPERATION_CHOICE").reverse();
  for (const message of messages) {
    for (const button of message.buttons) {
      if (button.action !== "CHOOSE_OPERATION" || button.nonce === undefined) continue;
      const nonce = await ctx.data.runtime.getNonce(button.nonce);
      if (nonce?.operationId === choose) return button.nonce;
    }
  }
  throw new ToolError("NOT_FOUND", `no OPERATION_CHOICE of ${operationId} offers ${choose}`);
}

async function whatsappMessage(input: QaParsedInput<"wa.inbound">, ctx: ActionContext): Promise<WhatsAppInbound> {
  const message = input.message;
  switch (message.type) {
    case "text":
    case "media":
      return message;
    case "button": {
      const holder = message.nonceFrom === undefined ? input.operationId : (await operationInWorld(ctx, message.nonceFrom)).operationId;
      return { type: "button", action: message.action, nonce: await lastNonce(ctx, holder, message.action) };
    }
    case "choice":
      await operationInWorld(ctx, message.choose);
      return { type: "choice", nonce: await choiceNonce(ctx, input.operationId, message.choose) };
    case "document": {
      const operation = await ctx.data.operations.getOperation(input.operationId);
      return { type: "document", docType: message.docType, version: message.version, templateOperation: operation.templateOperation };
    }
  }
}

async function injectedSender(input: QaParsedInput<"email.inject">, ctx: ActionContext): Promise<string> {
  if (input.from === "INJECTOR") return injectorAddress(ctx.idempotencyKey);
  const contact = await ctx.data.parties.findContact(input.from.supplierId, input.from.contactId);
  if (contact === undefined || contact.clockId !== ctx.scope.clockId) throw new ToolError("NOT_FOUND", `no contact ${input.from.contactId} in ${ctx.scope.clockId}`);
  return contact.email;
}

export function portActions(ports: QaPorts) {
  return {
    worldCreate: (input: QaParsedInput<"world.create">, ctx: ActionContext) => ports.worlds.create(input, ctx),
    worldDestroy: (input: QaParsedInput<"world.destroy">, ctx: ActionContext) => ports.worlds.destroy(input.clockId, ctx),
    advance: (input: QaParsedInput<"clock.advance">, ctx: ActionContext) => ports.clock.advance(input.clockId, { byMinutes: input.byMinutes }, ctx),
    advanceTo: (input: QaParsedInput<"clock.advanceTo">, ctx: ActionContext) => ports.clock.advance(input.clockId, { to: input.to }, ctx),
    advanceToNext: (input: QaParsedInput<"clock.advanceToNext">, ctx: ActionContext) => ports.clock.advance(input.clockId, { next: true }, ctx),
    fireMilestone: (input: QaParsedInput<"clock.fireMilestone">, ctx: ActionContext) => ports.clock.fireMilestone(input.operationId, input.milestone, ctx),
    unfreeze: (input: QaParsedInput<"clock.unfreeze">, ctx: ActionContext) => ports.clock.unfreeze(input.clockId, input.leadSec, ctx),
    freeze: (input: QaParsedInput<"clock.freeze">, ctx: ActionContext) => ports.clock.freeze(input.clockId, ctx),

    async waInbound(input: QaParsedInput<"wa.inbound">, ctx: ActionContext) {
      const wamid = await simulatedWamid(input.wamidOf ?? ctx.idempotencyKey);
      const sent = await ports.channels.whatsappInbound({ operationId: input.operationId, clockId: ctx.scope.clockId ?? "", from: input.from, wamid, message: await whatsappMessage(input, ctx) }, ctx);
      return { wamid, ...sent };
    },

    async emailInject(input: QaParsedInput<"email.inject">, ctx: ActionContext) {
      const target = "operationId" in input.to ? await operationInWorld(ctx, input.to.operationId) : undefined;
      const templateOperation = target?.templateOperation;
      if (input.attachments.length > 0 && templateOperation === undefined) throw new ToolError("INVALID", "attachments go to an operation of this world");
      const mailId = await qaMailId(ctx.idempotencyKey);
      const sent = await ports.channels.injectEmail(
        {
          clockId: input.clockId,
          from: await injectedSender(input, ctx),
          to: target?.threadAddress ?? ("address" in input.to ? input.to.address : ""),
          subject: input.subject,
          body: input.body,
          autoReply: input.autoReply,
          attachments: input.attachments.map((attachment) => ({ ...attachment, templateOperation: templateOperation ?? "" })),
          mailId,
          messageIdHeader: await qaMessageId(ctx.idempotencyKey, SIM_MAIL_DOMAIN),
          ...(target === undefined ? {} : { operationId: target.operationId }),
        },
        ctx,
      );
      return { mailId, sesMessageId: sent.sesMessageId };
    },

    async redeliver(input: QaParsedInput<"email.redeliver">, ctx: ActionContext) {
      const message = await ctx.data.conversations.getMessage(input.operationId, input.messageId);
      if (message === undefined || message.direction !== "IN" || message.channel !== "EMAIL") throw new ToolError("NOT_FOUND", `no inbound email ${input.messageId} in ${input.operationId}`);
      return ports.channels.redeliverEmail({ operationId: input.operationId, clockId: ctx.scope.clockId ?? "", messageId: input.messageId }, ctx);
    },

    async sendNow(input: QaParsedInput<"supplier.sendNow">, ctx: ActionContext) {
      const mailId = await qaMailId(ctx.idempotencyKey);
      await ports.simMail.sendNow({ operationId: input.operationId, clockId: ctx.scope.clockId ?? "", docTypes: input.docTypes, version: input.version, ...(input.body === undefined ? {} : { body: input.body }), mailId }, ctx);
      return { mailId };
    },

    async poison(input: QaParsedInput<"event.poison">, ctx: ActionContext) {
      const eventId = await qaEventId(ctx.idempotencyKey);
      await ports.worker.poison({ operationId: input.operationId, clockId: ctx.scope.clockId ?? "", eventId }, ctx);
      return { eventId };
    },
    forceFailure: async (input: QaParsedInput<"turn.forceFailure">, ctx: ActionContext) => {
      await ports.worker.forceNextTurnFailure({ operationId: input.operationId, clockId: ctx.scope.clockId ?? "" }, ctx);
      return { armed: true };
    },
    fireStale: async (input: QaParsedInput<"schedule.fireStale">, ctx: ActionContext) => {
      await ports.worker.fireStale({ operationId: input.operationId, clockId: ctx.scope.clockId ?? "", timerKey: input.timerKey, version: input.version }, ctx);
      return { dispatched: true };
    },
    fenceProbe: (input: QaParsedInput<"fence.probe">, ctx: ActionContext) => ports.fence.probe(input, ctx),
    batch: (input: QaParsedInput<"batch.run">, ctx: ActionContext) => ports.batch.run(input, ctx),
  };
}
