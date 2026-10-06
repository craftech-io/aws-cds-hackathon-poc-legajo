// A model that sends the same WhatsApp twice in one turn (ADR-0019): the second request is answered
// from the first message, as a redelivered event is (`replayOf`), and nothing goes out again. Same
// turn, same channel, same text or the same template with the same parameters.
import type { Message } from "../domain/conversations";
import type { OutboundRequest } from "./types";

export function repeatedInTurn(request: OutboundRequest, history: readonly Message[]): Message | undefined {
  if (request.turnId === undefined || request.channel !== "WHATSAPP") return undefined;
  const template = request.template === undefined ? undefined : JSON.stringify([request.template.name, request.template.params]);
  return history.find(
    (message) =>
      message.direction === "OUT" &&
      message.channel === "WHATSAPP" &&
      message.turnId === request.turnId &&
      (template === undefined ? request.text !== undefined && message.template === undefined && message.body === request.text : message.template !== undefined && JSON.stringify([message.template.name, message.template.params]) === template),
  );
}
