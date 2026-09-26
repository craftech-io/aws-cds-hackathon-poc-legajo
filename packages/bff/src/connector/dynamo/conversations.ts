// `Conversations`: messages by operation in simulated order (`MSG#<sentAtSim>#<messageId>`), their
// delivery events (idempotent by `eventId`), turn notes, and the firms' demo mailboxes. GSI1
// (`providerMessageId`) is set once a provider accepted the message; GSI2 (`counterpartKey` +
// `sentAtSim`) is derived from the counterpart, never supplied by the caller.
import { ConnectorError } from "@legajo/shared";
import { utcInstant } from "../../domain/common";
import { CONVERSATION_TTL_SECONDS, MailboxMessage, Message, MessageEvent, TurnNote } from "../../domain/conversations";
import type { NewEntity } from "../../domain/common";
import type { TableName } from "../../lib/resource";
import { expectedIndexAttributes } from "../item-shape";
import { EVT_PREFIX, MSG_PREFIX, NOTE_PREFIX, mailboxMessageKey, mailboxPartition, messageEventKey, messageKey, operationPartition, turnNoteKey } from "../keys";
import type { ConversationsPort } from "../ports-runtime";
import { checkPatch, createRow, parseEntities, parseEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Conversations";
const TTL = { ttlSeconds: CONVERSATION_TTL_SECONDS };

export function conversationsRepo(ctx: RepoContext): ConversationsPort {
  const { client } = ctx;

  async function findMessage(operationId: string, messageId: string): Promise<Message | undefined> {
    const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix: MSG_PREFIX }, filter: { equals: { messageId } }, limit: 1 });
    return rows[0] === undefined ? undefined : parseEntity(Message, "Message", rows[0], TABLE);
  }

  return {
    async appendMessage(message) {
      const fields = { ...message, sentAtSim: utcInstant(message.sentAtSim) };
      return createRow(ctx, TABLE, Message, "Message", messageKey(message.operationId, fields.sentAtSim, message.messageId), fields, { ...TTL, gsi: expectedIndexAttributes("Message", fields) });
    },

    getMessage: findMessage,

    async findMessageByProviderId(providerMessageId) {
      const rows = await client.query(TABLE, { index: "GSI1", hashValue: providerMessageId, filter: { equals: { entity: "Message" } }, limit: 2 });
      const messages = parseEntities(Message, "Message", rows, TABLE);
      if (messages.length > 1) throw new ConnectorError("CONFLICT", "two messages share a provider message id", TABLE);
      return messages[0];
    },

    async listMessages(operationId, options = {}) {
      const equals: Record<string, string> = {};
      if (options.direction !== undefined) equals.direction = options.direction;
      if (options.channel !== undefined) equals.channel = options.channel;
      const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix: MSG_PREFIX }, filter: { equals } });
      return parseEntities(Message, "Message", rows, TABLE);
    },

    async listCounterpartMessages(counterpartKey, options = {}) {
      const from = options.fromSim === undefined ? undefined : utcInstant(options.fromSim);
      const to = options.toSim === undefined ? undefined : utcInstant(options.toSim);
      const range = from !== undefined && to !== undefined ? { between: [from, to] as const } : from !== undefined ? { gte: from } : to !== undefined ? { lt: to } : undefined;
      const rows = await client.query(TABLE, {
        index: "GSI2",
        hashValue: counterpartKey,
        ...(range ? { range } : {}),
        filter: { equals: { entity: "Message", ...(options.direction === undefined ? {} : { direction: options.direction }) } },
      });
      const messages = parseEntities(Message, "Message", rows, TABLE);
      // The window is half-open: a message exactly at `toSim` belongs to the next one.
      return to === undefined ? messages : messages.filter((message) => message.sentAtSim < to);
    },

    async updateMessage(ref, patch, expectedVersion) {
      const fields = checkPatch(Message, patch, TABLE, `message ${ref.messageId}`);
      const key = messageKey(ref.operationId, ref.sentAtSim, ref.messageId);
      const condition = expectedVersion === undefined ? undefined : { ifVersion: expectedVersion };
      return updateRow(ctx, TABLE, Message, "Message", key, { set: fields }, condition ? { condition } : {});
    },

    async recordMessageEvent(event) {
      const key = messageEventKey(event.operationId, event.atReal, event.eventId);
      try {
        return { event: await createRow(ctx, TABLE, MessageEvent, "MessageEvent", key, event, TTL), created: true };
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "CONFLICT") throw error;
        const existing = await client.get(TABLE, key);
        if (existing === undefined) throw error;
        return { event: parseEntity(MessageEvent, "MessageEvent", existing, TABLE), created: false };
      }
    },

    async listMessageEvents(operationId) {
      const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix: EVT_PREFIX } });
      return parseEntities(MessageEvent, "MessageEvent", rows, TABLE);
    },

    async appendTurnNote(note: NewEntity<typeof TurnNote>) {
      return createRow(ctx, TABLE, TurnNote, "TurnNote", turnNoteKey(note.operationId, note.atSim, note.turnId), note, TTL);
    },

    async listTurnNotes(operationId) {
      const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix: NOTE_PREFIX } });
      return parseEntities(TurnNote, "TurnNote", rows, TABLE);
    },

    async putMailboxMessage(message) {
      const key = mailboxMessageKey(message.mailboxAddress, message.receivedAtReal, message.mailboxMessageId);
      return createRow(ctx, TABLE, MailboxMessage, "MailboxMessage", key, message, TTL);
    },

    async listMailbox(mailboxAddress, options = {}) {
      const rows = await client.query(TABLE, { hashValue: mailboxPartition(mailboxAddress), descending: true, ...(options.limit === undefined ? {} : { limit: options.limit }) });
      return parseEntities(MailboxMessage, "MailboxMessage", rows, TABLE);
    },
  };
}
