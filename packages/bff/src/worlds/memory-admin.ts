// AgentCore Memory as the purge sees it (worlds/memory-purge.ts), over the data plane of
// `@aws-sdk/client-bedrock-agentcore` with the capability `MEMORY_ADMIN` (docs/architecture.md §14:
// ListSessions, ListEvents, DeleteEvent, ListMemoryRecords, DeleteMemoryRecord; each verified in the
// installed `.d.ts`). The Memory id comes from the linked `Agent` resource (`Resource`, never
// `process.env`). Listings page to the end; every call has a deadline and the SDK's retry budget, and
// a deletion of something already gone is not an error.
import {
  BedrockAgentCoreClient,
  DeleteEventCommand,
  DeleteMemoryRecordCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  ListSessionsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-bedrock-agentcore";
import { z } from "zod";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { STAGE_REGION } from "../public-web/presign";
import type { MemoryAdmin } from "./memory-purge";

const AgentLink = z.object({ memoryId: z.string().min(1) });

// Control of a few records per actor: short calls, a few attempts.
const MEMORY_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 4 };

/** Largest page the listings ask for. */
const PAGE_SIZE = 100;

async function ignoreMissing(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
}

/** A listing of an actor or session Memory never saw: AgentCore answers "not found", which is an empty list. */
async function emptyWhenMissing(list: () => Promise<string[]>): Promise<string[]> {
  try {
    return await list();
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return [];
    throw error;
  }
}

export function agentCoreMemoryAdmin(options: { readonly memoryId?: () => string; readonly client?: BedrockAgentCoreClient } = {}): MemoryAdmin {
  const memoryId = options.memoryId ?? (() => readLinked("Agent", AgentLink).memoryId);
  let client = options.client;
  const agentCore = (): BedrockAgentCoreClient => (client ??= new BedrockAgentCoreClient({ region: STAGE_REGION, ...awsClientConfig(MEMORY_TIMEOUTS) }));

  return {
    listSessionIds: (actorId) =>
      emptyWhenMissing(async () => {
        const ids: string[] = [];
        let nextToken: string | undefined;
        do {
          const page = await agentCore().send(new ListSessionsCommand({ memoryId: memoryId(), actorId, maxResults: PAGE_SIZE, nextToken }));
          ids.push(...(page.sessionSummaries ?? []).flatMap((session) => (session.sessionId ? [session.sessionId] : [])));
          nextToken = page.nextToken;
        } while (nextToken);
        return ids;
      }),

    listEventIds: (actorId, sessionId) =>
      emptyWhenMissing(async () => {
        const ids: string[] = [];
        let nextToken: string | undefined;
        do {
          const page = await agentCore().send(new ListEventsCommand({ memoryId: memoryId(), actorId, sessionId, includePayloads: false, maxResults: PAGE_SIZE, nextToken }));
          ids.push(...(page.events ?? []).flatMap((event) => (event.eventId ? [event.eventId] : [])));
          nextToken = page.nextToken;
        } while (nextToken);
        return ids;
      }),

    async deleteEvent(actorId, sessionId, eventId) {
      await ignoreMissing(agentCore().send(new DeleteEventCommand({ memoryId: memoryId(), actorId, sessionId, eventId })));
    },

    async listRecordIds(namespacePrefix) {
      const ids: string[] = [];
      let nextToken: string | undefined;
      do {
        const page = await agentCore().send(new ListMemoryRecordsCommand({ memoryId: memoryId(), namespace: namespacePrefix, maxResults: PAGE_SIZE, nextToken }));
        ids.push(...(page.memoryRecordSummaries ?? []).flatMap((record) => (record.memoryRecordId ? [record.memoryRecordId] : [])));
        nextToken = page.nextToken;
      } while (nextToken);
      return ids;
    },

    async deleteRecord(recordId) {
      await ignoreMissing(agentCore().send(new DeleteMemoryRecordCommand({ memoryId: memoryId(), memoryRecordId: recordId })));
    },
  };
}
