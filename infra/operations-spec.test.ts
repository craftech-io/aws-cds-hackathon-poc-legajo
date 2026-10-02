// infra/operations.ts and infra/scheduler.ts as resources (docs/architecture.md §7, §8, §9.3, §12 and
// §14; ADR-0004; docs/build-plan.md WP-24), evaluated with a recording stand-in for the SST globals:
// what is asserted is what the modules hand to SST and Pulumi. The modules of other work packages
// they link are replaced by stand-ins that carry exactly the permissions their contract promises, so
// the least-privilege check compares what each function ends up with against infra/iam-capabilities.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CAPABILITIES, QA_DRIVER_DLQ_ONLY_ACTIONS, actionDrift, type LambdaName } from "./iam-capabilities";
import { storageFor } from "./storage-keys";

const fake = vi.hoisted(() => {
  interface Meta { readonly type: string; readonly name: string }
  const recorded: Array<Meta & { readonly args: unknown }> = [];
  const warnings: string[] = [];
  const calls: Array<{ readonly helper: string; readonly fn: string; readonly created?: unknown }> = [];
  class Leaf { constructor(readonly meta: Meta) {} }
  class FakeOutput {
    constructor(readonly value: Promise<unknown>) {}
    apply = (fn: (value: unknown) => unknown): FakeOutput => new FakeOutput(this.value.then((value) => settle(fn(value))));
  }
  async function settle(value: unknown): Promise<unknown> {
    if (value instanceof FakeOutput) return settle(await value.value);
    if (value instanceof Promise) return settle(await value);
    if (Array.isArray(value)) return Promise.all(value.map(settle));
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await settle(entry)])));
    }
    return value;
  }
  // A created resource: `.meta` says what it is, `.nodes.<x>` is another resource, `.subscribe()` is
  // recorded, and any other property is an Output that resolves to "<name>.<property>".
  function resource(type: string, name: string): object {
    return new Proxy(new Leaf({ type, name }), {
      get(target, prop) {
        if (prop === "meta") return target.meta;
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop === "nodes") return new Proxy({}, { get: (_nodes, node) => resource(`${type}.${String(node)}`, `${name}.${String(node)}`) });
        if (prop === "subscribe") return (...args: unknown[]) => recorded.push({ type: `${type}.subscribe`, name, args });
        return new FakeOutput(Promise.resolve(`${name}.${prop}`));
      },
    });
  }
  const created = new Map<string, object>();
  const once = (type: string, name: string): object => {
    if (!created.has(`${type}|${name}`)) created.set(`${type}|${name}`, resource(type, name));
    return created.get(`${type}|${name}`) as object;
  };
  function linkable(name: string, actions: readonly string[]): object {
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
      construct(_target, args: unknown[]) {
        recorded.push({ type: path, name: String(args[0]), args: args[1] });
        return resource(path, String(args[0]));
      },
      apply(_target, _this, args: unknown[]) {
        if (path === "sst.aws.permission") return { type: "aws.permission", ...(args[0] as object) };
        if (path.endsWith(".subscribe")) return recorded.push({ type: path, name: String(args[0]), args: args.slice(1) });
        if (path.endsWith("Output")) return resource(path, "data");
        throw new Error(`the stand-in does not model ${path}()`);
      },
    });
  }
  const interpolate = (strings: TemplateStringsArray, ...values: unknown[]) =>
    new FakeOutput(settle(values).then((resolved) => strings.reduce((text, part, index) => `${text}${part}${index < values.length ? String((resolved as unknown[])[index]) : ""}`, "")));
  const globals = {
    $app: { name: "aws-cds-hackathon-poc-legajo", stage: "poc" },
    sst: namespace("sst"),
    aws: namespace("aws"),
    $util: { output: (value: unknown) => new FakeOutput(settle(value)), all: (value: unknown) => new FakeOutput(settle(value)), log: { warn: (text: string) => warnings.push(text) } },
    $interpolate: interpolate,
  };
  async function args(type: string, name: string): Promise<Record<string, unknown>> {
    const entry = recorded.find((candidate) => candidate.type === type && candidate.name === name);
    if (!entry) throw new Error(`no ${type} named ${name} was created`);
    return (await settle(entry.args)) as Record<string, unknown>;
  }
  const metaOf = (value: unknown): Meta | undefined => (value instanceof Leaf ? value.meta : undefined);
  const output = (value: unknown) => new FakeOutput(Promise.resolve(value));
  const scanPattern = JSON.stringify({ source: ["aws.guardduty"], detail: { s3ObjectDetails: { bucketName: ["Uploads.name", "Media.name"] } } });
  const platformStatement = { actions: ["dynamodb:Query"], resources: ["PlatformData.arn"], conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["POP#firm-guest-*"] }] };
  return { recorded, warnings, calls, globals, settle, args, once, linkable, metaOf, output, scanPattern, platformStatement };
});

// Modules of other work packages: their own specs test them. Each stand-in carries what its contract grants.
vi.mock("./storage", async () => {
  const { storageFor } = await vi.importActual<typeof import("./storage-keys")>("./storage-keys");
  const bucket = (name: string) => fake.once("sst.aws.Bucket", name);
  return {
    // As infra/storage.ts: the mail bucket is never linked whole (its routes come from emailLinks).
    storageLinks: (fn: LambdaName) => [
      ...storageFor(fn).tables.map((table) => fake.once("sst.aws.Dynamo", table)),
      ...storageFor(fn).buckets.filter((name) => name !== "InboundMail").map(bucket),
    ],
    uploadsBucket: bucket("Uploads"),
    mediaBucket: bucket("Media"),
  };
});
vi.mock("./malware", () => ({ malwareScanEventPatternJson: fake.output(fake.scanPattern) }));
vi.mock("./guardrail", () => ({ GuardrailG1: fake.linkable("GuardrailG1", ["bedrock:ApplyGuardrail"]), GuardrailG2: fake.linkable("GuardrailG2", ["bedrock:ApplyGuardrail"]) }));
vi.mock("./secrets", () => Object.fromEntries(["SessionTokenKey", "SeedOverrides", "WabaId", "WhatsAppPhoneNumberId"].map((name) => [name, fake.once("sst.Secret", name)])));
vi.mock("./messaging-email", () => ({
  emailLinks: (fn: string) => {
    fake.calls.push({ helper: "emailLinks", fn });
    return fn === "OperationWorker" ? [fake.linkable("EmailSenderSystem", ["ses:SendEmail"]), fake.linkable("InboundMailOps", ["s3:GetObject"])] : [];
  },
  simMail: fake.once("sst.aws.Function", "SimMail"),
}));
vi.mock("./messaging-whatsapp", () => ({
  sendWhatsAppPermissions: fake.output([{ actions: ["social-messaging:SendWhatsAppMessage"], resources: ["phone-number-id"] }]),
  whatsAppSenderLinks: [fake.linkable("ChannelModes", []), ...["WabaId", "WhatsAppPhoneNumberId", "SeedOverrides"].map((name) => fake.once("sst.Secret", name))],
}));
vi.mock("./mocks", () => ({
  mockLinks: (fn: string) => ({ OperationWorker: [fake.linkable("ReaderMock", ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"])], WorldJanitor: [fake.linkable("Platform", [])] })[fn] ?? [],
  mockPermissions: (fn: string) => (fn === "WorldJanitor" ? [fake.platformStatement] : []),
  grantMockInvoke: (fn: string, created: unknown) => fake.calls.push({ helper: "grantMockInvoke", fn, created }) && [],
}));
vi.mock("./agentcore", async () => {
  const { CAPABILITIES: capabilities } = await vi.importActual<typeof import("./iam-capabilities")>("./iam-capabilities");
  return {
    Harness: fake.linkable("Harness", ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"]),
    Agent: fake.linkable("Agent", capabilities.MEMORY_ADMIN.actions),
  };
});
vi.mock("./bff", () => ({ bff: fake.once("sst.aws.Function", "Bff"), qaDriver: fake.once("sst.aws.Function", "QaDriver") }));
vi.mock("./leads", async () => {
  const spec = await vi.importActual<typeof import("./leads-spec")>("./leads-spec");
  const linked: Record<string, () => object> = {
    Leads: () => fake.linkable("Leads", []), LeadNotice: () => fake.once("sst.aws.Function", "LeadNotice"),
    Auth: () => fake.linkable("Auth", ["cognito-idp:AdminGetUser"]), GuestObjects: () => fake.linkable("GuestObjects", ["s3:DeleteObject", "s3:ListBucket"]),
  };
  return {
    signupGrants: (fn: "WorldJanitor") => ({
      link: spec.SIGNUP_GRANT_LINKS[fn].map((name) => linked[name]?.() ?? fake.once("sst.Linkable", name)),
      permissions: [spec.leadsStatement(fn, "LeadsData.arn"), spec.cognitoStatement(fn, "UserPool.arn")],
    }),
  };
});

let operations: typeof import("./operations");
let scheduler: typeof import("./scheduler");

beforeAll(async () => {
  for (const [name, value] of Object.entries(fake.globals)) vi.stubGlobal(name, value);
  operations = await import("./operations");
  scheduler = await import("./scheduler");
  await fake.settle(scheduler.worldJanitorPurgeInvokers);
});

const APP = "aws-cds-hackathon-poc-legajo";
const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");
const bootstrap = readFileSync(resolve(process.cwd(), "infra/bootstrap/ci-role.yaml"), "utf8");

interface Statement { readonly actions: string[]; readonly resources: string[]; readonly conditions?: unknown[] }
interface FunctionArgs { readonly handler: string; readonly timeout: string; readonly link: unknown[]; readonly permissions?: Statement[] }

const fnArgs = async (name: string): Promise<FunctionArgs> => (await fake.args("sst.aws.Function", name)) as unknown as FunctionArgs;
const linkNames = (link: readonly unknown[]): string[] => link.map((item) => fake.metaOf(item)?.name ?? "?");
/** Tables and buckets infra/iam-capabilities.ts gives a function, in the order `storageLinks` returns them. */
const stored = (fn: LambdaName): string[] => [...storageFor(fn).tables, ...storageFor(fn).buckets];
const subscription = async (type: string, name: string): Promise<unknown> => fake.settle(fake.recorded.find((entry) => entry.type === type && entry.name === name)?.args);
const allow = (actions: string[], resources: string[], conditions?: unknown[]) => ({ type: "aws.permission", actions, resources, ...(conditions ? { conditions } : {}) });

/** Actions a linked item grants: a Function its invocation, a Linkable its `include`, anything else none. */
async function linkedActions(item: unknown): Promise<string[]> {
  const meta = fake.metaOf(item);
  if (meta?.type === "sst.aws.Function") return ["lambda:InvokeFunction"];
  if (meta?.type !== "sst.Linkable") return [];
  const { include } = (await fake.args("sst.Linkable", meta.name)) as { include?: Statement[] };
  return (include ?? []).flatMap((statement) => statement.actions);
}

async function grantedActions(name: LambdaName): Promise<string[]> {
  const created = await fnArgs(name);
  const actions = new Set((created.permissions ?? []).flatMap((statement) => statement.actions));
  for (const item of created.link) for (const action of await linkedActions(item)) actions.add(action);
  return [...actions].sort();
}

describe("numbers of docs/architecture.md", () => {
  it("§7 and §12: worker 360 s, batch 1, reserved concurrency 5; queue visibility 720 s, maxReceiveCount 2", () => {
    const row = /`OperationWorker` \(timeout (\d+) s, batch (\d+), concurrencia reservada (\d+), visibilidad de la cola (\d+) s, `maxReceiveCount (\d+)`/.exec(architecture);
    const { OPERATION_WORKER: worker, OPERATION_EVENTS: queue } = operations;
    expect(row?.slice(1).map(Number)).toEqual([worker.timeoutSeconds, worker.batchSize, worker.reservedConcurrency, queue.visibilityTimeoutSeconds, queue.maxReceiveCount]);
    expect(architecture).toContain(`Concurrencia reservada: \`OperationWorker\` ${worker.reservedConcurrency},`);
    expect(queue.visibilityTimeoutSeconds).toBeGreaterThanOrEqual(2 * worker.timeoutSeconds);
  });

  it("§8 and §9.3: the schedules group, WorldJanitor's 12-minute timeout and its nightly run at 04:00 ART", () => {
    expect(architecture).toContain(`grupo \`${scheduler.scheduleGroupName(APP, "poc")}\``);
    expect(architecture).toContain(`(timeout de la función ${scheduler.WORLD_JANITOR.timeoutSeconds / 60} min)`);
    expect(architecture).toContain("(`WorldJanitor` `IDLE_GUEST_RESET`, 04:00 ART)");
    const hourUtc = Number(/^cron\(0 (\d+) \* \* \? \*\)$/.exec(scheduler.WORLD_JANITOR.nightlySchedule)?.[1]);
    expect((hourUtc - 3 + 24) % 24).toBe(4); // Argentina keeps UTC−3 all year
  });
});

describe("OperationEvents.fifo and its DLQ", () => {
  it("FIFO without content-based deduplication (producers set eventId), 720 s, SSE, fixed name, DLQ after 2 receives", async () => {
    expect(await fake.args("sst.aws.Queue", "OperationEventsQueue")).toEqual({
      fifo: { contentBasedDeduplication: false },
      visibilityTimeout: "720 seconds",
      dlq: { queue: "OperationEventsDlqQueue.arn", retry: 2 },
      transform: { queue: { name: `${APP}-poc-OperationEvents.fifo`, sqsManagedSseEnabled: true } },
    });
  });

  it("the DLQ is FIFO, keeps 14 days, SSE, fixed name", async () => {
    expect(await fake.args("sst.aws.Queue", "OperationEventsDlqQueue")).toEqual({
      fifo: true,
      transform: { queue: { name: `${APP}-poc-OperationEventsDlq.fifo`, messageRetentionSeconds: 1_209_600, sqsManagedSseEnabled: true } },
    });
  });

  it("both names fit SQS and the CI deploy role's name fence", () => {
    expect(bootstrap).toContain('sqs:${Region}:${AWS::AccountId}:${AppName}-*"');
    for (const queue of ["OperationEvents", "OperationEventsDlq"] as const) {
      const name = operations.queueName(APP, "poc", queue);
      expect(name.startsWith(`${APP}-`) && name.length <= 80 && /^[A-Za-z0-9_-]+\.fifo$/.test(name), name).toBe(true);
    }
  });

  it("producers link the url and sqs:SendMessage on the queue; the DLQ link carries only the QaDriver's three actions", async () => {
    const queue = "OperationEventsQueue";
    expect(await fake.args("sst.Linkable", "OperationEvents")).toEqual({ properties: { url: `${queue}.url` }, include: [allow(["sqs:SendMessage"], [`${queue}.arn`])] });
    expect(await fake.args("sst.Linkable", "OperationEventsDlq")).toEqual({
      properties: { url: "OperationEventsDlqQueue.url" },
      include: [allow([...QA_DRIVER_DLQ_ONLY_ACTIONS], ["OperationEventsDlqQueue.arn"])],
    });
  });
});

describe("OperationWorker", () => {
  it("runs its handler for 360 s at most, reserved concurrency 5, one message per batch and at most 5 polls at once", async () => {
    expect(await fnArgs("OperationWorker")).toMatchObject({ handler: "packages/bff/src/handlers/operation-worker.handler", timeout: "360 seconds", concurrency: { reserved: 5 } });
    expect(await subscription("sst.aws.Queue.subscribe", "OperationEventsQueue")).toEqual([
      "OperationWorker.arn",
      { batch: { size: 1 }, transform: { eventSourceMapping: { scalingConfig: { maximumConcurrency: 5 } } } },
    ]);
  });

  it("polls OperationEvents.fifo only (ChangeMessageVisibility included); its other statement is the WhatsApp sender's", async () => {
    expect((await fnArgs("OperationWorker")).permissions).toEqual([
      { actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"], resources: ["OperationEventsQueue.arn"] },
      { actions: ["social-messaging:SendWhatsAppMessage"], resources: ["phone-number-id"] },
    ]);
  });

  it("reads the mail bucket only through its ops route, and gives ReaderMock the resource side of the call", async () => {
    expect(linkNames((await fnArgs("OperationWorker")).link)).toEqual([
      ...stored("OperationWorker").filter((name) => name !== "InboundMail"),
      ...["EmailSenderSystem", "InboundMailOps", "ChannelModes", "WabaId", "WhatsAppPhoneNumberId", "SeedOverrides", "ReaderMock"],
      ...["GuardrailG1", "GuardrailG2", "SessionTokenKey", "OperationEvents", "Scheduler", "Harness"],
    ]);
    const grants = fake.calls.filter((call) => call.helper === "grantMockInvoke").map((call) => [call.fn, fake.metaOf(call.created)?.name]);
    expect(grants).toEqual([["OperationWorker", "OperationWorker"]]);
  });
});

describe("DocumentIntake", () => {
  it("takes every GuardDuty scan result of Uploads and Media from the default bus, with infra/malware.ts's pattern as is", async () => {
    expect(await subscription("sst.aws.Bus.subscribe", "DocumentIntakeScans")).toEqual([
      "arn:aws:events:data.region:data.accountId:event-bus/default",
      "DocumentIntake.arn",
      { transform: { rule: { eventPattern: fake.scanPattern } } },
    ]);
  });

  it("reads the scan tag of objects of Uploads and Media only, and enqueues through OperationEvents", async () => {
    const intake = await fnArgs("DocumentIntake");
    expect(intake.handler).toBe("packages/bff/src/handlers/document-intake.handler");
    expect(intake.permissions).toEqual([{ actions: ["s3:GetObjectTagging"], resources: ["Uploads.arn/*", "Media.arn/*"] }]);
    expect(linkNames(intake.link)).toEqual([...stored("DocumentIntake"), "OperationEvents"]);
  });
});

describe("timers: EventBridge Scheduler (ADR-0004)", () => {
  it("one group with the fixed name, inside the CI deploy role's and the boundary's fences", async () => {
    expect(await fake.args("aws.scheduler.ScheduleGroup", "Schedules")).toEqual({ name: `${APP}-poc-schedules` });
    expect(bootstrap).toContain('schedule-group/${AppName}-*"');
    expect(bootstrap).toContain('schedule/${AppName}-*/*"');
  });

  it("the invocation role: fixed name under the app's path, trusted by the Scheduler for this account and group only", async () => {
    const role = await fake.args("aws.iam.Role", "SchedulerInvocationRole");
    expect(role.name).toBe(`${APP}-poc-scheduler-invoke`);
    // Path and boundary come from infra/ci.ts; a module that set them would be denied the creation.
    expect(role).not.toHaveProperty("path");
    expect(role).not.toHaveProperty("permissionsBoundary");
    const condition = { StringEquals: { "aws:SourceAccount": "data.accountId", "aws:SourceArn": "Schedules.arn" } };
    expect(JSON.parse(String(role.assumeRolePolicy))).toEqual({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole", Condition: condition }],
    });
  });

  it("the invocation role may only invoke ScheduleDispatch", async () => {
    const policy = await fake.args("aws.iam.RolePolicy", "SchedulerInvocationPolicy");
    expect(policy.role).toBe("SchedulerInvocationRole.id");
    expect(JSON.parse(String(policy.policy))).toEqual({
      Version: "2012-10-17",
      Statement: [{ Sid: "InvokeScheduleDispatchOnly", Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: ["ScheduleDispatch.arn"] }],
    });
  });

  it("`Scheduler` is TIMERS: the schedule actions on the group's schedules, PassRole of that role only to the Scheduler", async () => {
    const { properties, include } = (await fake.args("sst.Linkable", "Scheduler")) as { properties: unknown; include: Statement[] };
    expect(properties).toEqual({ groupName: "Schedules.name", roleArn: "SchedulerInvocationRole.arn", targetArn: "ScheduleDispatch.arn" });
    expect(include).toEqual([
      allow(["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"], ["arn:aws:scheduler:data.region:data.accountId:schedule/Schedules.name/*"]),
      allow(["iam:PassRole"], ["SchedulerInvocationRole.arn"], [{ test: "StringEquals", variable: "iam:PassedToService", values: ["scheduler.amazonaws.com"] }]),
    ]);
    expect(include.flatMap((statement) => statement.actions).sort()).toEqual([...CAPABILITIES.TIMERS.actions].sort());
  });

  it("ScheduleDispatch enqueues through OperationEvents and invokes SimMail, and sends nothing itself", async () => {
    const dispatch = await fnArgs("ScheduleDispatch");
    expect(dispatch).toMatchObject({ handler: "packages/bff/src/handlers/schedule-dispatch.handler", timeout: "30 seconds" });
    expect(dispatch.permissions).toBeUndefined();
    expect(linkNames(dispatch.link)).toEqual([...stored("ScheduleDispatch"), "OperationEvents", "SimMail"]);
  });
});

describe("WorldJanitor", () => {
  it("12 minutes; WORLDS: its tables, Seed and Media, Platform only by name plus the fenced statement, timers and Memory", async () => {
    const janitor = await fnArgs("WorldJanitor");
    expect(janitor).toMatchObject({ handler: "packages/bff/src/handlers/world-janitor.handler", timeout: "720 seconds" });
    const { cognitoStatement, leadsStatement } = await vi.importActual<typeof import("./leads-spec")>("./leads-spec");
    expect(janitor.permissions).toEqual([fake.platformStatement, leadsStatement("WorldJanitor", "LeadsData.arn"), cognitoStatement("WorldJanitor", "UserPool.arn")]);
    expect(linkNames(janitor.link)).toEqual([
      ...stored("WorldJanitor"),
      ...["Platform", "Scheduler", "SessionTokenKey", "SeedOverrides", "Leads", "LeadNotice", "Auth", "GuestObjects", "Agent"],
    ]);
  });

  it("has the nightly reset of idle guest worlds, disabled until WP-31, and the hourly GUEST_SWEEP", async () => {
    expect(await fake.args("sst.aws.Cron", "WorldJanitorNightly")).toEqual({ function: "WorldJanitor.arn", schedule: "cron(0 7 * * ? *)", event: { kind: "IDLE_GUEST_RESET" }, enabled: false });
    expect(await fake.args("sst.aws.Cron", "WorldJanitorGuestSweep")).toEqual({ function: "WorldJanitor.arn", schedule: "rate(1 hour)", event: { kind: "GUEST_SWEEP" } });
  });

  it("its resource policy admits MEMORY_PURGE only from the roles of Bff and QaDriver", async () => {
    const permissions = await Promise.all(fake.recorded.filter((entry) => entry.type === "aws.lambda.Permission").map((entry) => fake.settle(entry.args)));
    expect(permissions).toEqual(
      ["Bff", "QaDriver"].map((caller) => ({ action: "lambda:InvokeFunction", function: "WorldJanitor.name", principal: `${caller}.role.arn` })),
    );
  });
});

describe("least privilege (docs/architecture.md §14)", () => {
  // Data access is declared as tables and buckets, not as actions; the worker's poller needs three
  // more SQS actions on its own queue, which the event source mapping uses and the capabilities omit.
  const DATA_ACCESS = /^(?:dynamodb|s3):/;
  const CASES: Array<[LambdaName, string[]]> = [
    ["OperationWorker", ["sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]],
    ["DocumentIntake", []],
    ["ScheduleDispatch", []],
    ["WorldJanitor", []],
  ];

  it.each(CASES)("%s ends up with exactly the actions infra/iam-capabilities.ts gives it", async (name, pollerActions) => {
    const drift = actionDrift(name, await grantedActions(name));
    expect(drift.missing).toEqual([]);
    expect(drift.extra.filter((action) => !DATA_ACCESS.test(action))).toEqual(pollerActions);
  });

  it("every late link resolves once the owner exports it: no warning", () => {
    expect(fake.warnings).toEqual([]);
  });

  // The stand-ins above follow the names these modules take late. Once an owner stops being a WP-02
  // stub, its real source has to export them, or the deploy would only warn.
  const LATE: Array<[string, string]> = [
    ["agentcore", "Harness"],
    ["agentcore", "Agent"],
    ["bff", "bff"],
    ["bff", "qaDriver"],
  ];

  it("checks every name these modules take late", () => {
    expect(LATE).toEqual([
      ...operations.WORKER_LATE_LINKS.agentcore.map((name) => ["agentcore", name]),
      ...scheduler.SCHEDULER_LATE_LINKS.agentcore.map((name) => ["agentcore", name]),
      ...Object.values(scheduler.MEMORY_PURGE_INVOKERS).map((name) => ["bff", name]),
    ]);
  });

  it.each(LATE)("infra/%s.ts exports %s once it is built", (owner, name) => {
    const source = readFileSync(resolve(process.cwd(), `infra/${owner}.ts`), "utf8");
    const built = !/^\/\/ Stub created by WP-\d/m.test(source);
    expect(built ? new RegExp(`export (?:const|function) ${name}\\b`).test(source) : true, `infra/${owner}.ts`).toBe(true);
  });
});
