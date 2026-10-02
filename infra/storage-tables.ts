// DynamoDB tables: one per aggregate, keys, GSIs and TTL exactly as docs/architecture.md §5 (the spec
// lives in storage-keys.ts, checked by storage-keys.test.ts). The tables of the external mocks
// (`ReaderCatalog`, `Platform`) belong to infra/mocks.ts (WP-21). Imported by infra/storage.ts, which
// is what the rest of infra/ uses.
//
//   - On-demand billing and no stream: nothing bills while idle, and every reaction to a change goes
//     through the operation queue (docs/architecture.md §7), never through a table stream.
//   - Encryption at rest with the AWS managed key (`aws/dynamodb`); point-in-time recovery stays on
//     (SST's default).
//   - Physical names are SST's (`<app>-<stage>-<Name>Table-<random>`), inside the `table/<app>-*`
//     fence of the CI deploy role; code reads them from the link (`Resource.Operations.name`).
//   - `Leads` (ADR-0015 §6) is built exactly like the rest (same keys convention, encryption, TTL and
//     the stage's `remove` policy) but is never linked whole: its component is `LeadsData`, and
//     infra/leads.ts exposes `Resource.Leads.name` through a Linkable without permissions plus one
//     fenced statement per role (storage-keys.ts `FENCED_TABLES`).
//
// Verify (docs/build-plan.md WP-06, `qa` compares with §5 after the deploy):
//   aws --profile craftech-demos dynamodb describe-table --table-name <physical name>
//     → KeySchema PK/SK, GlobalSecondaryIndexes, SSEDescription.Status ENABLED
//   aws --profile craftech-demos dynamodb describe-time-to-live --table-name <physical name>
//     → AttributeName expiresAt, ENABLED (every table but Reference)

import { PRIMARY_KEY, TABLE_SPECS, TTL_ATTRIBUTE, fencedTableComponent, tableFields, type LinkedTable, type StorageTable, type TableSpec } from "./storage-keys";

function table(name: StorageTable, component: string = name): sst.aws.Dynamo {
  const spec: TableSpec = TABLE_SPECS[name];
  return new sst.aws.Dynamo(component, {
    fields: tableFields(spec),
    primaryIndex: PRIMARY_KEY,
    globalIndexes: spec.indexes,
    ttl: spec.ttl ? TTL_ATTRIBUTE : undefined,
    transform: {
      table: (args) => {
        args.serverSideEncryption = { enabled: true };
      },
    },
  });
}

export const Firms = table("Firms");
export const Parties = table("Parties");
export const Operations = table("Operations");
export const Conversations = table("Conversations");
export const AuditLog = table("AuditLog");
export const Reference = table("Reference");
export const Runtime = table("Runtime");
export const LegajoMetrics = table("LegajoMetrics");

/** Leads of the public signup; never in `tables` (nobody links it whole), see infra/leads.ts. */
export const leadsTable = table("Leads", fencedTableComponent("Leads"));

/** Every linkable table of this module, by logical name (the same name `Resource.<Name>` exposes). */
export const tables = {
  Firms,
  Parties,
  Operations,
  Conversations,
  AuditLog,
  Reference,
  Runtime,
  LegajoMetrics,
} as const satisfies Record<LinkedTable, sst.aws.Dynamo>;
