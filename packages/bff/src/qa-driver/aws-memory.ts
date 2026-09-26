// AgentCore Memory as `memory.inspect` reads it (memory-inspect.ts): the text of a session's events
// and the records of a namespace, with `memoryRecordId` and `createdAt` as `MemoryRecordSummary`
// brings them (the content hash is computed by the caller; `updatedAt` is never used). Same Memory id
// and client settings as the purge (worlds/memory-admin.ts): the linked `Agent` resource.
import { BedrockAgentCoreClient, ListEventsCommand, ListMemoryRecordsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { z } from "zod";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import type { MemoryReader, StoredRecord } from "./memory-inspect";

const AgentLink = z.object({ memoryId: z.string().min(1) });
const TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 4 };
const PAGE_SIZE = 100;
/** A listing never pages past this many items: a QA actor has a handful. */
const MAX_ITEMS = 1_000;

export function agentCoreMemoryReader(options: { readonly memoryId?: () => string; readonly client?: BedrockAgentCoreClient } = {}): MemoryReader {
  const memoryId = options.memoryId ?? (() => readLinked("Agent", AgentLink).memoryId);
  let client = options.client;
  const agentCore = (): BedrockAgentCoreClient => (client ??= new BedrockAgentCoreClient({ region: "us-east-1", ...awsClientConfig(TIMEOUTS) }));

  return {
    async listEvents(actorId, sessionId) {
      const events: Array<{ eventId: string; text: string }> = [];
      let nextToken: string | undefined;
      do {
        const page = await agentCore().send(new ListEventsCommand({ memoryId: memoryId(), actorId, sessionId, includePayloads: true, maxResults: PAGE_SIZE, nextToken }));
        for (const event of page.events ?? []) {
          if (event.eventId === undefined) continue;
          const text = (event.payload ?? []).map((part) => part.conversational?.content?.text ?? "").filter((piece) => piece !== "").join("\n");
          events.push({ eventId: event.eventId, text });
        }
        nextToken = page.nextToken;
      } while (nextToken && events.length < MAX_ITEMS);
      return events;
    },

    async listRecords(namespace) {
      const records: StoredRecord[] = [];
      let nextToken: string | undefined;
      do {
        const page = await agentCore().send(new ListMemoryRecordsCommand({ memoryId: memoryId(), namespace, maxResults: PAGE_SIZE, nextToken }));
        for (const record of page.memoryRecordSummaries ?? []) {
          if (record.memoryRecordId === undefined) continue;
          records.push({ memoryRecordId: record.memoryRecordId, createdAt: (record.createdAt ?? new Date(0)).toISOString(), text: record.content?.text ?? "" });
        }
        nextToken = page.nextToken;
      } while (nextToken && records.length < MAX_ITEMS);
      return records;
    },
  };
}
