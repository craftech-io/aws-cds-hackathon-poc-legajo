// The storage spec (storage-keys.ts) against docs/architecture.md §1, §2, §5 and §6, the CI bootstrap
// (infra/bootstrap/ci-role.yaml) and the capabilities of every Lambda (iam-capabilities.ts). The tables
// and buckets are built from this spec, so a table that drifts from §5 or a bucket that loses its
// lifecycle or gains a CORS rule fails here, before any deploy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { block, statementsOf, template } from "./bootstrap/template-text";
import { BROWSER_BUCKETS, CONSOLE_CSP, bucketPrefix, browserBucketName, inboundMailBucketName } from "./ci-spec";
import { LAMBDA_CAPABILITIES, expectedTables, type BucketName, type LambdaName } from "./iam-capabilities";
import {
  ABORT_MULTIPART_AFTER_DAYS,
  BUCKET_SPECS,
  MALWARE_MANAGED_RULE_PREFIX,
  MALWARE_SCANNED_BUCKETS,
  MALWARE_SCAN_EVENT,
  MALWARE_SCAN_PRINCIPAL,
  MALWARE_SCAN_RESULTS,
  MALWARE_SCAN_TRUST_POLICY,
  MOCK_TABLES,
  PRIMARY_KEY,
  QA_PREFIX,
  QA_RETENTION_DAYS,
  TABLE_SPECS,
  TTL_ATTRIBUTE,
  browserUploadCors,
  inboundMailRoutes,
  inboundRuleSetName,
  lifecycleRules,
  malwareScanEventPattern,
  malwareScanRolePolicy,
  sesDeliveryStatements,
  storageFor,
  tableFields,
  type BucketNaming,
  type BucketSpec,
  type IndexSpec,
  type StorageTable,
} from "./storage-keys";

const APP = "aws-cds-hackathon-poc-legajo";
const STAGE = "poc";
const ACCOUNT = "776805327629";
const REGION = "us-east-1";
const APP_ORIGIN = "https://legajo.demo.craftech.io";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const infraSource = (file: string): string => read(`infra/${file}`);

function section(start: string, end: string): string {
  return architecture.slice(architecture.indexOf(start), architecture.indexOf(end));
}

/** Cells of every markdown table row of a section whose first cell is a code literal. */
function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim()));
}

const TABLES = Object.keys(TABLE_SPECS) as StorageTable[];
const BUCKETS = Object.keys(BUCKET_SPECS) as BucketName[];
const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];
const spec = (name: BucketName): BucketSpec => BUCKET_SPECS[name];

// ---- §5 -------------------------------------------------------------------------------------------

/** GSIs and TTL of every table of §5: `GSIn` `hashKey` … + `rangeKey`; TTL "—" means none. */
function documentedTables(): Map<string, { indexes: Record<string, IndexSpec>; ttl: boolean }> {
  const tables = new Map<string, { indexes: Record<string, IndexSpec>; ttl: boolean }>();
  for (const [first = "", , , , gsis = "", ttl = ""] of rows(section("## 5. DynamoDB", "## 6. S3"))) {
    const name = /^`(\w+)`$/.exec(first)?.[1];
    if (!name) continue;
    const indexes: Record<string, IndexSpec> = {};
    for (const part of gsis.split(/(?=`GSI\d`)/)) {
      const head = /^`(GSI\d)` `(\w+)`/.exec(part);
      if (!head?.[1] || !head[2]) continue;
      const rangeKey = /\+ `(\w+)`/.exec(part)?.[1];
      indexes[head[1]] = rangeKey ? { hashKey: head[2], rangeKey } : { hashKey: head[2] };
    }
    tables.set(name, { indexes, ttl: ttl !== "—" });
  }
  return tables;
}

describe("DynamoDB tables of docs/architecture.md §5", () => {
  const documented = documentedTables();

  it("declares every table of §5 except the two the mocks own", () => {
    expect(documented.size).toBe(10);
    expect([...TABLES, ...MOCK_TABLES].sort()).toEqual([...documented.keys()].sort());
  });

  it.each(TABLES)("keeps the GSIs and the TTL of %s exactly as §5", (name) => {
    expect(TABLE_SPECS[name].indexes).toEqual(documented.get(name)?.indexes);
    expect(TABLE_SPECS[name].ttl).toBe(documented.get(name)?.ttl);
  });

  it("keys every table by PK and SK and expires items by expiresAt, Parties included", () => {
    expect(PRIMARY_KEY).toEqual({ hashKey: "PK", rangeKey: "SK" });
    expect(TTL_ATTRIBUTE).toBe("expiresAt");
    expect(section("## 5. DynamoDB", "## 6. S3")).toContain("`world` y `expiresAt` (TTL)");
    expect(TABLE_SPECS.Parties.ttl).toBe(true);
    expect(TABLES.filter((name) => !TABLE_SPECS[name].ttl)).toEqual(["Reference"]);
  });

  it("declares only key attributes, all strings (DynamoDB rejects an unindexed definition)", () => {
    expect(tableFields(TABLE_SPECS.Operations)).toEqual({
      PK: "string",
      SK: "string",
      firmStatusKey: "string",
      etaSort: "string",
      threadKey: "string",
      clockDueKey: "string",
      dueAtSim: "string",
    });
    expect(tableFields(TABLE_SPECS.Runtime)).toEqual({ PK: "string", SK: "string" });
  });

  it("creates one component per table of the spec, under its logical name", () => {
    const created = [...infraSource("storage-tables.ts").matchAll(/\btable\("([A-Za-z]+)"\)/g)].map((match) => match[1]);
    expect(created.sort()).toEqual([...TABLES].sort());
  });
});

// ---- §6 -------------------------------------------------------------------------------------------

/** Static part of a documented key (`ops/<operationId>/…` → `ops/`). */
function staticPrefix(key: string): string {
  const head = key.includes("<") ? key.slice(0, key.indexOf("<")) : key;
  return head.slice(0, head.lastIndexOf("/") + 1);
}

function documentedBuckets(): Map<string, { prefixes: string[]; expire?: number; qaExpire?: number }> {
  const buckets = new Map<string, { prefixes: string[]; expire?: number; qaExpire?: number }>();
  for (const [first = "", layout = "", , retention = ""] of rows(section("## 6. S3", "## 7."))) {
    const literal = /^`([^`]+)`/.exec(first)?.[1] ?? "";
    const name = literal === inboundMailBucketName(APP, ACCOUNT) ? "InboundMail" : literal;
    const prefixes = [...layout.replace(/\([^)]*\)/g, "").matchAll(/`([^`]*\/[^`]*)`/g)].map((match) => staticPrefix(match[1] ?? ""));
    const expire = /^(\d+) días?/.exec(retention)?.[1];
    const qaExpire = /`qa\/` (\d+) días?/.exec(retention)?.[1];
    buckets.set(name, {
      prefixes,
      ...(expire ? { expire: Number(expire) } : {}),
      ...(qaExpire ? { qaExpire: Number(qaExpire) } : {}),
    });
  }
  return buckets;
}

describe("S3 buckets of docs/architecture.md §6", () => {
  const documented = documentedBuckets();

  it("declares every bucket of §6, the Ingress mail bucket as InboundMail", () => {
    expect([...documented.keys()].sort()).toEqual([...BUCKETS].sort());
  });

  it.each(BUCKETS)("keeps the retention of %s as §6 states it", (name) => {
    const doc = documented.get(name);
    expect(spec(name).expireAfterDays).toBe(doc?.expire);
    if (doc?.qaExpire !== undefined) expect(spec(name).qaExpireAfterDays).toBe(doc.qaExpire);
  });

  it.each(BUCKETS)("keeps the key layout of %s as §6 states it", (name) => {
    const documentedPrefixes = documented.get(name)?.prefixes ?? [];
    expect(documentedPrefixes.length).toBeGreaterThan(0);
    for (const key of documentedPrefixes) expect(spec(name).prefixes.some((prefix) => key.startsWith(prefix)), key).toBe(true);
    for (const prefix of spec(name).prefixes) expect(documentedPrefixes.some((key) => key.startsWith(prefix)), prefix).toBe(true);
  });

  it("aborts incomplete multipart uploads in every bucket and never reuses a rule id", () => {
    for (const name of BUCKETS) {
      const rules = lifecycleRules(spec(name));
      expect(rules[0]).toEqual({
        id: "abort-incomplete-multipart",
        status: "Enabled",
        filter: {},
        abortIncompleteMultipartUpload: { daysAfterInitiation: ABORT_MULTIPART_AFTER_DAYS },
      });
      expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    }
  });

  it("expires qa/ within two days in every bucket the QA driver writes to", () => {
    const qaBuckets = Object.keys(LAMBDA_CAPABILITIES.QaDriver.buckets).filter((name) => name !== "InboundMail") as BucketName[];
    expect(qaBuckets.sort()).toEqual(["Documents", "Media", "Uploads"]);
    for (const name of qaBuckets) {
      const days = lifecycleRules(spec(name))
        .filter((rule) => rule.expiration !== undefined && (rule.filter.prefix === undefined || QA_PREFIX.startsWith(rule.filter.prefix)))
        .map((rule) => rule.expiration?.days ?? Infinity);
      expect(Math.min(...days), name).toBeLessThanOrEqual(QA_RETENTION_DAYS);
    }
    expect(lifecycleRules(spec("Documents")).find((rule) => rule.id === "expire-qa")?.filter).toEqual({ prefix: "qa/" });
    expect(lifecycleRules(spec("Seed")).map((rule) => rule.id)).toEqual(["abort-incomplete-multipart"]);
  });

  it("names buckets within the 16 characters the CI bucket fence allows, apart from the tables", () => {
    const created = [...infraSource("storage-buckets.ts").matchAll(/\bbucket\("([A-Za-z]+)"/g)].map((match) => match[1] ?? "");
    expect(created.sort()).toEqual([...BUCKETS].sort());
    for (const name of created) expect(name.length, name).toBeLessThanOrEqual(16);
    expect(created.filter((name) => (TABLES as string[]).includes(name))).toEqual([]);
  });

  it("gives the Ingress mail bucket its fixed name and the browser buckets the names the CSP allows", () => {
    expect(inboundMailBucketName(APP, ACCOUNT)).toBe("aws-cds-hackathon-poc-leg-inbound-mail-776805327629");
    const namings = BUCKETS.map((name) => [name, spec(name).naming] as const);
    expect(namings.filter(([, naming]) => naming.kind === "inbound-mail").map(([name]) => name)).toEqual(["InboundMail"]);
    const purposes = namings.flatMap(([, naming]: readonly [BucketName, BucketNaming]) => (naming.kind === "browser" ? [naming.purpose] : []));
    expect(purposes.sort()).toEqual([...BROWSER_BUCKETS].sort());
    for (const purpose of purposes) {
      expect(browserBucketName(APP, STAGE, purpose, ACCOUNT).startsWith(bucketPrefix(APP))).toBe(true);
      expect(CONSOLE_CSP).toContain(`-${purpose}-\${AWS::AccountId}.s3.`);
    }
    const source = infraSource("storage-buckets.ts");
    expect(source).toContain("browserBucketName($app.name, $app.stage, naming.purpose, account)");
    expect(source).toContain("inboundMailBucketName($app.name, account)");
  });

  it("keeps every bucket private and HTTPS-only (SST's defaults, never switched off)", () => {
    const source = infraSource("storage-buckets.ts");
    expect(source).not.toMatch(/enforceHttps|access:|public:|publicAccessBlock/);
    expect(source).toContain('sseAlgorithm: "AES256"');
  });
});

describe("CORS of the buckets the browser uploads to", () => {
  const cors = section("## 6. S3", "## 7.")
    .split("\n")
    .find((line) => line.startsWith("- **CORS**"));

  it("allows only POST from the console origin, as §6 states", () => {
    expect(browserUploadCors(APP_ORIGIN)).toEqual({
      allowOrigins: [APP_ORIGIN],
      allowMethods: ["POST"],
      allowHeaders: ["*"],
      exposeHeaders: [],
      maxAgeSeconds: 300,
    });
    for (const text of [`\`AllowedOrigins = ${APP_ORIGIN}\``, "`AllowedMethods POST`", "`AllowedHeaders *`", "`MaxAge 300`"]) expect(cors).toContain(text);
  });

  it("puts a rule only on Uploads and Media, the buckets named for the CSP; the rest get none", () => {
    expect(cors).toContain("en `Uploads` y `Media`");
    expect(BUCKETS.filter((name) => spec(name).browserUploads)).toEqual(["Uploads", "Media"]);
    for (const name of BUCKETS) expect(spec(name).browserUploads).toBe(spec(name).naming.kind === "browser");
    // SST's default CORS rule allows every origin and method: every other bucket must get `false`.
    expect(infraSource("storage-buckets.ts")).toMatch(/if \(!spec\.browserUploads\) return false;/);
  });
});

// ---- §1, §2 and §14: SES delivery into the mail bucket -------------------------------------------

describe("inbound mail bucket policy", () => {
  const statements = sesDeliveryStatements({ app: APP, stage: STAGE, region: REGION, accountId: ACCOUNT });

  it("lets SES write each receipt rule's mail only under that rule's prefix of §2", () => {
    const rules = rows(section("## 2. Stage", "## 3."));
    expect(architecture).toContain(`\`${inboundRuleSetName(APP)}\``);
    for (const route of inboundMailRoutes(STAGE)) {
      const row = rules.find(([rule]) => rule === `\`${route.rule}\``);
      expect(row?.[2], route.rule).toContain(`/${route.prefix}\``);
    }
    expect(statements.map((statement) => statement.paths)).toEqual([["poc/ops/*"], ["poc/sim/*"]]);
    expect(BUCKET_SPECS.InboundMail.prefixes).toEqual(["poc/ops/", "poc/sim/"]);
  });

  it("trusts only the SES service, only PutObject, and only for a rule of this app in this account", () => {
    for (const [index, statement] of statements.entries()) {
      const rule = inboundMailRoutes(STAGE)[index]?.rule ?? "";
      expect(statement.actions).toEqual(["s3:PutObject"]);
      expect(statement.principals).toEqual([{ type: "service", identifiers: ["ses.amazonaws.com"] }]);
      expect(statement.conditions).toEqual([
        { test: "StringEquals", variable: "aws:SourceAccount", values: [ACCOUNT] },
        {
          test: "StringEquals",
          variable: "aws:SourceArn",
          values: [`arn:aws:ses:${REGION}:${ACCOUNT}:receipt-rule-set/aws-cds-hackathon-poc-legajo-inbound:receipt-rule/${rule}`],
        },
      ]);
    }
    expect(template).toContain(`receipt-rule-set/${inboundRuleSetName("${AppName}")}`);
  });
});

// ---- GuardDuty Malware Protection for S3 ----------------------------------------------------------

describe("malware scanning of Uploads and Media", () => {
  const names = ["upload-bucket", "media-bucket"];
  const policy = malwareScanRolePolicy({ region: REGION, accountId: ACCOUNT, bucketNames: names });
  const rule = `arn:aws:events:${REGION}:${ACCOUNT}:rule/${MALWARE_MANAGED_RULE_PREFIX}*`;
  const actions = policy.Statement.flatMap((statement) => statement.Action);

  it("scans the buckets §6 names, every one the browser uploads to among them", () => {
    expect(section("## 6. S3", "## 7.")).toContain("(`aws.guardduty.MalwareProtectionPlan`, con su rol) sobre `Uploads` y `Media`");
    expect([...MALWARE_SCANNED_BUCKETS]).toEqual(["Uploads", "Media"]);
    for (const name of BUCKETS.filter((bucket) => spec(bucket).browserUploads)) expect(MALWARE_SCANNED_BUCKETS).toContain(name);
    const malware = infraSource("malware.ts");
    expect(malware).toContain('actions: [{ taggings: [{ status: "ENABLED" }] }]');
    expect(malware).not.toContain("objectPrefixes");
  });

  it("lets only GuardDuty's malware protection assume the scan role", () => {
    expect(MALWARE_SCAN_TRUST_POLICY.Statement).toEqual([
      { Effect: "Allow", Principal: { Service: "malware-protection-plan.guardduty.amazonaws.com" }, Action: "sts:AssumeRole" },
    ]);
    expect(MALWARE_SCAN_PRINCIPAL).toBe("malware-protection-plan.guardduty.amazonaws.com");
  });

  it("grants the scan role exactly the user guide's actions, and nothing KMS (SSE-S3 buckets)", () => {
    const events = ["DeleteRule", "DescribeRule", "ListTargetsByRule", "PutRule", "PutTargets", "RemoveTargets"].map((name) => `events:${name}`);
    const s3 = ["GetBucketNotification", "PutBucketNotification", "ListBucket", "GetObject", "GetObjectVersion", "PutObject"].map((name) => `s3:${name}`);
    const tagging = ["GetObjectTagging", "GetObjectVersionTagging", "PutObjectTagging", "PutObjectVersionTagging"].map((name) => `s3:${name}`);
    expect([...actions].sort()).toEqual([...events, ...s3, ...tagging].sort());
  });

  it("fences the scan role to the two buckets and GuardDuty's managed rule", () => {
    for (const statement of policy.Statement) {
      for (const resource of statement.Resource) {
        if (resource.startsWith("arn:aws:events:")) expect(resource).toBe(rule);
        else expect(names.some((name) => resource === `arn:aws:s3:::${name}` || resource.startsWith(`arn:aws:s3:::${name}/`)), resource).toBe(true);
      }
    }
    const putObject = policy.Statement.find((statement) => statement.Action.includes("s3:PutObject"));
    expect(putObject?.Resource).toEqual(names.map((name) => `arn:aws:s3:::${name}/malware-protection-resource-validation-object`));
    const managed = policy.Statement.find((statement) => statement.Action.includes("events:PutRule"));
    expect(managed?.Condition).toEqual({ StringLike: { "events:ManagedBy": MALWARE_SCAN_PRINCIPAL } });
  });

  it("stays inside the permissions boundary every role of the app carries", () => {
    const boundary = statementsOf(block(template, "  DeployBoundary:", "  DeploySstHomePolicy:"));
    const scanRule = boundary.find((statement) => statement.sid === "GuardDutyMalwareScanRule")?.body ?? "";
    expect(scanRule).toContain(`rule/${MALWARE_MANAGED_RULE_PREFIX}*`);
    for (const action of actions.filter((name) => name.startsWith("events:"))) expect(scanRule).toContain(`- ${action}`);
    const named = boundary.find((statement) => statement.sid === "NamedAppResources")?.body ?? "";
    expect(named).toContain("- s3:*");
    expect(named).toContain('s3:::${BucketPrefix}*"');
    expect(template).toContain("guardduty:CreateMalwareProtectionPlan");
  });

  it("hands DocumentIntake every scan result of both buckets, clean or not", () => {
    expect(malwareScanEventPattern(names)).toEqual({
      source: ["aws.guardduty"],
      "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
      detail: { s3ObjectDetails: { bucketName: names } },
    });
    expect(MALWARE_SCAN_EVENT.source).toBe("aws.guardduty");
    expect(MALWARE_SCAN_RESULTS).toContain("NO_THREATS_FOUND");
    expect(MALWARE_SCAN_RESULTS).toContain("THREATS_FOUND");
  });
});

// ---- Storage per Lambda ---------------------------------------------------------------------------

describe("storage each Lambda links", () => {
  it.each(LAMBDAS)("gives %s exactly the tables of its capabilities", (fn) => {
    const needs = storageFor(fn);
    expect([...needs.tables, ...needs.mockTables].sort()).toEqual(Object.keys(expectedTables(fn)).sort());
    for (const table of needs.mockTables) expect(MOCK_TABLES).toContain(table);
  });

  it("links every table and bucket of this module to at least one Lambda", () => {
    const linked = LAMBDAS.map(storageFor);
    for (const table of TABLES) expect(linked.some((needs) => needs.tables.includes(table)), table).toBe(true);
    for (const bucket of BUCKETS) expect(linked.some((needs) => needs.buckets.includes(bucket)), bucket).toBe(true);
  });

  it("adds the buckets a capability brings and keeps the mail bucket away from the console", () => {
    expect(storageFor("WorldJanitor")).toEqual({
      tables: ["AuditLog", "Conversations", "Firms", "LegajoMetrics", "Operations", "Parties", "Runtime"],
      mockTables: ["Platform"],
      buckets: ["Media", "Seed"],
    });
    const mailReaders = LAMBDAS.filter((fn) => storageFor(fn).buckets.includes("InboundMail"));
    expect(mailReaders.sort()).toEqual(["InboundEmail", "OperationWorker", "QaDriver", "SimMail"]);
    expect(storageFor("Bff").buckets).not.toContain("Uploads");
  });
});
