// WhatsApp through AWS End User Messaging Social (ADR-0002, docs/architecture-integrations.md §4,
// docs/architecture.md §1, §13 and §14, docs/build-plan.md WP-21): the inbound topic, its policy and
// `InboundWhatsApp`, plus what every Lambda that sends WhatsApp links and is allowed to do.
//
// Inbound. The WhatsApp Business Account publishes its events to one SNS topic with a fixed name,
// `aws-cds-hackathon-poc-legajo-wa-inbound` (a WABA has a single event destination, so the name has
// no stage). The destination itself is set by `scripts/channels/waba-event-destination.ts` once P-01
// is closed (docs/pending.md). The topic policy lets only End User Messaging Social publish, and only
// on behalf of this account (`aws:SourceAccount`). `InboundWhatsApp` is subscribed to it and is also
// what the console's phone simulator invokes (Bff and QaDriver link `inboundWhatsApp`, which grants
// `lambda:InvokeFunction` on it and nothing else): both paths enter through the same SNS envelope and
// the same normalizer. It runs the handler WP-29 writes over the adapter of WP-20.
//
// Sending. `social-messaging:SendWhatsAppMessage` (capability SEND_WHATSAPP) and, for inbound media,
// `social-messaging:GetWhatsAppMessageMedia` are granted only on the phone number of the
// `WhatsAppPhoneNumberId` secret, read at deploy time. While the secret says `not-connected` (P-01
// open, `ChannelModes.whatsapp = simulated`) there is no phone and no statement at all: the
// simulated transport never calls the service. After the operator loads the real id, the next CI
// deploy adds the statement; nothing else changes (ADR-0002). The id may be the service's form
// (`phone-number-id-<id>`) or its ARN; both resolve to the same ARN of this account and region, and
// anything else fails the deploy without printing the value.
//
// Every Lambda that runs the outbound pipeline (OperationWorker, ToolMessaging, ToolHandoff) links
// `whatsAppSenderLinks` and adds `sendWhatsAppPermissions` to its `permissions`.
//
// Cost: SNS and Lambda per message; nothing bills while no WhatsApp event arrives.
//
// Verify:
//   aws --profile craftech-demos sns get-topic-attributes --topic-arn arn:aws:sns:us-east-1:776805327629:aws-cds-hackathon-poc-legajo-wa-inbound
//     → Policy: only social-messaging.amazonaws.com, sns:Publish, aws:SourceAccount = 776805327629
//   aws --profile craftech-demos sns list-subscriptions-by-topic --topic-arn <same ARN>   → one lambda subscription (InboundWhatsApp)
//   aws --profile craftech-demos iam get-role-policy (inline policy of the InboundWhatsApp role)
//     → no social-messaging statement while WhatsAppPhoneNumberId is not-connected; afterwards only phone-number-id/<id>

import { ChannelModes } from "./channel-modes";
import { lateLinks, links } from "./late-links";
import { LATE_LINKS } from "./messaging-email-spec";
import { SeedOverrides, SessionTokenKey, WabaId, WhatsAppPhoneNumberId } from "./secrets";
import { storageLinks } from "./storage";

type PermissionStatement = Parameters<typeof sst.aws.permission>[0];

/** Handler of `InboundWhatsApp` (WP-29); the path is the contract with packages/bff. */
export const INBOUND_WHATSAPP_HANDLER = "packages/bff/src/handlers/inbound-whatsapp.handler";

/** Fixed name (docs/architecture.md §1); the CI deploy role is fenced to it by name. */
export const WHATSAPP_TOPIC_NAME = `${$app.name}-wa-inbound`;

export const SOCIAL_MESSAGING_PRINCIPAL = "social-messaging.amazonaws.com";

/** Value of both WhatsApp secrets until P-01 is closed (infra/secrets.ts). */
export const NOT_CONNECTED = "not-connected";

export const WHATSAPP_SEND_ACTIONS = ["social-messaging:SendWhatsAppMessage"] as const;
export const WHATSAPP_MEDIA_ACTIONS = ["social-messaging:GetWhatsAppMessageMedia"] as const;

/**
 * Producer side of `OperationEvents.fifo`: the Linkable `OperationEvents` of infra/operations.ts (WP-24),
 * `url` plus `sqs:SendMessage` only. Owner and actions are the ones the email functions take (one source).
 */
export const OPERATION_EVENTS_PRODUCER = { ...LATE_LINKS.OperationEvents, exportName: "OperationEvents" } as const;

const PHONE_NUMBER_ID = /^phone-number-id-([0-9a-zA-Z]+)$/;

/**
 * ARN of the phone number of the `WhatsAppPhoneNumberId` secret, or `undefined` while it is
 * `not-connected`. The service's ARN carries the id without its `phone-number-id-` prefix
 * (API pattern `arn:.*:phone-number-id/[0-9a-zA-Z]+`). The value is never echoed in an error.
 */
export function phoneNumberIdArn(scope: { region: string; accountId: string; phoneNumberId: string }): string | undefined {
  const value = scope.phoneNumberId.trim();
  if (value === NOT_CONNECTED) return undefined;
  const prefix = `arn:aws:social-messaging:${scope.region}:${scope.accountId}:phone-number-id/`;
  const id = PHONE_NUMBER_ID.exec(value)?.[1] ?? (value.startsWith(prefix) ? value.slice(prefix.length) : undefined);
  if (id === undefined || !/^[0-9a-zA-Z]+$/.test(id)) {
    throw new Error(
      `The WhatsAppPhoneNumberId secret must be "${NOT_CONNECTED}", "phone-number-id-<id>" or the ARN of a phone number ` +
        `of this account in ${scope.region}. Load it again with \`npx sst secret set WhatsAppPhoneNumberId … --stage ${$app.stage}\`.`,
    );
  }
  return `${prefix}${id}`;
}

/** Statements of a WhatsApp sender for the phone of the secret; none while it is not connected. */
export function whatsAppStatements(phoneArn: string | undefined, actions: readonly string[]): PermissionStatement[] {
  return phoneArn === undefined ? [] : [{ actions: [...actions], resources: [phoneArn] }];
}

export interface TopicPolicyDocument {
  readonly Version: "2012-10-17";
  readonly Statement: ReadonlyArray<{
    readonly Sid: string;
    readonly Effect: "Allow";
    readonly Principal: { readonly Service: string };
    readonly Action: string;
    readonly Resource: string;
    readonly Condition: { readonly StringEquals: { readonly "aws:SourceAccount": string } };
  }>;
}

/** Only End User Messaging Social may publish, and only for this account (anti confused deputy). */
export function whatsAppTopicPolicy(scope: { topicArn: string; accountId: string }): TopicPolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "EndUserMessagingSocialPublishes",
        Effect: "Allow",
        Principal: { Service: SOCIAL_MESSAGING_PRINCIPAL },
        Action: "sns:Publish",
        Resource: scope.topicArn,
        Condition: { StringEquals: { "aws:SourceAccount": scope.accountId } },
      },
    ],
  };
}

const accountId = aws.getCallerIdentityOutput({}).accountId;
const region = aws.getRegionOutput({}).region;

const phoneArn = $util
  .all([region, accountId, WhatsAppPhoneNumberId.value])
  .apply(([regionName, account, phoneNumberId]) => phoneNumberIdArn({ region: regionName, accountId: account, phoneNumberId }));

/** SEND_WHATSAPP (docs/architecture.md §14): for the `permissions` of every Lambda that sends WhatsApp. */
export const sendWhatsAppPermissions = phoneArn.apply((arn) => whatsAppStatements(arn, WHATSAPP_SEND_ACTIONS));

/** What a WhatsApp sender reads at runtime: the channel mode, the WABA identity and the demo phones. */
export const whatsAppSenderLinks = [ChannelModes, WabaId, WhatsAppPhoneNumberId, SeedOverrides];

export const whatsAppTopic = new sst.aws.SnsTopic("WhatsAppInbound", {
  transform: {
    topic: (args) => {
      args.name = WHATSAPP_TOPIC_NAME;
    },
  },
});

export const whatsAppTopicPolicyResource = new aws.sns.TopicPolicy("WhatsAppInboundPolicy", {
  arn: whatsAppTopic.arn,
  policy: $util.all([whatsAppTopic.arn, accountId]).apply(([topicArn, account]) => JSON.stringify(whatsAppTopicPolicy({ topicArn, accountId: account }))),
});

/**
 * Inbound WhatsApp (live SNS events and the phone simulator's signed envelope). Links its tables and
 * the `Media` bucket (infra/iam-capabilities.ts), the channel mode (a simulated envelope is refused
 * in live mode), `SessionTokenKey` (phone-hash, nonce and sim-envelope subkeys), the WhatsApp
 * secrets and `SeedOverrides` (fixed replies go through the same live-phone fence), and the
 * producer side of `OperationEvents.fifo`.
 */
export const inboundWhatsApp = new sst.aws.Function("InboundWhatsApp", {
  description: "WhatsApp events of End User Messaging Social and the phone simulator: identity, routing, media, queue.",
  handler: INBOUND_WHATSAPP_HANDLER,
  link: links(
    [...storageLinks("InboundWhatsApp"), SessionTokenKey, ...whatsAppSenderLinks],
    lateLinks("messaging-whatsapp", OPERATION_EVENTS_PRODUCER.owner, () => import("./operations"), [OPERATION_EVENTS_PRODUCER.exportName]),
  ),
  permissions: phoneArn.apply((arn) => whatsAppStatements(arn, [...WHATSAPP_SEND_ACTIONS, ...WHATSAPP_MEDIA_ACTIONS])),
  timeout: "30 seconds",
  memory: "512 MB",
});

export const inboundWhatsAppSubscription = whatsAppTopic.subscribe("InboundWhatsApp", inboundWhatsApp.arn);
