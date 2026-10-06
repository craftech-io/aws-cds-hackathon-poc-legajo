import { createHash } from "node:crypto";
import { BedrockAgentCoreClient, ListEventsCommand, ListMemoryRecordsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { ApplyGuardrailCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { CloudWatchClient, DescribeAlarmHistoryCommand } from "@aws-sdk/client-cloudwatch";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { agentCoreMemoryReader } from "./aws-memory";
import { platformClient, readerFaultWriter } from "./aws-mocks";
import { cloudWatchAlarmHistory, g1Probe, sqsDlq } from "./aws-queue";
import { browserUpload } from "./upload";

const QUEUE = "https://sqs.us-east-1.amazonaws.com/776805327629/aws-cds-hackathon-poc-legajo-dlq.fifo";
const PLATFORM = "https://abc123.lambda-url.us-east-1.on.aws/";

const dlqMessage = (eventId: string, clockId: string, handle: string) => ({ Body: JSON.stringify({ eventId, clockId, type: "POISON" }), ReceiptHandle: handle, Attributes: { MessageDeduplicationId: eventId } });

describe("dlq.find and dlq.delete: only the scenario's own event", () => {
  const OWN = `qa-${"a".repeat(40)}`;
  const OTHER_QA = `qa-${"b".repeat(40)}`;

  it("finds the event by its deduplication id; other QA events by id, other firms' only by count", async () => {
    const sqs = mockClient(SQSClient);
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage(OWN, "qa-812-1-sc19", "h1"), dlqMessage("evt-real", "GLOBAL#firm-delta", "h2"), dlqMessage(OTHER_QA, "qa-812-1-sc18", "h3")] });
    const dlq = sqsDlq({ queueUrl: () => QUEUE, client: new SQSClient({}) });
    expect(await dlq.find({ clockId: "qa-812-1-sc19", eventId: OWN })).toEqual({ found: true, others: [OTHER_QA], foreign: 1 });
    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(sqs.commandCalls(ReceiveMessageCommand)[0]?.args[0].input).toMatchObject({ VisibilityTimeout: 2, QueueUrl: QUEUE });
  });

  it("deletes only its own message, and refuses an event of another world", async () => {
    const sqs = mockClient(SQSClient);
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage("evt-real", "GLOBAL#firm-delta", "h2"), dlqMessage(OWN, "qa-812-1-sc19", "h1")] });
    const dlq = sqsDlq({ queueUrl: () => QUEUE, client: new SQSClient({}) });
    expect(await dlq.remove({ clockId: "qa-812-1-sc19", eventId: OWN })).toEqual({ deleted: true, others: [], foreign: 1 });
    expect(sqs.commandCalls(DeleteMessageCommand).map((call) => call.args[0].input.ReceiptHandle)).toEqual(["h1"]);
    await expect(dlq.remove({ clockId: "qa-812-1-sc20", eventId: OWN })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed on a body without a world or unreadable, and on an id no scenario injected (SEC-2)", async () => {
    const sqs = mockClient(SQSClient);
    const noWorld = { Body: JSON.stringify({ eventId: OWN, type: "EMAIL_IN" }), ReceiptHandle: "h4", Attributes: { MessageDeduplicationId: OWN } };
    const unreadable = { Body: "{truncated", ReceiptHandle: "h5", Attributes: { MessageDeduplicationId: OTHER_QA } };
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [noWorld, unreadable] });
    const dlq = sqsDlq({ queueUrl: () => QUEUE, client: new SQSClient({}) });
    await expect(dlq.remove({ clockId: "qa-812-1-sc19", eventId: OWN })).rejects.toMatchObject({ code: "FORBIDDEN", reason: "QA_FENCE" });
    await expect(dlq.remove({ clockId: "qa-812-1-sc19", eventId: OTHER_QA })).rejects.toMatchObject({ code: "FORBIDDEN", reason: "QA_FENCE" });
    await expect(dlq.remove({ clockId: "qa-812-1-sc19", eventId: "evt-real" })).rejects.toMatchObject({ code: "FORBIDDEN", reason: "QA_FENCE" });
    await expect(dlq.find({ clockId: "qa-812-1-sc19", eventId: "evt-real" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
  });
});

describe("alarm.history and guardrail.probe", () => {
  it("reads the state transitions of the DLQ alarm after an instant", async () => {
    const cloudWatch = mockClient(CloudWatchClient);
    cloudWatch.on(DescribeAlarmHistoryCommand).resolves({
      AlarmHistoryItems: [{ Timestamp: new Date("2026-09-26T15:05:00Z"), HistorySummary: "Alarm updated from OK to ALARM", HistoryData: JSON.stringify({ oldState: { stateValue: "OK" }, newState: { stateValue: "ALARM" } }) }],
    });
    const history = cloudWatchAlarmHistory({ alarmName: () => "aws-cds-hackathon-poc-legajo-poc-dlq", client: new CloudWatchClient({}) });
    expect(await history("2026-09-26T15:00:00Z")).toEqual([{ at: "2026-09-26T15:05:00.000Z", from: "OK", to: "ALARM", summary: "Alarm updated from OK to ALARM" }]);
    expect(cloudWatch.commandCalls(DescribeAlarmHistoryCommand)[0]?.args[0].input).toMatchObject({ AlarmName: "aws-cds-hackathon-poc-legajo-poc-dlq", HistoryItemType: "StateUpdate" });
  });

  it("applies G1 to a known attack as INPUT", async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock.on(ApplyGuardrailCommand).resolves({ action: "GUARDRAIL_INTERVENED", outputs: [], assessments: [], usage: undefined });
    const probe = g1Probe({ guardrail: () => ({ id: "g1id", version: "3" }), client: new BedrockRuntimeClient({}) });
    expect(await probe()).toEqual({ action: "GUARDRAIL_INTERVENED" });
    expect(bedrock.commandCalls(ApplyGuardrailCommand)[0]?.args[0].input).toMatchObject({ guardrailIdentifier: "g1id", guardrailVersion: "3", source: "INPUT" });
  });
});

describe("memory.inspect reads events with their text and records with their keys", () => {
  it("pages through ListEvents and ListMemoryRecords", async () => {
    const agentCore = mockClient(BedrockAgentCoreClient);
    agentCore.on(ListEventsCommand).resolves({ events: [{ eventId: "ev-1", memoryId: "m", actorId: "a", sessionId: "s", eventTimestamp: new Date(), payload: [{ conversational: { content: { text: "hola [CUIT]" }, role: "USER" } }] }] });
    agentCore.on(ListMemoryRecordsCommand).resolves({ memoryRecordSummaries: [{ memoryRecordId: "r-1", content: { text: "Prefers no emojis" }, memoryStrategyId: "p", namespaces: ["/importers/a/preferences/"], createdAt: new Date("2026-09-26T15:01:00Z") }] });
    const reader = agentCoreMemoryReader({ memoryId: () => "m", client: new BedrockAgentCoreClient({}) });
    expect(await reader.listEvents("a", "s")).toEqual([{ eventId: "ev-1", text: "hola [CUIT]" }]);
    expect(await reader.listRecords("/importers/a/preferences/")).toEqual([{ memoryRecordId: "r-1", createdAt: "2026-09-26T15:01:00.000Z", text: "Prefers no emojis" }]);
  });
});

describe("the platform mock with the driver's role", () => {
  const sign = async ({ headers }: { headers: Readonly<Record<string, string>> }) => ({ ...headers, authorization: "AWS4-HMAC-SHA256 test" });

  it("moves the ETA with the step's key as Idempotency-Key, and maps a 404", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      if (url.includes("/v1/operations/7009")) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no" } }), { status: 404 });
      return new Response(JSON.stringify({ event: { source: "legajo.carrier", "detail-type": "CarrierEtaChanged", detail: {} }, replayed: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = platformClient({ platformUrl: () => PLATFORM, sign, fetch: doFetch, sleep: () => Promise.resolve() });
    await expect(client.moveEta({ firmId: "firm-qa", operationNumber: "7001", newEta: "2026-10-20T08:00:00-03:00", occurredAtSim: "2026-10-15T09:58:00-03:00", idempotencyKey: "812-1/sc10/1/m1" })).rejects.toThrow();
    expect(seen[0]?.url).toBe(`${PLATFORM}v1/operations/7001/eta?firm=firm-qa`);
    expect(seen[0]?.headers["idempotency-key"]).toBe("812-1/sc10/1/m1");
    await expect(client.get("firm-qa", "7009")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("upload.presign and upload.done act as the browser", () => {
  it("[FL-009] presigns a template PDF, posts it to storage and confirms with its key, signing each body for OAC as the page does", async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> | undefined }> = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body, headers: init.headers as Record<string, string> | undefined });
      if (url.endsWith("/presign")) return new Response(JSON.stringify({ ok: true, url: "https://uploads.s3.amazonaws.com/", fields: { key: "uploads/t/CERTIFICATE_OF_ORIGIN/u.pdf", policy: "p" }, key: "uploads/t/CERTIFICATE_OF_ORIGIN/u.pdf", expiresInSeconds: 300 }), { status: 200 });
      if (url.endsWith("/done")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const upload = browserUpload({ origin: "https://legajo.demo.craftech.io", fetch: doFetch, seedPdf: async () => new TextEncoder().encode("%PDF-1.7 test") });
    const token = "T".repeat(43);
    expect(await upload.presign(token, { kind: "pdf", docType: "CERTIFICATE_OF_ORIGIN", version: 1 }, "op-4471")).toEqual({ status: 200, key: "uploads/t/CERTIFICATE_OF_ORIGIN/u.pdf", storageStatus: 204 });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ docType: "CERTIFICATE_OF_ORIGIN", contentType: "application/pdf", size: 13 });
    expect(calls[1]?.body).toBeInstanceOf(FormData);
    expect(await upload.done(token, ["uploads/t/CERTIFICATE_OF_ORIGIN/u.pdf"])).toEqual({ status: 200 });
    for (const call of [calls[0], calls[2]]) expect(call?.headers?.["x-amz-content-sha256"]).toBe(createHash("sha256").update(String(call?.body)).digest("hex"));
  });

  it("declares what a browser would for a file that is not a PDF, and reports the page's refusal", async () => {
    const doFetch = (async () => new Response(JSON.stringify({ error: { code: "INVALID", reason: "NOT_PDF" } }), { status: 415 })) as unknown as typeof fetch;
    const upload = browserUpload({ fetch: doFetch, seedPdf: async () => new Uint8Array() });
    expect(await upload.presign("T".repeat(43), { kind: "notPdf", docType: "PACKING_LIST" }, "op-4471")).toEqual({ status: 415, refusal: "NOT_PDF" });
  });
});

describe("reader.setFaults", () => {
  it("writes the faults of a qa-* world with the reader mock's own item, and refuses any other clock", async () => {
    const written: Array<Record<string, unknown>> = [];
    const write = readerFaultWriter({ put: async (item) => void written.push(item) });
    const now = new Date("2026-09-26T15:00:00Z");
    expect(await write("qa-812-1-sc19", { mode: "ERROR_503", rate: 1, until: "2026-09-26T17:00:00Z" }, now)).toMatchObject({ clockId: "qa-812-1-sc19", mode: "ERROR_503" });
    expect(written[0]).toMatchObject({ PK: "CONFIG", SK: "FAULTS#qa-812-1-sc19", entity: "FaultConfig" });
    await expect(write("GLOBAL#firm-delta", { mode: "ERROR_503", rate: 1, until: "2026-09-26T17:00:00Z" }, now)).rejects.toThrow(RangeError);
  });
});
