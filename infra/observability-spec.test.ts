// infra/observability-spec.ts against docs/architecture.md §12, ADR-0015 §9 and the code that writes the log lines;
// infra/bff.ts and infra/observability.ts as resources (§10-§14, ADR-0015 §3 and §6, WP-32), evaluated with a recording
// stand-in for the SST globals as infra/operations-spec.test.ts does; other modules carry exactly what their contracts promise.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PolicyAuditEvent } from "../packages/bff/src/handlers/policy-audit";
import { LAMBDA_CAPABILITIES, actionDrift, type LambdaName } from "./iam-capabilities";
import { LEADS_FUNCTIONS, cognitoStatement, leadsStatement, qaSignupMailStatements, signupRuntimeStatement } from "./leads-spec";
import { EMAIL_FUNCTIONS } from "./messaging-email-spec";
import { ALARMS, DOCUMENTED_METRICS, METRICS, METRIC_NAMESPACE, POLICY_AUDIT, PROJECT_BUDGET, RESERVED_CONCURRENCY, alarmQueries, budgetName, budgetNotifications, budgetSubscribers, metricFilterSpecs, type AlarmSpec } from "./observability-spec";
import { storageFor } from "./storage-keys";
import { EDGE_BUDGETS, LAMBDA_ROUTES } from "./web-spec";

const fake = vi.hoisted(() => {
  interface Meta { readonly type: string; readonly name: string }
  const recorded: Array<Meta & { readonly args: unknown }> = [];
  const [warnings, grants, signups] = [[], [], []] as [string[], string[], string[]];
  class Leaf { constructor(readonly meta: Meta) {} }
  class Out {
    constructor(readonly value: Promise<unknown>) {}
    apply = (fn: (value: unknown) => unknown): Out => new Out(this.value.then((value) => settle(fn(value))));
  }
  async function settle(value: unknown): Promise<unknown> {
    if (value instanceof Out) return settle(await value.value);
    if (value instanceof Promise) return settle(await value);
    if (Array.isArray(value)) return Promise.all(value.map(settle));
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await settle(entry)])));
    }
    return value;
  }
  const output = (value: unknown): Out => new Out(Promise.resolve(value));
  // A resource: `.meta` says what it is, `.nodes.logGroup` an Output of the group, any other `.nodes.<x>`
  // another resource, and any other property an Output that resolves to "<name>.<property>".
  function resource(type: string, name: string): object {
    const node = (key: string): unknown => (key === "logGroup" ? output(resource("aws.cloudwatch.LogGroup", `${name}.logGroup`)) : resource(`${type}.${key}`, `${name}.${key}`));
    return new Proxy(new Leaf({ type, name }), {
      get(target, prop) {
        if (prop === "meta") return target.meta;
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop === "nodes") return new Proxy({}, { get: (_nodes, key) => node(String(key)) });
        return output(`${name}.${prop}`);
      },
    });
  }
  const created = new Map<string, object>();
  const once = (type: string, name: string): object => created.get(`${type}|${name}`) ?? (created.set(`${type}|${name}`, resource(type, name)).get(`${type}|${name}`) as object);
  const fn = (name: string): object => once("sst.aws.Function", name);
  function linkable(name: string, actions: readonly string[] = []): object {
    const include = actions.length === 0 ? [] : [{ type: "aws.permission", actions: [...actions], resources: [`${name}.target`] }];
    if (!created.has(`sst.Linkable|${name}`)) recorded.push({ type: "sst.Linkable", name, args: { include } });
    return once("sst.Linkable", name);
  }
  function namespace(path: string): unknown {
    return new Proxy(function stub() {}, {
      get(_target, prop) {
        if (prop === Symbol.hasInstance) return (candidate: unknown) => candidate instanceof Leaf && candidate.meta.type === path;
        return typeof prop === "symbol" || prop === "then" ? undefined : namespace(`${path}.${prop}`);
      },
      construct: (_target, args: unknown[]) => (recorded.push({ type: path, name: String(args[0]), args: args[1] }), resource(path, String(args[0]))),
      apply(_target, _this, args: unknown[]) {
        if (path !== "sst.aws.permission") throw new Error(`the stand-in does not model ${path}()`);
        return { type: "aws.permission", ...(args[0] as object) };
      },
    });
  }
  const lift = (value: unknown): Out => new Out(settle(value));
  const globals = { $app: { name: "aws-cds-hackathon-poc-legajo", stage: "poc" }, sst: namespace("sst"), aws: namespace("aws"), $util: { output: lift, all: lift, log: { warn: (text: string) => warnings.push(text) } } };
  async function args(type: string, name: string): Promise<Record<string, unknown>> {
    const entry = recorded.find((candidate) => candidate.type === type && candidate.name === name);
    if (!entry) throw new Error(`no ${type} named ${name} was created`);
    return (await settle(entry.args)) as Record<string, unknown>;
  }
  const metaOf = (value: unknown): Meta | undefined => (value instanceof Leaf ? value.meta : undefined);
  return { recorded, warnings, grants, signups, globals, settle, args, once, fn, linkable, output, metaOf };
});

const capabilities = () => vi.importActual<typeof import("./iam-capabilities")>("./iam-capabilities");

vi.mock("./storage", async () => {
  const { storageFor: needs } = await vi.importActual<typeof import("./storage-keys")>("./storage-keys");
  const bucketsOf = (fn: LambdaName) => needs(fn).buckets.filter((name) => name !== "InboundMail");
  return { storageLinks: (fn: LambdaName) => [...needs(fn).tables.map((table) => fake.once("sst.aws.Dynamo", table)), ...bucketsOf(fn).map((name) => fake.once("sst.aws.Bucket", name))] };
});
vi.mock("./mocks", async () => {
  const caps = await capabilities();
  const held = (fn: LambdaName, capability: "MOCK_READER" | "MOCK_PLATFORM") => caps.resolveCapabilities(caps.LAMBDA_CAPABILITIES[fn].capabilities).includes(capability);
  const invoke = ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"];
  const leading = (fn: "Bff" | "QaDriver") => [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...caps.WORLDS_LEADING_KEYS[fn]] }];
  return {
    mockLinks: (fn: LambdaName) => [
      ...(held(fn, "MOCK_READER") ? [fake.linkable("ReaderMock", invoke)] : []),
      ...(held(fn, "MOCK_PLATFORM") ? [fake.linkable("PlatformMock", invoke)] : []),
      ...("ReaderCatalog" in caps.expectedTables(fn) ? [fake.once("sst.aws.Dynamo", "ReaderCatalog")] : []),
      ...("Platform" in caps.expectedTables(fn) ? [fake.linkable("Platform")] : []),
    ],
    mockPermissions: (fn: "Bff" | "QaDriver") => [{ actions: ["dynamodb:PutItem"], resources: ["PlatformData.arn"], conditions: leading(fn) }],
    grantMockInvoke: (fn: string) => (fake.grants.push(fn), []),
    readerMockApi: fake.fn("ReaderMock"),
    platformMockApi: fake.fn("PlatformMock"),
  };
});
vi.mock("./leads", async () => {
  const spec = await vi.importActual<typeof import("./leads-spec")>("./leads-spec");
  const linked: Record<string, () => object> = { SignupDispatch: () => fake.fn("SignupDispatch"), LeadNotice: () => fake.fn("LeadNotice"), OriginVerifyKey: () => fake.once("sst.Secret", "OriginVerifyKey") };
  const statements = (fn: "Bff" | "QaDriver", kind: string): unknown[] =>
    ({ leads: [spec.leadsStatement(fn, "LeadsData.arn")], cognito: [spec.cognitoStatement(fn, "UserPool.arn")], signupRuntime: [spec.signupRuntimeStatement("Runtime.arn")], qaSignupMail: spec.qaSignupMailStatements("mail") })[kind] ?? [];
  const signupGrants = (fn: "Bff" | "QaDriver") => {
    fake.signups.push(fn);
    return { link: spec.SIGNUP_GRANT_LINKS[fn].map((name) => linked[name]?.() ?? fake.linkable(name, name === "InboundMailSim" ? ["s3:GetObject"] : [])), permissions: spec.SIGNUP_GRANT_STATEMENTS[fn].flatMap((kind) => statements(fn, kind)) };
  };
  return { signupGrants, signupDispatch: fake.fn("SignupDispatch"), leadNotice: fake.fn("LeadNotice") };
});
vi.mock("./messaging-email", async () => {
  const { emailLinkNames } = await vi.importActual<typeof import("./messaging-email-spec")>("./messaging-email-spec");
  const actionsOf = (name: string): string[] => (name.startsWith("EmailSender") ? ["ses:SendEmail"] : ["s3:GetObject"]);
  return { emailLinks: (fn: LambdaName) => emailLinkNames(fn).map((name) => fake.linkable(name, actionsOf(name))), inboundEmail: fake.fn("InboundEmail"), simMail: fake.fn("SimMail"), channelEvents: fake.fn("ChannelEvents") };
});
vi.mock("./operations", async () => ({
  OperationEvents: fake.linkable("OperationEvents", ["sqs:SendMessage"]),
  OperationEventsDlq: fake.linkable("OperationEventsDlq", [...(await capabilities()).QA_DRIVER_DLQ_ONLY_ACTIONS]),
  ...{ operationWorker: fake.fn("OperationWorker"), documentIntake: fake.fn("DocumentIntake"), operationEventsDlqQueue: fake.once("sst.aws.Queue", "OperationEventsDlqQueue") },
}));
vi.mock("./scheduler", async () => ({ Scheduler: fake.linkable("Scheduler", (await capabilities()).CAPABILITIES.TIMERS.actions), worldJanitor: fake.fn("WorldJanitor"), scheduleDispatch: fake.fn("ScheduleDispatch") }));
vi.mock("./agentcore", async () => ({ Agent: fake.linkable("Agent", (await capabilities()).CAPABILITIES.MEMORY_ADMIN.actions) }));
vi.mock("./guardrail", () => ({ GuardrailG1: fake.linkable("GuardrailG1", ["bedrock:ApplyGuardrail"]) }));
vi.mock("./auth", () => ({
  Auth: fake.linkable("Auth", ["cognito-idp:AdminGetUser"]),
  triggerFunctions: { preSignUp: fake.fn("AuthPreSignUp"), customMessage: fake.fn("AuthCustomMessage"), preTokenGeneration: fake.fn("AuthPreToken") },
}));
vi.mock("./ci", () => ({ qaRunnerRoleArn: fake.output("arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-legajo-qa-runner") }));
vi.mock("./channel-modes", () => ({ ChannelModes: fake.linkable("ChannelModes") }));
vi.mock("./secrets", () => ({
  SessionTokenKey: fake.once("sst.Secret", "SessionTokenKey"),
  OriginVerifyKey: fake.once("sst.Secret", "OriginVerifyKey"),
  SeedOverrides: { value: fake.output(JSON.stringify({ operatorEmail: "Demo-Operator@sim.legajo.demo.craftech.io" })) },
}));
vi.mock("./web", () => ({ router: fake.once("sst.aws.Router", "Router") }));
vi.mock("./feeds", () => ({ feedEvents: fake.fn("FeedEvents") }));
vi.mock("./messaging-whatsapp", () => ({ inboundWhatsApp: fake.fn("InboundWhatsApp") }));
vi.mock("./agent-tools", () => ({
  toolFunctions: Object.fromEntries(["operations", "documents", "messaging", "followups", "handoff"].map((target) => [target, fake.fn(`Tool${target.charAt(0).toUpperCase()}${target.slice(1)}`)])),
}));

beforeAll(async () => {
  for (const [name, value] of Object.entries(fake.globals)) vi.stubGlobal(name, value);
  await import("./bff");
  await import("./observability");
});

const APP = "aws-cds-hackathon-poc-legajo";
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const section12 = architecture.slice(architecture.indexOf("## 12."), architecture.indexOf("## 13."));
const line12 = (prefix: string): string => section12.split("\n").find((entry) => entry.startsWith(prefix)) ?? "";
const adrRow = (name: string): string => read("docs/adr/0015-alta-publica-de-invitados-y-leads.md").split("\n").find((entry) => entry.startsWith(`| ${name} |`)) ?? "";
const metricNames = (text: string): string[] => [...text.matchAll(/`([A-Z][A-Za-z]+)`/g)].map((match) => match[1] ?? "");

interface Statement { readonly actions: string[]; readonly resources: unknown[]; readonly conditions?: unknown[] }
interface FunctionArgs { readonly [key: string]: unknown; readonly link: unknown[]; readonly permissions?: Statement[]; readonly url?: { authorization: string; cors: boolean; router: { instance: unknown; path: string; readTimeout: string } } }
const fnArgs = async (name: string): Promise<FunctionArgs> => (await fake.args("sst.aws.Function", name)) as unknown as FunctionArgs;
const linkNames = (link: readonly unknown[]): string[] => link.map((item) => fake.metaOf(item)?.name ?? "?");
const invoked = (link: readonly unknown[]): string[] => link.filter((item) => fake.metaOf(item)?.type === "sst.aws.Function").map((item) => fake.metaOf(item)?.name ?? "?");
const stored = (fn: LambdaName): string[] => [...storageFor(fn).tables, ...storageFor(fn).buckets.filter((name) => name !== "InboundMail")];
const alarmOf = (metric: string): AlarmSpec | undefined => ALARMS.find((spec) => spec.source.kind === "metric" && spec.source.metric === metric);

async function grantedActions(name: LambdaName): Promise<string[]> {
  const created = await fnArgs(name);
  const actions = new Set((created.permissions ?? []).flatMap((statement) => statement.actions));
  for (const item of created.link) {
    const meta = fake.metaOf(item);
    if (meta?.type === "sst.aws.Function") actions.add("lambda:InvokeFunction");
    if (meta?.type !== "sst.Linkable") continue;
    for (const statement of ((await fake.args("sst.Linkable", meta.name)).include ?? []) as Statement[]) for (const action of statement.actions) actions.add(action);
  }
  return [...actions].sort();
}

describe("[FL-098] the alarm of the dead letters of OperationEvents", () => {
  const dlq = ALARMS.find((spec) => spec.source.kind === "dlq");

  it("[FL-098] alarms on more than 0 messages of OperationEventsDlq.fifo, visible or being read, every minute", () => {
    expect(dlq).toMatchObject({ key: "operation-events-dlq", comparison: "GreaterThanThreshold", threshold: 0, periodSeconds: 60, evaluationPeriods: 1 });
    expect(line12("- Alarmas:")).toContain("DLQ de `OperationEvents` > 0");
    const queries = alarmQueries(dlq as AlarmSpec, "the-dlq");
    expect(queries.filter((query) => query.metric !== undefined).map((query) => [query.metric?.namespace, query.metric?.metricName, query.metric?.dimensions])).toEqual([
      ["AWS/SQS", "ApproximateNumberOfMessagesVisible", { QueueName: "the-dlq" }],
      ["AWS/SQS", "ApproximateNumberOfMessagesNotVisible", { QueueName: "the-dlq" }],
    ]);
    expect(queries.at(-1)).toEqual({ id: "total", returnData: true, label: "operation-events-dlq", expression: "FILL(m0, 0) + FILL(m1, 0)" });
  });

  it("[FL-098] watches the queue of the dead letters, never OperationEvents.fifo itself, under a fixed name", async () => {
    const alarm = await fake.args("aws.cloudwatch.MetricAlarm", "AlarmOperationEventsDlq");
    expect(alarm).toMatchObject({ name: `${APP}-poc-operation-events-dlq`, comparisonOperator: "GreaterThanThreshold", threshold: 0, treatMissingData: "notBreaching" });
    const dimensions = (alarm.metricQueries as Array<{ metric?: { dimensions?: unknown } }>).flatMap((query) => (query.metric ? [query.metric.dimensions] : []));
    expect(dimensions).toEqual([{ QueueName: "OperationEventsDlqQueue.queue.name" }, { QueueName: "OperationEventsDlqQueue.queue.name" }]);
  });

  it("[FL-098] lets the QaDriver read that alarm's history and nothing else (`alarm.history`)", async () => {
    expect(await fake.args("sst.Linkable", "DlqAlarm")).toEqual({
      properties: { name: "AlarmOperationEventsDlq.name" },
      include: [{ type: "aws.permission", actions: ["cloudwatch:DescribeAlarmHistory"], resources: ["AlarmOperationEventsDlq.arn"] }],
    });
    expect(linkNames((await fnArgs("QaDriver")).link)).toContain("DlqAlarm");
  });
});

describe("metrics of docs/architecture.md §12 and ADR-0015 §9", () => {
  it("lists exactly the metrics of §12 and of ADR-0015 §9", () => {
    const documented = new Set([...metricNames(line12("- Métricas `LegajoAgent/*`:")), ...metricNames(adrRow("Métricas"))]);
    expect(documented.size).toBe(26);
    expect(DOCUMENTED_METRICS.map((spec) => spec.name).sort()).toEqual([...documented].sort());
    expect(METRICS.map((spec) => spec.name).sort()).toEqual([...documented, ...metricNames(line12("- Métricas de los adaptadores de canal"))].sort());
  });

  it("names every metric the way the code that counts it does, and says who writes the rest", () => {
    for (const spec of METRICS) {
      expect(spec.emitters.length, spec.name).toBeGreaterThan(0);
      for (const emitter of spec.emitters) expect(Object.keys(LAMBDA_CAPABILITIES), spec.name).toContain(emitter);
      expect(spec.source === undefined, spec.name).toBe(spec.pendingIn !== undefined);
      if (spec.source !== undefined) expect(read(spec.source), spec.name).toContain(spec.pattern === undefined ? `"${spec.name}"` : 'error("tool.failed"');
    }
  });

  it("splits by reason, kind, channel and origin and source where §12 says so; a metric with an alarm stays plain", () => {
    const dimensionsOf = (name: string) => Object.keys(METRICS.find((spec) => spec.name === name)?.dimensions ?? {});
    expect([dimensionsOf("SignupRejected"), dimensionsOf("QuotaHits"), dimensionsOf("OutboundSent"), dimensionsOf("GuardrailBlocks")]).toEqual([["Reason"], ["Kind"], ["Channel"], ["Origin", "Source"]]);
    for (const spec of METRICS) expect(Object.keys(spec.dimensions ?? {}).length, spec.name).toBeLessThanOrEqual(3);
    for (const spec of ALARMS) if (spec.source.kind === "metric") expect(METRICS.find((metric) => metric.name === (spec.source as { metric: string }).metric)?.dimensions, spec.key).toBeUndefined();
  });

  it("puts one filter per metric and emitter on the log group SST created for that function", async () => {
    const filters = metricFilterSpecs();
    expect(fake.recorded.filter((entry) => entry.type === "aws.cloudwatch.LogMetricFilter")).toHaveLength(filters.length);
    for (const filter of filters) {
      expect(await fake.args("aws.cloudwatch.LogMetricFilter", filter.logicalName)).toEqual({
        logGroupName: `${filter.emitter}.logGroup.name`,
        pattern: filter.pattern,
        metricTransformation: { name: filter.metric, namespace: METRIC_NAMESPACE, value: filter.value, unit: filter.unit, ...(filter.dimensions ? { dimensions: filter.dimensions } : {}) },
      });
    }
    const of = (name: string) => filters.filter((filter) => filter.metric === name);
    expect(of("ToolErrors").map((filter) => [filter.emitter, filter.pattern])).toEqual(["Operations", "Documents", "Messaging", "Followups", "Handoff"].map((tool) => [`Tool${tool}`, '{ $.level = "error" }']));
    expect(of("SignupStarted")[0]?.pattern).toBe('{ $.metric = "SignupStarted" }');
    expect(of("TurnLatency")[0]).toMatchObject({ value: "$.latencyMs", unit: "Milliseconds" });
  });
});

describe("alarms of docs/architecture.md §12 and ADR-0015 §9", () => {
  const items = [...line12("- Alarmas:").split(";"), ...adrRow("Alarmas").split(";")];

  it("has one alarm per item of §12, with its threshold and window, and nothing else", () => {
    const keys = new Set<string>();
    for (const item of items) {
      if (item.includes("BounceRate")) {
        expect(ALARMS.find((spec) => spec.source.kind === "sesBounceRate")).toMatchObject({ comparison: "GreaterThanOrEqualToThreshold", threshold: 0.02 });
        expect(item).toContain("≥ 2 %");
        keys.add("ses-bounce-rate");
        continue;
      }
      const match = /`([A-Z][A-Za-z]+)`(?: > (\d+)(?: en (\d+) (min|h))?)?/.exec(item);
      if (match === null) continue;
      const [, metric = "", threshold, amount, unit] = match;
      const spec = metric === "OperationEvents" ? ALARMS.find((candidate) => candidate.source.kind === "dlq") : alarmOf(metric);
      expect(spec, metric).toBeDefined();
      expect(spec?.comparison, metric).toBe("GreaterThanThreshold");
      expect(spec?.threshold, metric).toBe(threshold === undefined ? 0 : Number(threshold));
      if (amount !== undefined) expect(spec?.periodSeconds, metric).toBe(Number(amount) * (unit === "h" ? 3_600 : 60));
      keys.add(spec?.key ?? "");
    }
    expect([...keys].sort()).toEqual(ALARMS.map((spec) => spec.key).sort());
  });

  it("creates every alarm under a fixed name; missing data is never a breach", async () => {
    expect(fake.recorded.filter((entry) => entry.type === "aws.cloudwatch.MetricAlarm")).toHaveLength(ALARMS.length);
    for (const spec of ALARMS) {
      const alarm = await fake.args("aws.cloudwatch.MetricAlarm", `Alarm${spec.key.split("-").map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`).join("")}`);
      expect(alarm, spec.key).toMatchObject({ name: `${APP}-poc-${spec.key}`, comparisonOperator: spec.comparison, threshold: spec.threshold, treatMissingData: "notBreaching" });
    }
  });
});

describe("project budget (§12, §17 item 8)", () => {
  it("is monthly, inside the CI role's budget fence, filtered by the Project tag, with notices at 50, 80 and 100 %", async () => {
    expect(line12("- **Presupuesto**:")).toContain("avisos al 50, 80 y 100 %");
    expect(read("infra/bootstrap/ci-role.yaml")).toContain('budget/${AppName}-*"');
    expect(budgetName(APP, "poc").startsWith(`${APP}-`)).toBe(true);
    expect(await fake.args("aws.budgets.Budget", "ProjectBudget")).toEqual({
      name: `${APP}-poc-monthly`,
      budgetType: "COST",
      limitAmount: String(PROJECT_BUDGET.limitUsdPerMonth),
      limitUnit: "USD",
      timeUnit: "MONTHLY",
      costFilters: [{ name: "TagKeyValue", values: [`user:Project$${APP}`] }],
      notifications: budgetNotifications(["demo-operator@sim.legajo.demo.craftech.io"]),
    });
    expect(budgetNotifications(["x@y.io"]).map((notice) => [notice.threshold, notice.notificationType])).toEqual([[50, "ACTUAL"], [80, "ACTUAL"], [100, "ACTUAL"]]);
  });

  it("notifies SeedOverrides.operatorEmail, none while the secret is `{}`, and never echoes a malformed value", () => {
    expect(budgetSubscribers("{}")).toEqual([]);
    expect(budgetNotifications([])).toEqual([]);
    for (const bad of ['{"operatorEmail":"not an address"}', "not json at all"]) expect(() => budgetSubscribers(bad)).toThrow(/^(?!.*not an address)(?!.*not json at all)/);
  });
});

describe("reserved concurrency and PolicyAudit (§12)", () => {
  it("reserves what §12 says, and each module holds the same number", () => {
    const documented = Object.fromEntries([...line12("- Concurrencia reservada:").matchAll(/`(\w+)` (\d+)/g)].map((match) => [match[1], Number(match[2])]));
    expect(documented).toEqual(RESERVED_CONCURRENCY);
    expect([EDGE_BUDGETS.bff.reservedConcurrency, EDGE_BUDGETS.publicWeb.reservedConcurrency]).toEqual([RESERVED_CONCURRENCY.Bff, RESERVED_CONCURRENCY.PublicWeb]);
    expect([EMAIL_FUNCTIONS.InboundEmail.reservedConcurrency, EMAIL_FUNCTIONS.SimMail.reservedConcurrency]).toEqual([RESERVED_CONCURRENCY.InboundEmail, RESERVED_CONCURRENCY.SimMail]);
    expect([LEADS_FUNCTIONS.SignupDispatch.reservedConcurrency, LEADS_FUNCTIONS.LeadNotice.reservedConcurrency]).toEqual([RESERVED_CONCURRENCY.SignupDispatch, RESERVED_CONCURRENCY.LeadNotice]);
    expect(/reservedConcurrency: (\d+)/.exec(read("infra/operations.ts"))?.[1]).toBe(String(RESERVED_CONCURRENCY.OperationWorker));
    expect(read("infra/auth.ts").replace(/^\s*\/\/.*$/gm, "")).not.toContain("concurrency"); // a throttled trigger would fail the sign-in
  });

  it("runs PolicyAudit daily at 03:00 ART over the DEMO and GUEST firms the handler lists, enabled once the handler takes that event", async () => {
    expect(POLICY_AUDIT.event).toEqual({ kind: "DAILY" });
    expect((Number(/^cron\(0 (\d+) \* \* \? \*\)$/.exec(POLICY_AUDIT.schedule)?.[1]) - 3 + 24) % 24).toBe(3);
    expect(POLICY_AUDIT.enabled).toBe(PolicyAuditEvent.safeParse(POLICY_AUDIT.event).success);
    expect(await fake.args("sst.aws.Cron", "PolicyAuditDaily")).toEqual({ function: "PolicyAudit.arn", schedule: POLICY_AUDIT.schedule, event: POLICY_AUDIT.event, enabled: POLICY_AUDIT.enabled });
    expect(await fnArgs("PolicyAudit")).toMatchObject({ handler: "packages/bff/src/handlers/policy-audit.handler", timeout: "900 seconds" });
    expect(linkNames((await fnArgs("PolicyAudit")).link)).toEqual(stored("PolicyAudit"));
  });
});

describe("Bff and PublicWeb behind the Router (ADR-0015 §3.1)", () => {
  it.each([["Bff", "bff"], ["PublicWeb", "publicWeb"]] as const)("%s: AWS_IAM URL on its route with OAC, its budget and concurrency, no environment", async (name, edge) => {
    const created = await fnArgs(name);
    const budget = EDGE_BUDGETS[edge];
    expect(created).toMatchObject({ timeout: `${budget.timeoutSeconds} seconds`, memory: `${budget.memoryMb} MB`, concurrency: { reserved: RESERVED_CONCURRENCY[name] } });
    expect(created.url).toMatchObject({ authorization: "iam", cors: false, router: { path: LAMBDA_ROUTES[edge], readTimeout: `${budget.routerReadTimeoutSeconds} seconds` } });
    expect(fake.metaOf(created.url?.router.instance)).toEqual({ type: "sst.aws.Router", name: "Router" });
    expect(created).not.toHaveProperty("environment");
  });

  it("Bff: its data, the platform mock, the Router-side secret and the signup grants; it invokes only its four functions and sends nothing", async () => {
    const created = await fnArgs("Bff");
    expect(linkNames(created.link)).toEqual([
      ...stored("Bff"),
      ...["PlatformMock", "Platform", "Auth", "ChannelModes", "SessionTokenKey", "Scheduler", "Agent", "OperationEvents", "InboundWhatsApp", "WorldJanitor"],
      ...["Leads", "SignupDispatch", "LeadNotice", "OriginVerifyKey"],
    ]);
    expect(invoked(created.link).sort()).toEqual(["InboundWhatsApp", "LeadNotice", "SignupDispatch", "WorldJanitor"]);
    expect(created.permissions?.slice(1)).toEqual([leadsStatement("Bff", "LeadsData.arn"), cognitoStatement("Bff", "UserPool.arn"), signupRuntimeStatement("Runtime.arn")]);
  });

  it("PublicWeb: Runtime, AuditLog, Uploads and the origin key, nothing else", async () => {
    const created = await fnArgs("PublicWeb");
    expect(linkNames(created.link)).toEqual([...stored("PublicWeb"), "OriginVerifyKey"]);
    expect(created.permissions).toBeUndefined();
  });

  it("only the Bff and the QaDriver get signup grants here (WorldJanitor's are infra/scheduler.ts's)", () => {
    expect(fake.signups).toEqual(["Bff", "QaDriver"]);
    expect(fake.grants.sort()).toEqual(["Bff", "QaDriver"]);
  });
});

describe("QaDriver (ADR-0005, docs/test-plan.md §4.1)", () => {
  it("has the fixed name the qa-runner role is fenced to, and only that role in its resource policy", async () => {
    const created = await fnArgs("QaDriver");
    expect(created).toMatchObject({ name: `${APP}-poc-qa-driver`, handler: "packages/bff/src/handlers/qa-driver.handler", timeout: "900 seconds" });
    expect(created).not.toHaveProperty("url");
    expect(created).not.toHaveProperty("environment");
    expect(read("infra/bootstrap/ci-role.yaml")).toContain("function:${AppName}-${DeployStage}-qa-driver");
    const permissions = await Promise.all(fake.recorded.filter((entry) => entry.type === "aws.lambda.Permission").map((entry) => fake.settle(entry.args)));
    expect(permissions).toEqual([{ action: "lambda:InvokeFunction", function: "QaDriver.name", principal: "arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-legajo-qa-runner" }]);
  });

  it("links what the Bff has fenced to QA worlds, the QA sender, the channel entries, G1, the DLQ and the SC-26 grants", async () => {
    const created = await fnArgs("QaDriver");
    expect(linkNames(created.link)).toEqual([
      ...stored("QaDriver"),
      ...["ReaderMock", "PlatformMock", "ReaderCatalog", "Platform", "EmailSenderQa", "InboundMailOps"],
      ...["Auth", "ChannelModes", "SessionTokenKey", "Scheduler", "Agent", "GuardrailG1", "OperationEvents", "OperationEventsDlq"],
      ...["InboundEmail", "SimMail", "InboundWhatsApp", "PolicyAudit", "WorldJanitor", "Leads", "InboundMailSim", "DlqAlarm"],
    ]);
    expect(created.permissions?.[0]?.conditions).toEqual([{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["POP#firm-qa#*", "POP#firm-sim#*", "POP#firm-guest-test#*"] }]);
    expect(created.permissions?.slice(1)).toEqual([leadsStatement("QaDriver", "LeadsData.arn"), cognitoStatement("QaDriver", "UserPool.arn"), ...qaSignupMailStatements("mail")]);
    expect(linkNames(created.link).filter((name) => name.startsWith("EmailSender"))).toEqual(["EmailSenderQa"]);
    expect(linkNames((await fnArgs("Bff")).link).filter((name) => name.startsWith("EmailSender"))).toEqual([]);
  });
});

describe("least privilege (docs/architecture.md §14)", () => {
  // Data access is declared as tables and buckets (a bucket link is `s3:*`, so the QaDriver's DeleteObject
  // of `qa/*` comes with Documents, Uploads and Media); every other action must match the capabilities.
  const DATA_ACCESS = /^(?:dynamodb|s3):/;

  it.each(["Bff", "PublicWeb", "QaDriver", "PolicyAudit"] as const)("%s ends up with exactly the actions infra/iam-capabilities.ts gives it", async (name) => {
    const drift = actionDrift(name, await grantedActions(name));
    expect([drift.missing, drift.extra].map((actions) => actions.filter((action) => !DATA_ACCESS.test(action)))).toEqual([[], []]);
  });

  it("resolves every late link and the budget's subscriber without a warning", () => expect(fake.warnings).toEqual([]));
});
