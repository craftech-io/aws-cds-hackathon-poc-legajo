// EventBridge bus `Feeds` and its consumer `FeedEvents` (docs/architecture.md §4 and §14,
// docs/architecture-integrations.md §6, docs/build-plan.md WP-21).
//
// The external systems this POC simulates push their events the way a real one would: the customs
// platform mock (`PlatformMock`, infra/mocks.ts) calls `PutEvents` on this bus with the carrier's
// `CarrierEtaChanged` (source `mock.platform.carrier`) and customs' `CustomsStatusChanged` (source
// `mock.platform.customs`). One rule hands exactly those two events to `FeedEvents`, which validates
// them with zod, resolves the operation by firm and number, deduplicates by `detail.eventId` and
// enqueues `ETA_CHANGED` or `DISPATCH_STATUS` on `OperationEvents.fifo` (WP-29 writes the handler).
// Sources and detail types are those of packages/platform-mock/src/events.ts, the publisher's own
// schema; they are spelled out here so the deploy program does not bundle the package (its workspace
// imports), and infra/mocks-spec.test.ts fails when the two drift apart.
//
// Names. The bus component is `FeedsBus` (SST names it `<app>-<stage>-FeedsBusBus-<random>`, inside the
// `event-bus/<app>-*` fence of the CI deploy role). Code reads it as `Resource.Feeds` through the
// Linkable `Feeds`, which grants only `events:PutEvents` on this bus: linking the bus component itself
// would grant `events:*` (capability of `PlatformMock`, infra/iam-capabilities.ts).
//
// What `FeedEvents` links (infra/iam-capabilities.ts): `Operations` (GSI2 by thread key), `Runtime`
// (clock epoch, idempotency, `inFlight`) and `AuditLog`; `SessionTokenKey`, whose `thread` subkey
// rebuilds the thread tag of `<number>|<clockId>|<worldEpoch>` to find the operation; and the
// producer side of `OperationEvents.fifo` from infra/operations.ts (WP-24), which grants only
// `sqs:SendMessage`.
//
// Cost: per event published and per invocation; nothing bills while the platform is idle.
//
// Verify:
//   aws --profile craftech-demos events list-event-buses --name-prefix aws-cds-hackathon-poc-legajo-poc-FeedsBus
//   aws --profile craftech-demos events list-rules --event-bus-name <bus name>
//     → one rule, State ENABLED, EventPattern with both sources and both detail types
//   aws --profile craftech-demos events list-targets-by-rule --event-bus-name <bus name> --rule <rule name>
//     → the FeedEvents function

import { lateLinks, links } from "./late-links";
import { OPERATION_EVENTS_PRODUCER } from "./messaging-whatsapp";
import { SessionTokenKey } from "./secrets";
import { storageLinks } from "./storage";

/** Handler of `FeedEvents` (WP-29); the path is the contract with packages/bff. */
export const FEED_EVENTS_HANDLER = "packages/bff/src/handlers/feed-events.handler";

/** The only actions the `Feeds` link grants: publishing, never managing the bus or its rules. */
export const FEEDS_LINK_ACTIONS = ["events:PutEvents"] as const;

/** Events of the platform mock the rule hands to `FeedEvents` (and nothing else on the bus). */
export const FEED_EVENT_PATTERN = {
  source: ["mock.platform.carrier", "mock.platform.customs"],
  detailType: ["CarrierEtaChanged", "CustomsStatusChanged"],
};

export const feedsBus = new sst.aws.Bus("FeedsBus");

/** `Resource.Feeds.{name,arn}` for the platform mock's publisher; grants only `events:PutEvents`. */
export const Feeds = new sst.Linkable("Feeds", {
  properties: { name: feedsBus.name, arn: feedsBus.arn },
  include: [sst.aws.permission({ actions: [...FEEDS_LINK_ACTIONS], resources: [feedsBus.arn] })],
});

export const feedEvents = new sst.aws.Function("FeedEvents", {
  description: "Validates the platform feed events of the Feeds bus and enqueues ETA_CHANGED or DISPATCH_STATUS.",
  handler: FEED_EVENTS_HANDLER,
  link: links(
    [...storageLinks("FeedEvents"), SessionTokenKey],
    lateLinks("feeds", OPERATION_EVENTS_PRODUCER.owner, () => import("./operations"), [OPERATION_EVENTS_PRODUCER.exportName]),
  ),
  timeout: "30 seconds",
  memory: "256 MB",
});

export const feedEventsSubscription = feedsBus.subscribe("FeedEvents", feedEvents, { pattern: FEED_EVENT_PATTERN });
