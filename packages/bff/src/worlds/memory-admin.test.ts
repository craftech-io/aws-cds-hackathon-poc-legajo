import { ResourceNotFoundException, type BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { describe, expect, it } from "vitest";
import { agentCoreMemoryAdmin } from "./memory-admin";

const missing = () => new ResourceNotFoundException({ message: "Actor imp-litoral-e1 not found", $metadata: {} });

describe("agentCoreMemoryAdmin", () => {
  it("lists nothing for an actor or session Memory never saw, so a reload's purge goes on", async () => {
    const client = { send: async () => Promise.reject(missing()) } as unknown as BedrockAgentCoreClient;
    const admin = agentCoreMemoryAdmin({ memoryId: () => "mem-1", client });
    await expect(admin.listSessionIds("imp-litoral-e1")).resolves.toEqual([]);
    await expect(admin.listEventIds("imp-litoral-e1", "s1")).resolves.toEqual([]);
  });

  it("still fails on any other error", async () => {
    const client = { send: async () => Promise.reject(new Error("throttled")) } as unknown as BedrockAgentCoreClient;
    await expect(agentCoreMemoryAdmin({ memoryId: () => "mem-1", client }).listSessionIds("a")).rejects.toThrow("throttled");
  });
});
