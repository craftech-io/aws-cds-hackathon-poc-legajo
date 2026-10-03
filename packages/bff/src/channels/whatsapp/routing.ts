// Which operation an inbound message belongs to (FL-019, docs/architecture.md §13 "Varias operaciones
// abiertas"). A button carries its operation in its nonce. A free text or a PDF of an importer with
// one open operation goes to it; with more than one, the operation is never assumed: the message stays
// in the anchor operation (the soonest ETA of a dossier still in work, then the lowest number: an
// approved dossier only answers the importer, `CP-APPROVED-SCOPE`) and the importer gets a list,
// deterministic and without the model, with a nonce per operation (`OPERATION_CHOICE`). The choice
// writes a copy of the message in the chosen operation and sends it there, once: the turn keeps the
// `wamid` of the original, so a second choice is the same event.
import { ARGENTINA_TIME_ZONE, zonedParts } from "../../services/business-hours";
import { BUTTON_LABELS, operationRowTitle } from "../../copy/buttons";
import { importerEsAR } from "../../copy/es-AR";
import type { Connector } from "../../connector/connector";
import type { Message } from "../../domain/conversations";
import type { Operation } from "../../domain/operations";
import type { Importer } from "../../domain/parties";
import type { Nonce } from "../../domain/runtime";
import type { ChannelEventSink } from "../adapter";
import { type AcceptedMedia, routeMedia } from "./media";
import { type ChoiceNoncePayload, MAX_CHOICE_ROWS, issueNonces } from "./nonces";
import type { SystemReplies, WhatsAppKeys } from "./ports";
import { appendInbound, derivedMessageId, importerTurn } from "./records";

const approvedLast = (operation: Pick<Operation, "dossierStatus">): number => (operation.dossierStatus === "APPROVED" ? 1 : 0);

/** Operations of the importer in its world that are not closed (a released dispatch closes one), anchor first. */
export async function openOperationsOf(data: Pick<Connector, "operations">, importer: Pick<Importer, "firmId" | "importerId" | "clockId">): Promise<Operation[]> {
  const operations = await data.operations.listOperations(importer.firmId, { importerId: importer.importerId, clockId: importer.clockId });
  return operations
    .filter((operation) => operation.importerId === importer.importerId && operation.clockId === importer.clockId && operation.dispatch.status !== "LIBERADO")
    .sort((a, b) => approvedLast(a) - approvedLast(b) || Date.parse(a.eta) - Date.parse(b.eta) || a.operationNumber.localeCompare(b.operationNumber));
}

/** "22/10": the ETA of a row, in Argentina's wall clock. */
export function etaRowText(eta: string): string {
  const [, month = "", day = ""] = zonedParts(new Date(eta), ARGENTINA_TIME_ZONE).date.split("-");
  return `${day}/${month}`;
}

export interface ChoiceOffer {
  readonly importer: Importer;
  readonly phoneHash: string;
  readonly wamid: string;
  /** Open operations, anchor first; the unrouted message is already written in the anchor. */
  readonly operations: readonly Operation[];
  readonly source: { readonly messageId: string; readonly hasText: boolean; readonly media: readonly AcceptedMedia[] };
  readonly atSim: string;
  readonly now: Date;
}

export interface ChoiceDeps {
  readonly data: Connector;
  readonly keys: Pick<WhatsAppKeys, "nonce">;
  readonly replies: SystemReplies;
  readonly events: ChannelEventSink;
}

/** Sends the `OPERATION_CHOICE` list: one row per open operation, each a nonce for that operation. */
export async function offerOperationChoice(deps: ChoiceDeps, offer: ChoiceOffer): Promise<void> {
  const anchor = offer.operations[0];
  if (anchor === undefined) throw new RangeError("an operation choice needs open operations");
  // An interactive list has at most ten rows: past ten open operations the latest ETAs are left out.
  const offered = offer.operations.slice(0, MAX_CHOICE_ROWS);
  const messageId = derivedMessageId(offer.wamid, "OPERATION_CHOICE");
  const payload: ChoiceNoncePayload = { sourceOperationId: anchor.operationId, sourceMessageId: offer.source.messageId, sourceWamid: offer.wamid, hasText: offer.source.hasText, media: [...offer.source.media] };
  const nonces = await issueNonces(deps.data.runtime, {
    nonceKey: deps.keys.nonce,
    messageId,
    operationId: anchor.operationId,
    importerId: offer.importer.importerId,
    phoneHash: offer.phoneHash,
    clockId: offer.importer.clockId,
    buttons: offered.map((operation) => ({ action: "CHOOSE_OPERATION", operationId: operation.operationId, payload })),
    now: offer.now,
  });
  const rows = await Promise.all(
    offered.map(async (operation, index) => {
      const supplier = await deps.data.parties.findSupplier(operation.supplierId);
      return {
        nonce: nonces[index] ?? "",
        title: operationRowTitle(operation.operationNumber),
        description: importerEsAR.operationChoice.rowDescription({ supplierName: supplier?.name ?? operation.vessel, etaText: etaRowText(operation.eta) }),
        operationId: operation.operationId,
      };
    }),
  );
  await deps.replies.reply({
    kind: "OPERATION_CHOICE",
    textKey: "operationChoice",
    body: importerEsAR.operationChoice.body,
    operationId: anchor.operationId,
    importerId: offer.importer.importerId,
    firmId: offer.importer.firmId,
    clockId: offer.importer.clockId,
    messageId,
    inReplyTo: { messageId: offer.source.messageId, wamid: offer.wamid },
    atSim: offer.atSim,
    list: { buttonTitle: BUTTON_LABELS.CHOOSE_OPERATION.interactive, rows },
    buttons: rows.map((row) => ({ action: "CHOOSE_OPERATION", title: row.title, nonce: row.nonce })),
  });
}

export interface ChoiceApplied {
  readonly operationId: string;
  /** The message of the chosen operation the turn and the intake refer to. */
  readonly messageId: string;
  readonly turn: boolean;
  readonly media: number;
}

/**
 * The importer chose: the unrouted message goes to the chosen operation (a copy there, unless it is the
 * anchor), with its turn keyed by the original `wamid` and its PDFs routed to that operation's intake.
 */
export async function applyOperationChoice(
  deps: ChoiceDeps,
  input: { readonly nonce: Nonce; readonly payload: ChoiceNoncePayload; readonly importer: Importer; readonly atSim: string; readonly atReal: string },
): Promise<ChoiceApplied> {
  const { nonce, payload, importer } = input;
  const chosen = nonce.operationId;
  const source = await deps.data.conversations.getMessage(payload.sourceOperationId, payload.sourceMessageId);
  if (source === undefined) throw new RangeError(`the message of the choice is gone from ${payload.sourceOperationId}`);
  const target: Message =
    chosen === payload.sourceOperationId
      ? source
      : await appendInbound(deps.data, {
          wamid: payload.sourceWamid,
          importer,
          operationId: chosen,
          to: source.to,
          body: { text: source.body, truncated: source.truncated },
          simulated: source.simulated,
          sentAtSim: input.atSim,
          sentAtReal: input.atReal,
          attachments: source.attachments,
          routedFrom: { operationId: source.operationId, messageId: source.messageId },
        });
  if (payload.hasText) {
    await deps.events.enqueue(importerTurn({ importer, operationId: chosen, messageId: target.messageId, wamid: payload.sourceWamid, atSim: input.atSim }));
  }
  for (const media of payload.media) {
    await routeMedia(deps.data, deps.events, { ...media, operationId: chosen, clockId: importer.clockId, firmId: importer.firmId, messageId: target.messageId, eventAtSim: input.atSim }, input.atReal);
  }
  return { operationId: chosen, messageId: target.messageId, turn: payload.hasText, media: payload.media.length };
}
