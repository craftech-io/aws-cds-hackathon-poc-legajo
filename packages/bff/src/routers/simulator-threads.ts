// `simulator.threads` (FL-083): the WhatsApp thread of every importer of one world, as the importer's
// phone shows it. Exactly what was sent (a template already rendered with its parameters), the buttons
// with their action, title, the upload link of a URL button and the fixed English gloss of
// copy/en-gloss.ts; never a nonce, a `wamid` or a key. Outbound messages not read yet count as unread,
// and "El agente está escribiendo…" shows while an event of one of the importer's operations is in flight.
import { maskPhone, operationNumberOf } from "@legajo/shared";
import type { Connector } from "../connector/index";
import { importerCounterpartKey } from "../connector/keys";
import { BUTTON_GLOSS, glossTemplate } from "../copy/en-gloss";
import type { Message } from "../domain/conversations";
import type { Operation } from "../domain/operations";
import type { Importer } from "../domain/parties";

/** Our messages the importer has not read yet. */
const UNREAD: ReadonlySet<Message["status"]> = new Set(["SENT", "DELIVERED"]);

function numberOf(operationId: string): string | undefined {
  try {
    return operationNumberOf(operationId);
  } catch {
    return undefined;
  }
}

export function simMessageView(message: Message) {
  const operationNumber = numberOf(message.operationId);
  return {
    messageId: message.messageId,
    direction: message.direction,
    ...(operationNumber === undefined ? {} : { operationNumber }),
    ...(message.kind === undefined ? {} : { kind: message.kind }),
    body: message.body,
    ...(message.template === undefined ? {} : { template: message.template.name, glossEn: glossTemplate(message.template.name, message.template.params) }),
    buttons: message.buttons.map((button) => ({ action: button.action, title: button.title, glossEn: BUTTON_GLOSS[button.action], ...(button.url === undefined ? {} : { url: button.url }) })),
    attachments: message.attachments.map((attachment) => ({ index: attachment.index, status: attachment.status, sizeBytes: attachment.sizeBytes })),
    status: message.status,
    sentAtSim: message.sentAtSim,
  };
}

/** Operations of the world with an event in flight (`WORLDSTATE#<clockId>.inFlight` is `<operationId>#<eventId>`). */
function busyOperations(inFlight: readonly string[]): Set<string> {
  return new Set(inFlight.map((entry) => entry.slice(0, Math.max(0, entry.indexOf("#")))).filter((operationId) => operationId !== ""));
}

async function threadOf(data: Connector, importer: Importer, operations: readonly Operation[], busy: ReadonlySet<string>) {
  const messages = (await data.conversations.listCounterpartMessages(importerCounterpartKey(importer.importerId)))
    .filter((message) => message.channel === "WHATSAPP" && message.clockId === importer.clockId)
    .sort((a, b) => Date.parse(a.sentAtSim) - Date.parse(b.sentAtSim) || a.messageId.localeCompare(b.messageId));
  const own = operations.filter((operation) => operation.importerId === importer.importerId);
  return {
    importerId: importer.importerId,
    importerName: importer.name,
    contactName: importer.contactName,
    phoneMasked: maskPhone(importer.phoneE164),
    operations: own.map((operation) => ({ operationId: operation.operationId, operationNumber: operation.operationNumber })),
    unread: messages.filter((message) => message.direction === "OUT" && UNREAD.has(message.status)).length,
    typing: own.some((operation) => busy.has(operation.operationId)),
    messages: messages.map(simMessageView),
  };
}

export async function simulatorThreads(data: Connector, firmId: string, clockId: string) {
  const [importers, operations, world] = await Promise.all([data.parties.listImporters(firmId, { clockId }), data.operations.listOperations(firmId, { clockId }), data.world.getWorldState(clockId)]);
  const busy = busyOperations(world?.inFlight ?? []);
  return Promise.all(importers.map((importer) => threadOf(data, importer, operations, busy)));
}
