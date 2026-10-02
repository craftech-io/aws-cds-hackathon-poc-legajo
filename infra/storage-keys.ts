// Storage of the app as plain data and pure functions (docs/architecture.md §5-§6, docs/build-plan.md
// WP-06). No SST or Pulumi dependency: infra/storage-tables.ts, infra/storage-buckets.ts and
// infra/malware.ts build the resources from this file, and infra/storage-keys.test.ts checks every
// value against docs/architecture.md, the CI bootstrap and iam-capabilities.ts without an AWS account.
//
// DynamoDB conventions (shared with the connector, packages/bff/src/connector/dynamo/):
//   - Every table is keyed by `PK` + `SK` (strings). Composite values live inside those two
//     attributes; the only other declared attributes are the keys of a GSI.
//   - The TTL attribute is `expiresAt`, in EPOCH SECONDS (a Number). DynamoDB ignores a TTL attribute
//     that is not a Number, so an ISO string there would never expire.
//   - GSIs project every attribute: the tables are small and the readers take whole items.
//
// S3 conventions: every bucket is private, HTTPS-only, SSE-S3 and aborts incomplete multipart uploads;
// QA worlds write under `qa/<runId>/`, which expires in two days wherever the bucket keeps more.

import { CI_DEPLOY_STAGE, type BrowserBucket } from "./ci-spec";
import {
  CAPABILITIES,
  LAMBDA_CAPABILITIES,
  expectedTables,
  resolveCapabilities,
  type BucketName,
  type LambdaCapabilities,
  type LambdaName,
  type TableName,
} from "./iam-capabilities";

// ---- DynamoDB ----------------------------------------------------------------------------------

/** Tables of docs/architecture.md §5 that belong to the external mocks (infra/mocks.ts, WP-21). */
export const MOCK_TABLES = ["ReaderCatalog", "Platform"] as const satisfies readonly TableName[];
export type MockTable = (typeof MOCK_TABLES)[number];

/** Tables this module creates. */
export type StorageTable = Exclude<TableName, MockTable>;

/**
 * Tables this module creates that no Lambda ever links whole: an SST link grants `dynamodb:*` on the
 * table, and `Leads` holds real addresses (ADR-0015 §6). Each role reaches it through the name-only
 * Linkable `Leads` plus its own statement (infra/leads-spec.ts `LEADS_ACCESS`).
 */
export const FENCED_TABLES = ["Leads"] as const satisfies readonly StorageTable[];
export type FencedTable = (typeof FENCED_TABLES)[number];
/** Tables of this module a Lambda links whole (`Resource.<Name>`, `dynamodb:*` on the table). */
export type LinkedTable = Exclude<StorageTable, FencedTable>;

/** Component name of a fenced table: `Resource.<Name>` belongs to its name-only Linkable. */
export const fencedTableComponent = (name: FencedTable): string => `${name}Data`;

export const PRIMARY_KEY = { hashKey: "PK", rangeKey: "SK" } as const;

/** TTL attribute of every table that expires items: epoch seconds (Number). */
export const TTL_ATTRIBUTE = "expiresAt";

export interface IndexSpec {
  readonly hashKey: string;
  readonly rangeKey?: string;
}

export interface TableSpec {
  /** Global secondary indexes by name (`GSI1`..`GSI3`), always projecting every attribute. */
  readonly indexes: Readonly<Record<string, IndexSpec>>;
  /** Whether DynamoDB deletes items once `expiresAt` passes. */
  readonly ttl: boolean;
}

export const TABLE_SPECS = {
  // Firm, FirmSettings, Broker, Checklist, ResponsibilityMatrix. GSI1: console principal by Cognito sub.
  Firms: { indexes: { GSI1: { hashKey: "cognitoSubKey" } }, ttl: true },
  // Importer, Consent, SupplierAuthorization, Supplier, SupplierContact, SupplierProfile and the
  // `ADDR#<hash>` claims. GSI1/GSI2: identity by hashed phone and email; GSI3: registry of a firm.
  Parties: {
    indexes: { GSI1: { hashKey: "phoneHash" }, GSI2: { hashKey: "emailHash" }, GSI3: { hashKey: "firmKey", rangeKey: "sortName" } },
    ttl: true,
  },
  // Operation, Document, DocumentVersion, Observation, Escalation, Timer. GSI1: console list by firm and
  // status; GSI2: email thread; GSI3 (sparse): SCHEDULED timers of a clock by simulated due time.
  Operations: {
    indexes: {
      GSI1: { hashKey: "firmStatusKey", rangeKey: "etaSort" },
      GSI2: { hashKey: "threadKey" },
      GSI3: { hashKey: "clockDueKey", rangeKey: "dueAtSim" },
    },
    ttl: true,
  },
  // Message, MessageEvent, TurnNote, MailboxMessage. GSI1: message by provider id; GSI2: contacts per
  // counterpart by simulated time (daily frequency and the 24-hour window).
  Conversations: {
    indexes: { GSI1: { hashKey: "providerMessageId" }, GSI2: { hashKey: "counterpartKey", rangeKey: "sentAtSim" } },
    ttl: true,
  },
  // Append-only decisions. GSI1: trail of an operation; GSI2: decisions of a firm by kind.
  AuditLog: {
    indexes: { GSI1: { hashKey: "opKey", rangeKey: "ts" }, GSI2: { hashKey: "decisionKey", rangeKey: "ts" } },
    ttl: true,
  },
  // Holidays, templates, rate card, glossaries, observation codes, evaluation truth, name checks.
  Reference: { indexes: {}, ttl: false },
  // Ephemeral state (sessions, turns, nonces, links, clocks, counters, leases, pendings, probes).
  Runtime: { indexes: {}, ttl: true },
  // Dossier KPIs per world or batch.
  LegajoMetrics: { indexes: {}, ttl: true },
  // Leads of the public signup, outside the demo (ADR-0015 §6): `EMAIL#<emailHash>`/`LEAD`,
  // `SIGNUP#<signupId>`/`PENDING` (TTL 24 h) and `DELETED#<leadId>`/`TOMB`. No GSI: every read is by key.
  Leads: { indexes: {}, ttl: true },
} as const satisfies Record<StorageTable, TableSpec>;

/** Attribute definitions of a table: its primary key and the keys of its GSIs, all strings. */
export function tableFields(spec: TableSpec): Record<string, "string"> {
  const fields: Record<string, "string"> = { [PRIMARY_KEY.hashKey]: "string", [PRIMARY_KEY.rangeKey]: "string" };
  for (const index of Object.values(spec.indexes)) {
    fields[index.hashKey] = "string";
    if (index.rangeKey !== undefined) fields[index.rangeKey] = "string";
  }
  return fields;
}

// ---- S3 ----------------------------------------------------------------------------------------

/** Prefix of every key a QA world writes (docs/architecture.md §6); the QaDriver deletes only there. */
export const QA_PREFIX = "qa/";
export const QA_RETENTION_DAYS = 2;

/**
 * Prefix of every key a public guest world writes in `Documents` and `Media` (ADR-0015 §4,
 * packages/shared/src/document-keys.ts). `destroyWorld` deletes it; the lifecycle rule is the backstop:
 * the longest TTL of a public world (72 h) plus a margin.
 */
export const GUEST_PUBLIC_PREFIX = "guest/pub/";
export const GUEST_PUBLIC_RETENTION_DAYS = 4;
export const ABORT_MULTIPART_AFTER_DAYS = 7;

/**
 * How a bucket is named. `sst`: SST's own name under the bucket prefix the CI role is fenced to.
 * `browser`: fixed name the console's CSP allows (ci-spec.ts `browserBucketName`). `inbound-mail`:
 * fixed name the receipt rules write to (ci-spec.ts `inboundMailBucketName`).
 */
export type BucketNaming = { readonly kind: "sst" } | { readonly kind: "browser"; readonly purpose: BrowserBucket } | { readonly kind: "inbound-mail" };

export interface BucketSpec {
  readonly naming: BucketNaming;
  /** Static start of every key layout of docs/architecture.md §6 (the code builds the rest). */
  readonly prefixes: readonly string[];
  /** Every object expires after this many days; omitted = kept for the life of the stage. */
  readonly expireAfterDays?: number;
  /** Objects under `qa/` expire after this many days (where the bucket keeps them longer). */
  readonly qaExpireAfterDays?: number;
  /** Objects of public guest worlds (`guest/pub/`) expire after this many days, as a backstop of `destroyWorld`. */
  readonly guestPublicExpireAfterDays?: number;
  /** The browser POSTs to it with a presigned form from the console origin (CORS). */
  readonly browserUploads: boolean;
}

export interface InboundMailRoute {
  /** Receipt rule of the active rule set (docs/architecture.md §2). */
  readonly rule: string;
  /** Key prefix the rule writes under, and the only one its Lambda may read. */
  readonly prefix: string;
}

/** Receipt rules of a stage and where each one stores the raw MIME (docs/architecture.md §2). */
export function inboundMailRoutes(stage: string): InboundMailRoute[] {
  return [
    { rule: `ops-${stage}`, prefix: `${stage}/ops/` },
    { rule: `sim-${stage}`, prefix: `${stage}/sim/` },
  ];
}

export const BUCKET_SPECS = {
  Documents: {
    naming: { kind: "sst" },
    prefixes: ["ops/", "quarantine/", "unrecognized/"],
    qaExpireAfterDays: QA_RETENTION_DAYS,
    guestPublicExpireAfterDays: GUEST_PUBLIC_RETENTION_DAYS,
    browserUploads: false,
  },
  Uploads: { naming: { kind: "browser", purpose: "uploads" }, prefixes: ["uploads/"], expireAfterDays: 1, browserUploads: true },
  Media: {
    naming: { kind: "browser", purpose: "media" },
    prefixes: ["wa/", "sim/"],
    expireAfterDays: 90,
    qaExpireAfterDays: QA_RETENTION_DAYS,
    guestPublicExpireAfterDays: GUEST_PUBLIC_RETENTION_DAYS,
    browserUploads: true,
  },
  Seed: { naming: { kind: "sst" }, prefixes: ["pdfs/", "reader/", "metrics/", "worlds/"], browserUploads: false },
  InboundMail: {
    naming: { kind: "inbound-mail" },
    prefixes: inboundMailRoutes(CI_DEPLOY_STAGE).map((route) => route.prefix),
    expireAfterDays: 30,
    browserUploads: false,
  },
} as const satisfies Record<BucketName, BucketSpec>;

/** Buckets that receive files from outside (upload page, phone simulator, WhatsApp media): scanned. */
export const MALWARE_SCANNED_BUCKETS = ["Uploads", "Media"] as const satisfies readonly BucketName[];

export interface LifecycleRule {
  readonly id: string;
  readonly status: "Enabled";
  readonly filter: { readonly prefix?: string };
  readonly expiration?: { readonly days: number };
  readonly abortIncompleteMultipartUpload?: { readonly daysAfterInitiation: number };
}

/** Lifecycle of a bucket. Where two expirations overlap, S3 applies the earlier one. */
export function lifecycleRules(spec: BucketSpec): LifecycleRule[] {
  const rules: LifecycleRule[] = [
    { id: "abort-incomplete-multipart", status: "Enabled", filter: {}, abortIncompleteMultipartUpload: { daysAfterInitiation: ABORT_MULTIPART_AFTER_DAYS } },
  ];
  if (spec.expireAfterDays !== undefined) rules.push({ id: "expire", status: "Enabled", filter: {}, expiration: { days: spec.expireAfterDays } });
  if (spec.qaExpireAfterDays !== undefined) {
    rules.push({ id: "expire-qa", status: "Enabled", filter: { prefix: QA_PREFIX }, expiration: { days: spec.qaExpireAfterDays } });
  }
  if (spec.guestPublicExpireAfterDays !== undefined) {
    rules.push({ id: "expire-guest-pub", status: "Enabled", filter: { prefix: GUEST_PUBLIC_PREFIX }, expiration: { days: spec.guestPublicExpireAfterDays } });
  }
  return rules;
}

export interface BrowserUploadCors {
  readonly allowOrigins: string[];
  readonly allowMethods: Array<"POST">;
  readonly allowHeaders: string[];
  readonly exposeHeaders: string[];
  readonly maxAgeSeconds: number;
}

/**
 * CORS of the buckets the browser POSTs to (docs/architecture.md §6): the upload page and the phone
 * simulator upload with `fetch` to show progress. Only the console origin, only POST.
 */
export function browserUploadCors(appOrigin: string): BrowserUploadCors {
  return { allowOrigins: [appOrigin], allowMethods: ["POST"], allowHeaders: ["*"], exposeHeaders: [], maxAgeSeconds: 300 };
}

// ---- Inbound mail bucket: SES delivery ---------------------------------------------------------

export const SES_PRINCIPAL = "ses.amazonaws.com";

/** The one receipt rule set of the account this app activates (docs/architecture.md §1). */
export function inboundRuleSetName(app: string): string {
  return `${app}-inbound`;
}

export function receiptRuleArn(region: string, accountId: string, app: string, rule: string): string {
  return `arn:aws:ses:${region}:${accountId}:receipt-rule-set/${inboundRuleSetName(app)}:receipt-rule/${rule}`;
}

export interface SesDeliveryStatement {
  readonly actions: string[];
  readonly principals: Array<{ type: "service"; identifiers: string[] }>;
  readonly paths: string[];
  readonly conditions: Array<{ test: string; variable: string; values: string[] }>;
}

/**
 * Statements of the mail bucket policy that let SES store received mail (docs/architecture.md §14,
 * "Políticas de recurso"): one per receipt rule, each only under its own prefix and only on behalf of
 * that rule of this account (anti confused deputy).
 */
export function sesDeliveryStatements(scope: { app: string; stage: string; region: string; accountId: string }): SesDeliveryStatement[] {
  return inboundMailRoutes(scope.stage).map((route) => ({
    actions: ["s3:PutObject"],
    principals: [{ type: "service", identifiers: [SES_PRINCIPAL] }],
    paths: [`${route.prefix}*`],
    conditions: [
      { test: "StringEquals", variable: "aws:SourceAccount", values: [scope.accountId] },
      { test: "StringEquals", variable: "aws:SourceArn", values: [receiptRuleArn(scope.region, scope.accountId, scope.app, route.rule)] },
    ],
  }));
}

// ---- GuardDuty Malware Protection for S3 (infra/malware.ts) ------------------------------------

export const MALWARE_SCAN_PRINCIPAL = "malware-protection-plan.guardduty.amazonaws.com";
/** EventBridge managed rule GuardDuty creates on the default bus for each protected bucket. */
export const MALWARE_MANAGED_RULE_PREFIX = "DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3";
/** Object GuardDuty writes at the bucket root to validate its permissions. */
export const MALWARE_VALIDATION_OBJECT = "malware-protection-resource-validation-object";
/** Tag GuardDuty puts on every scanned object; DocumentIntake reads it (`s3:GetObjectTagging`). */
export const MALWARE_SCAN_TAG = "GuardDutyMalwareScanStatus";
/** `scanResultStatus` values; only `NO_THREATS_FOUND` continues to the intake. */
export const MALWARE_SCAN_RESULTS = ["NO_THREATS_FOUND", "THREATS_FOUND", "UNSUPPORTED", "ACCESS_DENIED", "FAILED"] as const;
/** Scan result event, published by GuardDuty on the account's default bus. */
export const MALWARE_SCAN_EVENT = { source: "aws.guardduty", detailType: "GuardDuty Malware Protection Object Scan Result" } as const;

export interface PolicyStatement {
  readonly Sid: string;
  readonly Effect: "Allow";
  readonly Action: string[];
  readonly Resource: string[];
  readonly Condition?: Record<string, Record<string, string>>;
}

export interface PolicyDocument {
  readonly Version: "2012-10-17";
  readonly Statement: PolicyStatement[];
}

export const MALWARE_SCAN_TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: MALWARE_SCAN_PRINCIPAL }, Action: "sts:AssumeRole" }],
} as const;

/**
 * Permissions of the role GuardDuty assumes to scan the protected buckets: the template of the
 * GuardDuty user guide ("Create or update IAM role policy"), fenced to exactly these buckets and the
 * managed rule. No KMS statement: the buckets use SSE-S3.
 */
export function malwareScanRolePolicy(scope: { region: string; accountId: string; bucketNames: readonly string[] }): PolicyDocument {
  const rule = `arn:aws:events:${scope.region}:${scope.accountId}:rule/${MALWARE_MANAGED_RULE_PREFIX}*`;
  const buckets = scope.bucketNames.map((name) => `arn:aws:s3:::${name}`);
  const objects = buckets.map((arn) => `${arn}/*`);
  const allow = (Sid: string, Action: string[], Resource: string[]): PolicyStatement => ({ Sid, Effect: "Allow", Action, Resource });
  return {
    Version: "2012-10-17",
    Statement: [
      {
        ...allow("ManagedRuleForBucketEvents", ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"], [rule]),
        Condition: { StringLike: { "events:ManagedBy": MALWARE_SCAN_PRINCIPAL } },
      },
      allow("MonitorManagedRule", ["events:DescribeRule", "events:ListTargetsByRule"], [rule]),
      allow("PostScanTag", ["s3:PutObjectTagging", "s3:GetObjectTagging", "s3:PutObjectVersionTagging", "s3:GetObjectVersionTagging"], objects),
      allow("EnableBucketEvents", ["s3:PutBucketNotification", "s3:GetBucketNotification"], buckets),
      allow("PutValidationObject", ["s3:PutObject"], buckets.map((arn) => `${arn}/${MALWARE_VALIDATION_OBJECT}`)),
      allow("CheckBucketOwnership", ["s3:ListBucket"], buckets),
      allow("ScanObjects", ["s3:GetObject", "s3:GetObjectVersion"], objects),
    ],
  };
}

/**
 * Event pattern of the scan results of the protected buckets, for the rule that triggers
 * DocumentIntake (infra/operations.ts, WP-24). No filter by result: DocumentIntake also handles
 * `THREATS_FOUND` (quarantine and audit) and treats every other status as not clean.
 */
export function malwareScanEventPattern(bucketNames: readonly string[]): Record<string, unknown> {
  return {
    source: [MALWARE_SCAN_EVENT.source],
    "detail-type": [MALWARE_SCAN_EVENT.detailType],
    detail: { s3ObjectDetails: { bucketName: [...bucketNames] } },
  };
}

// ---- Storage per Lambda ------------------------------------------------------------------------

/** Buckets a function reaches, its capabilities included (iam-capabilities.ts). */
export function expectedBuckets(fn: LambdaName): BucketName[] {
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  const names = new Set<BucketName>(Object.keys(entry.buckets ?? {}) as BucketName[]);
  for (const capability of resolveCapabilities(entry.capabilities)) {
    for (const name of Object.keys(CAPABILITIES[capability].buckets ?? {}) as BucketName[]) names.add(name);
  }
  return [...names].sort();
}

export interface StorageNeeds {
  /** Tables of this module to link. */
  readonly tables: LinkedTable[];
  /** Tables of this module reached only through a name-only Linkable and a fenced statement. */
  readonly fencedTables: FencedTable[];
  /** Tables of the mocks (infra/mocks.ts) the caller links on its own. */
  readonly mockTables: MockTable[];
  readonly buckets: BucketName[];
}

const isMockTable = (name: TableName): name is MockTable => (MOCK_TABLES as readonly TableName[]).includes(name);
const isFencedTable = (name: TableName): name is FencedTable => (FENCED_TABLES as readonly TableName[]).includes(name);

/** What a function links from storage, exactly as iam-capabilities.ts declares it. */
export function storageFor(fn: LambdaName): StorageNeeds {
  const tables = (Object.keys(expectedTables(fn)) as TableName[]).sort();
  return {
    tables: tables.filter((name): name is LinkedTable => !isMockTable(name) && !isFencedTable(name)),
    fencedTables: tables.filter(isFencedTable),
    mockTables: tables.filter(isMockTable),
    buckets: expectedBuckets(fn),
  };
}
