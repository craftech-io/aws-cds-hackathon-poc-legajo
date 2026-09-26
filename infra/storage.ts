// Storage of the app (docs/build-plan.md WP-06): DynamoDB tables and S3 buckets of
// docs/architecture.md §5-§6. This module only aggregates; each concern lives in its own file:
//
//   storage-keys.ts      keys, GSIs, TTL, layout, retention, CORS and fences as plain data (tested)
//   storage-tables.ts    one table per aggregate (the mocks' tables are infra/mocks.ts, WP-21)
//   storage-buckets.ts   Documents, Uploads, Media, Seed and the Ingress mail bucket
//   malware.ts           GuardDuty Malware Protection for S3 over Uploads and Media
//
// A Lambda links what it needs and reads `Resource.<Name>.name` (through `readLinked`), never
// `process.env`. `storageLinks(fn)` returns exactly the tables and buckets infra/iam-capabilities.ts
// declares for a function, so a module never picks them by hand; the mocks' tables it lists in
// `storageFor(fn).mockTables` come from infra/mocks.ts. The Ingress mail bucket is never linked whole:
// its readers reach it only through the per-route Linkables of infra/messaging-email.ts
// (`InboundMailOps`, `InboundMailSim`: `s3:GetObject` on one prefix), which `emailLinks(fn)` brings.

import type { LambdaName } from "./iam-capabilities";
import { buckets } from "./storage-buckets";
import { storageFor } from "./storage-keys";
import { tables } from "./storage-tables";

export { AuditLog, Conversations, Firms, LegajoMetrics, Operations, Parties, Reference, Runtime, tables } from "./storage-tables";
export { buckets, documentsBucket, inboundMailBucket, mediaBucket, seedBucket, uploadsBucket } from "./storage-buckets";
export { storageFor } from "./storage-keys";

/** Buckets that are only reachable through a narrower Linkable of another module. */
export const ROUTED_BUCKETS = ["InboundMail"] as const;

/** Tables and buckets of this module a function links, as iam-capabilities.ts declares them (never InboundMail). */
export function storageLinks(fn: LambdaName): Array<sst.aws.Dynamo | sst.aws.Bucket> {
  const needs = storageFor(fn);
  const direct = needs.buckets.filter((name) => !(ROUTED_BUCKETS as readonly string[]).includes(name));
  return [...needs.tables.map((name) => tables[name]), ...direct.map((name) => buckets[name])];
}
