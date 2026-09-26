import { ApplyGuardrailCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { GetEmailIdentityCommand, SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { groundTruthItems } from "@legajo/reader-mock";
import { sha256Of, syntheticPdf } from "@legajo/reader-mock/testing";
import { afterEach, describe, expect, it } from "vitest";
import { installAwsFakes, type AwsFakes } from "./fakes/aws";
import { inProcessReader } from "./fakes/reader";

const REGION = { region: "us-east-1" };
let fakes: AwsFakes | undefined;
const install = () => (fakes = installAwsFakes({ now: () => new Date("2026-09-26T15:00:00.000Z") }));

afterEach(() => {
  fakes?.restore();
  fakes = undefined;
});

describe("AWS fakes of the local flows", () => {
  it("records what SES would send and answers a message id, without leaving the process", async () => {
    const aws = install();
    const answer = await new SESv2Client(REGION).send(
      new SendEmailCommand({ FromEmailAddress: "op-4471-k7p2q9@legajo.demo.craftech.io", Destination: { ToAddresses: ["supplier-qingdao@sim.legajo.demo.craftech.io"] }, Content: { Simple: { Subject: { Data: "[Op 4471] Documents" }, Body: { Text: { Data: "body" } } } } }),
    );
    expect(answer.MessageId).toBe("ses-local-000001");
    expect(aws.sesSent).toHaveLength(1);
    expect(aws.sesSent[0]?.Destination?.ToAddresses).toEqual(["supplier-qingdao@sim.legajo.demo.craftech.io"]);
  });

  it("rejects a command no fake answers, and a service the flows keep closed", async () => {
    install();
    await expect(new SESv2Client(REGION).send(new GetEmailIdentityCommand({ EmailIdentity: "legajo.demo.craftech.io" }))).rejects.toThrow(/not faked/);
    await expect(new DynamoDBClient(REGION).send(new ListTablesCommand({}))).rejects.toThrow(/keep closed/);
  });

  it("refuses a second set of fakes while one is installed", () => {
    install();
    expect(() => installAwsFakes()).toThrow(/already installed/);
  });

  it("queues FIFO messages once per deduplication id and drains them in order, retrying to the dead letters", async () => {
    const aws = install();
    const sqs = new SQSClient(REGION);
    const queueUrl = "https://sqs.us-east-1.amazonaws.com/000000000000/operation-events.fifo";
    for (const [id, group] of [["evt-1", "op-4471"], ["evt-2", "op-4472"], ["evt-1", "op-4471"], ["evt-3", "op-4471"]] as const) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ eventId: id }), MessageGroupId: group, MessageDeduplicationId: id }));
    }
    expect(aws.queue.sent).toHaveLength(4);
    expect(aws.queue.pending().map((message) => JSON.parse(message.body).eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);

    const seen: string[] = [];
    const processed = await aws.queue.drain(async (event) => {
      const record = event.Records[0];
      const eventId = JSON.parse(record?.body ?? "{}").eventId as string;
      seen.push(`${eventId}#${record?.attributes.ApproximateReceiveCount}`);
      if (eventId === "evt-2") throw new Error("poison");
    });
    expect(processed).toBe(2);
    expect(seen).toEqual(["evt-1#1", "evt-2#1", "evt-2#2", "evt-3#1"]);
    expect(aws.queue.deadLetters.map((message) => JSON.parse(message.body).eventId)).toEqual(["evt-2"]);
  });

  it("keeps schedules by group and name like EventBridge Scheduler", async () => {
    const aws = install();
    const scheduler = new SchedulerClient(REGION);
    const schedule = { GroupName: "legajo-schedules", Name: "tm-q-docs", ScheduleExpression: "at(2026-10-15T13:00:00)", FlexibleTimeWindow: { Mode: "OFF" as const }, Target: { Arn: "arn:aws:lambda:us-east-1:000000000000:function:dispatch", RoleArn: "arn:aws:iam::000000000000:role/scheduler" } };
    await scheduler.send(new CreateScheduleCommand(schedule));
    expect([...aws.schedules.keys()]).toEqual(["legajo-schedules/tm-q-docs"]);
    await scheduler.send(new DeleteScheduleCommand({ GroupName: "legajo-schedules", Name: "tm-q-docs" }));
    expect(aws.schedules.size).toBe(0);
    await expect(scheduler.send(new DeleteScheduleCommand({ GroupName: "legajo-schedules", Name: "tm-q-docs" }))).rejects.toThrow(/not found/);
  });

  it("answers ApplyGuardrail from the test's script: passing by default, grounded on output", async () => {
    const aws = install();
    const runtime = new BedrockRuntimeClient(REGION);
    const input = await runtime.send(new ApplyGuardrailCommand({ guardrailIdentifier: "g1", guardrailVersion: "1", source: "INPUT", content: [{ text: { text: "hola" } }] }));
    expect(input.action).toBe("NONE");
    const output = await runtime.send(new ApplyGuardrailCommand({ guardrailIdentifier: "g2", guardrailVersion: "1", source: "OUTPUT", content: [{ text: { text: "respuesta" } }] }));
    expect(output.assessments?.[0]?.contextualGroundingPolicy?.filters?.map((filter) => filter.score)).toEqual([1, 1]);
    aws.scriptGuardrail(() => ({ action: "GUARDRAIL_INTERVENED", outputs: [{ text: "blocked" }], assessments: [{ topicPolicy: { topics: [{ name: "Tariff classification", type: "DENY", action: "BLOCKED" }] } }] }));
    const blocked = await runtime.send(new ApplyGuardrailCommand({ guardrailIdentifier: "g1", guardrailVersion: "1", source: "INPUT", content: [{ text: { text: "posición arancelaria" } }] }));
    expect(blocked.assessments?.[0]?.topicPolicy?.topics?.[0]?.action).toBe("BLOCKED");
    expect(aws.guardrailCalls).toHaveLength(3);
  });

  it("stores S3 objects in process, copies them and reads them back with the SDK's stream helpers", async () => {
    const aws = install();
    const s3 = new S3Client(REGION);
    await s3.send(new PutObjectCommand({ Bucket: "mail", Key: "inbound/abc", Body: "MIME-Version: 1.0", ContentType: "message/rfc822" }));
    await s3.send(new CopyObjectCommand({ Bucket: "documents", Key: "op-4471/dv-1", CopySource: "mail/inbound/abc" }));
    const read = await s3.send(new GetObjectCommand({ Bucket: "documents", Key: "op-4471/dv-1" }));
    expect(await read.Body?.transformToString()).toBe("MIME-Version: 1.0");
    expect(aws.objects.keys("documents")).toEqual(["op-4471/dv-1"]);
    await expect(s3.send(new GetObjectCommand({ Bucket: "documents", Key: "missing" }))).rejects.toThrow(/NoSuchKey/);
  });
});

describe("reader in process", () => {
  it("reads a PDF of the world's Documents bucket through the BFF client and the reader mock, with a locally pre-signed URL", async () => {
    const aws = install();
    const now = () => new Date("2026-10-15T13:00:00.000Z");
    const reader = inProcessReader({ objects: aws.objects, now });
    const pdf = syntheticPdf({ LegajoDocId: "LDOC-4471-PL-v1" });
    reader.catalog.load(
      groundTruthItems({
        sha256: sha256Of(pdf),
        docId: "LDOC-4471-PL-v1",
        reading: { status: "RECOGNIZED", docType: "PACKING_LIST", confidence: 0.97, pages: 1, language: "en", fields: { grossWeightKg: 12480 }, observations: [] },
      }),
    );
    aws.objects.put({ bucket: reader.documentsBucket, key: "op-4471/PACKING_LIST/v1.pdf", body: pdf });
    const reading = await reader.client.createReading({ docVersionId: "dv-4471-PL-1", sha256: sha256Of(pdf), sourceUrl: await reader.sourceUrl("op-4471/PACKING_LIST/v1.pdf"), clockId: "GLOBAL#firm-delta" });
    expect(reading).toMatchObject({ status: "RECOGNIZED", docType: "PACKING_LIST", matchedBy: "SHA256" });
    expect(reader.requests.map((request) => request.method)).toEqual(["POST"]);
    expect(reader.requests[0]?.headers["x-fault-scope"]).toBeUndefined();
  });
});
