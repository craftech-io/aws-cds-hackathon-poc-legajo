// The two external products this POC simulates, each behind its own contract and its own table
// (docs/architecture.md §4, §5 and §14, docs/architecture-integrations.md §5 and §6, docs/build-plan.md
// WP-21):
//
//   ReaderMock     document reader (ADR-0003): OpenAPI 3.1 contract of packages/reader-contract, table
//                  `ReaderCatalog` (ground-truth readings, per-world faults, idempotency)
//   PlatformMock   customs management platform: operation master data, ETA and customs status, table
//                  `Platform` (`POP#<firmId>#<number>`), events published on the `Feeds` bus
//
// Both answer on a Function URL with AWS_IAM (SigV4): no browser and no anonymous caller reaches them.
// Since October 2025 such a URL needs two permissions on each side, and every caller gets both:
//
//   identity    the Linkable `ReaderMock` / `PlatformMock` (`Resource.<mock>.url`) includes
//               `lambda:InvokeFunctionUrl` with `lambda:FunctionUrlAuthType = AWS_IAM` and
//               `lambda:InvokeFunction`, on that function only. A caller links it with `mockLinks(fn)`.
//   resource    one pair of `aws.lambda.Permission` per calling role (principal = the role's ARN):
//               `InvokeFunctionUrl` with `functionUrlAuthType AWS_IAM` and `InvokeFunction` with
//               `invokedViaFunctionUrl`. The module that creates the caller calls
//               `grantMockInvoke(fn, created)` right after it.
//
// Callers come from infra/iam-capabilities.ts: every Lambda with MOCK_READER calls the reader
// (OperationWorker, ToolDocuments, QaDriver) and every one with MOCK_PLATFORM the platform (Bff,
// QaDriver); `grantMockInvoke` refuses any other.
//
// Tables. Keys `PK`/`SK`, no GSI, TTL `expiresAt` in epoch seconds (faults and idempotency of the
// reader expire in 48 h; platform rows of QA and guest worlds with their world), DynamoDB's default
// encryption with an AWS owned key (docs/architecture.md §5, "SSE con claves de AWS"). `ReaderCatalog`
// is linked as it is. `Platform` is not: the world factory writes its rows directly with capability
// WORLDS, fenced per role by `dynamodb:LeadingKeys` (Bff, WorldJanitor, QaDriver), and a link to the
// table would grant `dynamodb:*` with no fence. So the table component is `PlatformData` and code
// reads `Resource.Platform.name` through a Linkable without permissions; `mockPermissions(fn)` adds
// exactly the statement each role needs (`PlatformMock`: the commands of its store; a WORLDS role:
// the world factory's commands under its leading keys).
//
// `ReaderMockConfig` tells the reader which bucket its pre-signed source URLs must come from
// (`Documents`); the reader holds no S3 permission of its own.
//
// Cost: per request and per item; nothing bills while no document is read and no platform call runs.
//
// Verify:
//   aws --profile craftech-demos lambda get-function-url-config --function-name <ReaderMockApi or PlatformMockApi name>
//     → AuthType AWS_IAM, no Cors
//   aws --profile craftech-demos lambda get-policy --function-name <same>
//     → per calling role: InvokeFunctionUrl (lambda:FunctionUrlAuthType AWS_IAM) and InvokeFunction (lambda:InvokedViaFunctionUrl true)
//   aws --profile craftech-demos dynamodb describe-time-to-live --table-name <ReaderCatalog or PlatformData name> → expiresAt ENABLED

import { Feeds } from "./feeds";
import {
  LAMBDA_CAPABILITIES,
  WORLDS_LEADING_KEYS,
  expectedTables,
  resolveCapabilities,
  type CapabilityName,
  type LambdaName,
  type WorldsRole,
} from "./iam-capabilities";
import { documentsBucket } from "./storage";
import { PRIMARY_KEY, TTL_ATTRIBUTE, tableFields, type MockTable, type TableSpec } from "./storage-keys";

type PermissionStatement = Parameters<typeof sst.aws.permission>[0];

export const MOCK_NAMES = ["ReaderMock", "PlatformMock"] as const;
export type MockName = (typeof MOCK_NAMES)[number];

/** Capability that lets a Lambda call each mock (infra/iam-capabilities.ts). */
export const MOCK_CAPABILITY = { ReaderMock: "MOCK_READER", PlatformMock: "MOCK_PLATFORM" } as const satisfies Record<MockName, CapabilityName>;

/** Lambda entries; the paths are the contract with packages/reader-mock and packages/platform-mock. */
export const MOCK_HANDLERS = {
  ReaderMock: "packages/reader-mock/src/handler.handler",
  PlatformMock: "packages/platform-mock/src/handler.handler",
} as const satisfies Record<MockName, string>;

/** Keys, indexes and TTL of the mocks' tables (docs/architecture.md §5). */
export const MOCK_TABLE_SPECS = {
  ReaderCatalog: { indexes: {}, ttl: true },
  Platform: { indexes: {}, ttl: true },
} as const satisfies Record<MockTable, TableSpec>;

export const FUNCTION_URL_AUTH_TYPE = "AWS_IAM";

/** Identity side of calling a mock: both actions a Function URL with AWS_IAM requires. */
export function mockInvokeStatements(functionArn: $util.Input<string>): PermissionStatement[] {
  return [
    {
      actions: ["lambda:InvokeFunctionUrl"],
      resources: [functionArn],
      conditions: [{ test: "StringEquals", variable: "lambda:FunctionUrlAuthType", values: [FUNCTION_URL_AUTH_TYPE] }],
    },
    { actions: ["lambda:InvokeFunction"], resources: [functionArn] },
  ];
}

export interface ResourcePermissionSpec {
  readonly suffix: "Url" | "Invoke";
  readonly action: "lambda:InvokeFunctionUrl" | "lambda:InvokeFunction";
  readonly functionUrlAuthType?: typeof FUNCTION_URL_AUTH_TYPE;
  readonly invokedViaFunctionUrl?: true;
}

/** Resource side of calling a mock: the pair each calling role gets on the mock's function. */
export const MOCK_RESOURCE_PERMISSIONS: readonly ResourcePermissionSpec[] = [
  { suffix: "Url", action: "lambda:InvokeFunctionUrl", functionUrlAuthType: FUNCTION_URL_AUTH_TYPE },
  { suffix: "Invoke", action: "lambda:InvokeFunction", invokedViaFunctionUrl: true },
];

const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];

/** Mocks a Lambda calls, from its capabilities. */
export function mocksCalledBy(fn: LambdaName): MockName[] {
  const held = resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities);
  return MOCK_NAMES.filter((mock) => held.includes(MOCK_CAPABILITY[mock]));
}

/** Lambdas that call a mock (docs/architecture.md §14, "Políticas de recurso"). */
export function mockInvokers(mock: MockName): LambdaName[] {
  return LAMBDAS.filter((fn) => mocksCalledBy(fn).includes(mock)).sort();
}

/** Commands of packages/platform-mock/src/dynamo-store.ts (its transaction is authorised per item as Put and Update). */
export const PLATFORM_MOCK_TABLE_ACTIONS = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"] as const;

/** The world factory on `Platform` (capability WORLDS, docs/architecture.md §14). */
export const WORLDS_PLATFORM_ACTIONS = [
  "dynamodb:BatchWriteItem",
  "dynamodb:DeleteItem",
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:Query",
  "dynamodb:UpdateItem",
] as const;

const isWorldsRole = (fn: LambdaName): fn is WorldsRole => Object.hasOwn(WORLDS_LEADING_KEYS, fn);

/** Statements on `Platform` for a Lambda that reaches it; the table is never granted through a link. */
export function platformTableStatements(fn: LambdaName, tableArn: $util.Input<string>): PermissionStatement[] {
  if (!("Platform" in expectedTables(fn))) return [];
  if (fn === "PlatformMock") return [{ actions: [...PLATFORM_MOCK_TABLE_ACTIONS], resources: [tableArn] }];
  if (isWorldsRole(fn)) {
    return [
      {
        actions: [...WORLDS_PLATFORM_ACTIONS],
        resources: [tableArn],
        conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...WORLDS_LEADING_KEYS[fn]] }],
      },
    ];
  }
  throw new Error(`infra/iam-capabilities.ts gives ${fn} the Platform table, but only PlatformMock and the WORLDS roles have a statement for it.`);
}

function mockTable(name: string, spec: TableSpec): sst.aws.Dynamo {
  return new sst.aws.Dynamo(name, {
    fields: tableFields(spec),
    primaryIndex: PRIMARY_KEY,
    ttl: spec.ttl ? TTL_ATTRIBUTE : undefined,
  });
}

export const readerCatalog = mockTable("ReaderCatalog", MOCK_TABLE_SPECS.ReaderCatalog);
export const platformTable = mockTable("PlatformData", MOCK_TABLE_SPECS.Platform);

/** `Resource.Platform.name`, with no permission: each role gets its statement from `mockPermissions`. */
export const Platform = new sst.Linkable("Platform", { properties: { name: platformTable.name } });

/** `Resource.ReaderMockConfig.documentsBucket`: the only bucket the reader accepts source URLs from. */
export const ReaderMockConfig = new sst.Linkable("ReaderMockConfig", { properties: { documentsBucket: documentsBucket.name } });

const MOCK_TABLE_LINKS = { ReaderCatalog: readerCatalog, Platform } as const satisfies Record<MockTable, unknown>;

/** Mock tables a Lambda links, as infra/iam-capabilities.ts declares them. */
function mockTableLinks(fn: LambdaName): Array<sst.aws.Dynamo | typeof Platform> {
  const tables = Object.keys(expectedTables(fn)).filter((name): name is MockTable => Object.hasOwn(MOCK_TABLE_LINKS, name));
  return tables.sort().map((name) => MOCK_TABLE_LINKS[name]);
}

/** Statements a Lambda needs on the mocks' tables beyond its links (today only `Platform`). */
export function mockPermissions(fn: LambdaName): PermissionStatement[] {
  return platformTableStatements(fn, platformTable.arn);
}

export const readerMockApi = new sst.aws.Function("ReaderMockApi", {
  description: "Document reader mock (external product, OpenAPI contract): Function URL with AWS_IAM.",
  handler: MOCK_HANDLERS.ReaderMock,
  url: { authorization: "iam", cors: false },
  link: [...mockTableLinks("ReaderMock"), ReaderMockConfig],
  permissions: mockPermissions("ReaderMock"),
  // Longer than a TIMEOUT fault (10 s) plus the source download budget (5 s).
  timeout: "20 seconds",
  // Downloads and hashes PDFs of up to 10 MB and parses their metadata with a bounded parser.
  memory: "512 MB",
});

export const platformMockApi = new sst.aws.Function("PlatformMockApi", {
  description: "Customs platform mock (external product): Function URL with AWS_IAM; publishes to the Feeds bus.",
  handler: MOCK_HANDLERS.PlatformMock,
  url: { authorization: "iam", cors: false },
  link: [...mockTableLinks("PlatformMock"), Feeds],
  permissions: mockPermissions("PlatformMock"),
  timeout: "30 seconds",
  memory: "256 MB",
});

export const mockFunctions = { ReaderMock: readerMockApi, PlatformMock: platformMockApi } as const satisfies Record<MockName, sst.aws.Function>;

function mockLinkable(mock: MockName): sst.Linkable<{ url: $util.Output<string> }> {
  const target = mockFunctions[mock];
  return new sst.Linkable(mock, {
    properties: { url: target.url },
    include: mockInvokeStatements(target.arn).map((statement) => sst.aws.permission(statement)),
  });
}

/** `Resource.ReaderMock.url` plus both invoke permissions (capability MOCK_READER). */
export const ReaderMock = mockLinkable("ReaderMock");
/** `Resource.PlatformMock.url` plus both invoke permissions (capability MOCK_PLATFORM). */
export const PlatformMock = mockLinkable("PlatformMock");

const MOCK_LINKABLES = { ReaderMock, PlatformMock } as const satisfies Record<MockName, unknown>;

/** Everything of this module a Lambda links: the mocks it calls and the mock tables it reaches. */
export function mockLinks(fn: LambdaName): unknown[] {
  return [...mocksCalledBy(fn).map((mock) => MOCK_LINKABLES[mock]), ...mockTableLinks(fn)];
}

/**
 * Resource-policy side of calling the mocks: for each mock `fn` calls, the pair of
 * `aws.lambda.Permission` with the role of `created` as principal. Called by the module that creates
 * the caller, right after creating it; fails for a Lambda without MOCK_READER or MOCK_PLATFORM.
 */
export function grantMockInvoke(fn: LambdaName, created: sst.aws.Function): aws.lambda.Permission[] {
  const mocks = mocksCalledBy(fn);
  if (mocks.length === 0) throw new Error(`${fn} holds neither MOCK_READER nor MOCK_PLATFORM (infra/iam-capabilities.ts); it may not call a mock.`);
  return mocks.flatMap((mock) =>
    MOCK_RESOURCE_PERMISSIONS.map(
      (spec) =>
        new aws.lambda.Permission(`${mock}${spec.suffix}${fn}`, {
          action: spec.action,
          function: mockFunctions[mock].name,
          principal: created.nodes.role.arn,
          ...(spec.functionUrlAuthType === undefined ? {} : { functionUrlAuthType: spec.functionUrlAuthType }),
          ...(spec.invokedViaFunctionUrl === undefined ? {} : { invokedViaFunctionUrl: spec.invokedViaFunctionUrl }),
        }),
    ),
  );
}
