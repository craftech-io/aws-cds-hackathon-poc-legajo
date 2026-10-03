// The AWS edge of the local flows: every SDK client the stage's code uses is stubbed at `send`, so
// the modules run unchanged and nothing leaves the machine (docs/test-plan.md §2, level LF: "SES y
// WhatsApp graban lo que mandarían"). The recorded inputs are what the tests assert on; a command
// this file does not fake rejects, so a module that reaches an unexpected service fails loudly.
//
//   SES v2           SendEmail recorded, deterministic MessageId
//   EUM Social       SendWhatsAppMessage recorded, deterministic wamid (only the live transport calls it)
//   SQS              SendMessage into the in-process FIFO (fakes/queue.ts), ChangeMessageVisibility recorded
//   Scheduler        Create/Update/Delete/GetSchedule over a map (only a RUNNING world creates schedules)
//   Bedrock runtime  ApplyGuardrail answered by the test's script (G1 pre-filter and G2)
//   AgentCore        InvokeHarness answered by the scripted Harness; Memory calls reject
//   S3               Put/Get/Head/Copy/Delete over fakes/objects.ts
//   EventBridge      PutEvents recorded
import { BedrockAgentCoreClient, InvokeHarnessCommand, type InvokeHarnessCommandInput, type InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { ApplyGuardrailCommand, BedrockRuntimeClient, type ApplyGuardrailCommandInput, type ApplyGuardrailCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand, SchedulerClient, UpdateScheduleCommand, type CreateScheduleCommandInput } from "@aws-sdk/client-scheduler";
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { SendWhatsAppMessageCommand, SocialMessagingClient, type SendWhatsAppMessageCommandInput } from "@aws-sdk/client-socialmessaging";
import { ChangeMessageVisibilityCommand, SQSClient, SendMessageCommand, type ChangeMessageVisibilityCommandInput } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { bodyBytes, createObjectStore, objectBody, parseCopySource, type ObjectStore } from "./objects";
import { createFifoQueue, type FifoQueue } from "./queue";

export type GuardrailAnswer = Pick<ApplyGuardrailCommandOutput, "action" | "outputs" | "assessments" | "actionReason">;
export type GuardrailScript = (input: ApplyGuardrailCommandInput) => GuardrailAnswer;
export type HarnessResponder = (input: InvokeHarnessCommandInput) => Promise<{ readonly stream: AsyncIterable<InvokeHarnessStreamOutput> }>;

/** G1 on input lets everything through; G2 on output scores every text as fully grounded and relevant. */
export const PASSING_GUARDRAIL: GuardrailScript = (input) => ({
  action: "NONE",
  outputs: [],
  assessments:
    input.source === "OUTPUT"
      ? [
          {
            contextualGroundingPolicy: {
              filters: [
                { type: "GROUNDING", threshold: 0.75, score: 1, action: "NONE" },
                { type: "RELEVANCE", threshold: 0.5, score: 1, action: "NONE" },
              ],
            },
          },
        ]
      : [],
});

const NO_USAGE = { topicPolicyUnits: 0, contentPolicyUnits: 0, wordPolicyUnits: 0, sensitiveInformationPolicyUnits: 0, sensitiveInformationPolicyFreeUnits: 0, contextualGroundingPolicyUnits: 0 };

/** One `SendEmail` and the `MessageId` the fake answered (the `<id@email.amazonses.com>` of the mail). */
export interface SentEmail {
  readonly input: SendEmailCommandInput;
  readonly messageId: string;
}

export interface AwsFakes {
  readonly sesSent: SendEmailCommandInput[];
  /** Every `SendEmail` with its id, in order (what the in-process mailroom delivers). */
  readonly sesMessages: SentEmail[];
  readonly whatsappSent: SendWhatsAppMessageCommandInput[];
  readonly queue: FifoQueue;
  readonly visibilityChanges: ChangeMessageVisibilityCommandInput[];
  readonly schedules: ReadonlyMap<string, CreateScheduleCommandInput>;
  readonly guardrailCalls: ApplyGuardrailCommandInput[];
  readonly events: PutEventsRequestEntry[];
  readonly objects: ObjectStore;
  readonly harnessCalls: InvokeHarnessCommandInput[];
  /** Replaces the guardrail script (both sources); `PASSING_GUARDRAIL` until then. */
  scriptGuardrail(script: GuardrailScript): void;
  /** Who answers `InvokeHarness`: the scripted Harness of the world. */
  answerHarness(responder: HarnessResponder): void;
  /** Takes every stub off; call it when the test ends. */
  restore(): void;
}

function notFaked(service: string): Error {
  return new Error(`${service}: this command is not faked in the local flows (nothing leaves the machine)`);
}

function scheduleKey(input: { readonly GroupName?: string | undefined; readonly Name?: string | undefined }): string {
  return `${input.GroupName ?? "default"}/${input.Name ?? ""}`;
}

// The stubs replace `send` on each client's prototype: two sets at once would restore each other.
let installed = false;

export function installAwsFakes(options: { readonly now?: () => Date } = {}): AwsFakes {
  if (installed) throw new Error("the AWS fakes are already installed: close the previous world before creating another");
  installed = true;
  const sesSent: SendEmailCommandInput[] = [];
  const sesMessages: SentEmail[] = [];
  const whatsappSent: SendWhatsAppMessageCommandInput[] = [];
  const visibilityChanges: ChangeMessageVisibilityCommandInput[] = [];
  const schedules = new Map<string, CreateScheduleCommandInput>();
  const guardrailCalls: ApplyGuardrailCommandInput[] = [];
  const events: PutEventsRequestEntry[] = [];
  const harnessCalls: InvokeHarnessCommandInput[] = [];
  const objects = createObjectStore();
  const queue = createFifoQueue(options.now === undefined ? {} : { now: options.now });
  let guardrail: GuardrailScript = PASSING_GUARDRAIL;
  let harness: HarnessResponder = () => Promise.reject(notFaked("AgentCore InvokeHarness (no scripted Harness answers it)"));
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}${String((counter += 1)).padStart(6, "0")}`;

  const ses = mockClient(SESv2Client);
  ses.onAnyCommand().rejects(notFaked("SES v2"));
  ses.on(SendEmailCommand).callsFake((input: SendEmailCommandInput) => {
    sesSent.push(input);
    const messageId = nextId("ses-local-");
    sesMessages.push({ input, messageId });
    return { MessageId: messageId };
  });

  const social = mockClient(SocialMessagingClient);
  social.onAnyCommand().rejects(notFaked("End User Messaging Social"));
  social.on(SendWhatsAppMessageCommand).callsFake((input: SendWhatsAppMessageCommandInput) => {
    whatsappSent.push(input);
    return { messageId: nextId("wamid.LOCAL.") };
  });

  const sqs = mockClient(SQSClient);
  sqs.onAnyCommand().rejects(notFaked("SQS"));
  sqs.on(SendMessageCommand).callsFake((input) => ({ MessageId: queue.send(input).MessageId }));
  sqs.on(ChangeMessageVisibilityCommand).callsFake((input: ChangeMessageVisibilityCommandInput) => {
    visibilityChanges.push(input);
    return {};
  });

  const scheduler = mockClient(SchedulerClient);
  scheduler.onAnyCommand().rejects(notFaked("EventBridge Scheduler"));
  scheduler.on(CreateScheduleCommand).callsFake((input: CreateScheduleCommandInput) => {
    schedules.set(scheduleKey(input), input);
    return { ScheduleArn: `arn:aws:scheduler:us-east-1:000000000000:schedule/${scheduleKey(input)}` };
  });
  scheduler.on(UpdateScheduleCommand).callsFake((input: CreateScheduleCommandInput) => {
    if (!schedules.has(scheduleKey(input))) throw Object.assign(new Error("schedule not found"), { name: "ResourceNotFoundException" });
    schedules.set(scheduleKey(input), input);
    return { ScheduleArn: `arn:aws:scheduler:us-east-1:000000000000:schedule/${scheduleKey(input)}` };
  });
  scheduler.on(DeleteScheduleCommand).callsFake((input: { GroupName?: string; Name?: string }) => {
    if (!schedules.delete(scheduleKey(input))) throw Object.assign(new Error("schedule not found"), { name: "ResourceNotFoundException" });
    return {};
  });
  scheduler.on(GetScheduleCommand).callsFake((input: { GroupName?: string; Name?: string }) => {
    const found = schedules.get(scheduleKey(input));
    if (found === undefined) throw Object.assign(new Error("schedule not found"), { name: "ResourceNotFoundException" });
    return found;
  });

  const runtime = mockClient(BedrockRuntimeClient);
  runtime.onAnyCommand().rejects(notFaked("Bedrock runtime"));
  runtime.on(ApplyGuardrailCommand).callsFake((input: ApplyGuardrailCommandInput) => {
    guardrailCalls.push(input);
    return { usage: NO_USAGE, ...guardrail(input) };
  });

  const agentcore = mockClient(BedrockAgentCoreClient);
  agentcore.onAnyCommand().rejects(notFaked("AgentCore"));
  agentcore.on(InvokeHarnessCommand).callsFake((input: InvokeHarnessCommandInput) => {
    harnessCalls.push(input);
    return harness(input);
  });

  const s3 = mockClient(S3Client);
  s3.onAnyCommand().rejects(notFaked("S3"));
  s3.on(PutObjectCommand).callsFake(async (input: { Bucket: string; Key: string; Body?: unknown; ContentType?: string; Metadata?: Record<string, string> }) => {
    objects.put({ bucket: input.Bucket, key: input.Key, body: await bodyBytes(input.Body ?? ""), ...(input.ContentType === undefined ? {} : { contentType: input.ContentType }), ...(input.Metadata === undefined ? {} : { metadata: input.Metadata }) });
    return { ETag: `"${nextId("etag-")}"` };
  });
  const found = (input: { Bucket: string; Key: string }) => {
    const object = objects.get(input.Bucket, input.Key);
    if (object === undefined) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    return object;
  };
  s3.on(GetObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
    const object = found(input);
    return { Body: objectBody(object.body), ContentLength: object.body.byteLength, ContentType: object.contentType, Metadata: object.metadata };
  });
  s3.on(HeadObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
    const object = found(input);
    return { ContentLength: object.body.byteLength, ContentType: object.contentType, Metadata: object.metadata };
  });
  s3.on(CopyObjectCommand).callsFake((input: { Bucket: string; Key: string; CopySource: string }) => {
    const source = found({ Bucket: parseCopySource(input.CopySource).bucket, Key: parseCopySource(input.CopySource).key });
    objects.put({ bucket: input.Bucket, key: input.Key, body: source.body, ...(source.contentType === undefined ? {} : { contentType: source.contentType }), metadata: source.metadata });
    return { CopyObjectResult: {} };
  });
  s3.on(DeleteObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
    objects.delete(input.Bucket, input.Key);
    return {};
  });

  const eventBridge = mockClient(EventBridgeClient);
  eventBridge.onAnyCommand().rejects(notFaked("EventBridge"));
  eventBridge.on(PutEventsCommand).callsFake((input: { Entries?: PutEventsRequestEntry[] }) => {
    const entries = input.Entries ?? [];
    events.push(...entries);
    return { FailedEntryCount: 0, Entries: entries.map(() => ({ EventId: nextId("evt-local-") })) };
  });

  const closedError = notFaked("a service the local flows keep closed (Lambda, CloudWatch, Cognito, DynamoDB)");
  const closed = [
    mockClient(LambdaClient).rejects(closedError),
    mockClient(CloudWatchClient).rejects(closedError),
    mockClient(CognitoIdentityProviderClient).rejects(closedError),
    mockClient(DynamoDBClient).rejects(closedError),
  ];

  const stubs = [ses, social, sqs, scheduler, runtime, agentcore, s3, eventBridge, ...closed];
  return {
    sesSent,
    sesMessages,
    whatsappSent,
    queue,
    visibilityChanges,
    schedules,
    guardrailCalls,
    events,
    objects,
    harnessCalls,
    scriptGuardrail: (script) => {
      guardrail = script;
    },
    answerHarness: (responder) => {
      harness = responder;
    },
    restore: () => {
      for (const stub of stubs) stub.restore();
      installed = false;
    },
  };
}
