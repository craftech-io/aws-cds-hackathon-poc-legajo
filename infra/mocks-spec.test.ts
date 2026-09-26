// WP-21 without an AWS account: evaluates infra/messaging-whatsapp.ts, infra/mocks.ts and
// infra/feeds.ts against recording fakes of the SST and Pulumi globals, and checks the names, the
// policies and both halves of every Function URL permission as data (docs/build-plan.md WP-21,
// docs/architecture.md §1, §5 and §14).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PLATFORM_EVENT_SOURCE, PlatformDetailType } from "../packages/platform-mock/src/events";
import { FAULT_DELAYS_MS } from "../packages/reader-mock/src/faults";
import { WORLDS_LEADING_KEYS, actionDrift, type LambdaName } from "./iam-capabilities";
import { storageFor } from "./storage-keys";

const ACCOUNT = "776805327629";
const APP = "aws-cds-hackathon-poc-legajo";

const h = vi.hoisted(() => {
  class Out<T> {
    constructor(readonly value: T) {}
    apply<U>(fn: (value: T) => U): Out<unknown> {
      const result = fn(this.value);
      return result instanceof Out ? result : new Out(result);
    }
  }
  const unwrap = (value: unknown): unknown => (value instanceof Out ? value.value : value);
  const created: Array<{ kind: string; name: string; args: Record<string, unknown> }> = [];
  const secretValues: Record<string, string> = {};
  return { Out, unwrap, created, secretValues };
});

vi.mock("./storage", async () => {
  const keys = await import("./storage-keys");
  return {
    storageLinks: (fn: LambdaName) => {
      const needs = keys.storageFor(fn);
      return [...needs.tables, ...needs.buckets].map((name) => ({ storage: name }));
    },
    documentsBucket: { name: new h.Out("documents-bucket") },
  };
});

vi.mock("./late-links", () => ({
  lateLinks: (consumer: string, owner: string, _load: unknown, exportNames: string[], mode = "required") => ({ late: { consumer, owner, exportNames, mode } }),
  links: (...parts: unknown[]) => new h.Out(parts.flatMap((part) => h.unwrap(part))),
}));

type Args = Record<string, unknown>;

/** Deep value of a recorded argument: outputs resolved, class instances (components) kept as they are. */
function plain(value: unknown): unknown {
  const inner = h.unwrap(value);
  if (Array.isArray(inner)) return inner.map(plain);
  if (inner !== null && typeof inner === "object" && Object.getPrototypeOf(inner) === Object.prototype) {
    return Object.fromEntries(Object.entries(inner).map(([key, item]) => [key, plain(item)]));
  }
  return inner;
}

function installGlobals(): void {
  const record = (kind: string, name: string, args: Args): void => void h.created.push({ kind, name, args });
  const arnOf = (service: string, resource: string) => new h.Out(`arn:aws:${service}:us-east-1:${ACCOUNT}:${resource}`);
  class Component {
    constructor(
      readonly __kind: string,
      readonly __name: string,
      readonly args: Args,
    ) {
      record(__kind, __name, args);
    }
  }
  class FakeFunction extends Component {
    readonly arn = arnOf("lambda", `function:${this.__name}`);
    readonly name = new h.Out(`fn-${this.__name}`);
    readonly url = new h.Out(`https://${this.__name.toLowerCase()}.lambda-url.us-east-1.on.aws/`);
    readonly nodes = { role: { arn: new h.Out(`arn:aws:iam::${ACCOUNT}:role/${APP}/${this.__name}Role`) } };
    constructor(name: string, args: Args) {
      super("Function", name, args);
    }
  }
  class FakeDynamo extends Component {
    readonly name = new h.Out(`table-${this.__name}`);
    readonly arn = arnOf("dynamodb", `table/table-${this.__name}`);
    constructor(name: string, args: Args) {
      super("Dynamo", name, args);
    }
  }
  class FakeSecret extends Component {
    readonly value = new h.Out(h.secretValues[this.__name] ?? "not-connected");
    constructor(name: string) {
      super("Secret", name, {});
    }
  }
  class FakeTopic extends Component {
    readonly arn: unknown;
    constructor(name: string, args: { transform: { topic: (topic: Args) => void } }) {
      super("SnsTopic", name, args);
      const topic: Args = {};
      args.transform.topic(topic);
      this.arn = arnOf("sns", String(topic.name));
    }
    subscribe(name: string, subscriber: unknown, args: Args = {}) {
      record("SnsSubscription", name, { subscriber, ...args });
      return new h.Out({});
    }
  }
  class FakeBus extends Component {
    readonly name = new h.Out(`bus-${this.__name}`);
    readonly arn = arnOf("events", `event-bus/bus-${this.__name}`);
    constructor(name: string, args: Args = {}) {
      super("Bus", name, args);
    }
    subscribe(name: string, subscriber: unknown, args: Args = {}) {
      record("BusSubscription", name, { subscriber, ...args });
      return new h.Out({});
    }
  }
  const resource = (kind: string) =>
    class extends Component {
      constructor(name: string, args: Args) {
        super(kind, name, args);
      }
    };
  Object.assign(globalThis, {
    $app: { name: APP, stage: "poc" },
    $util: { output: (value: unknown) => (value instanceof h.Out ? value : new h.Out(value)), all: (values: unknown[]) => new h.Out(values.map(h.unwrap)) },
    sst: {
      Secret: FakeSecret,
      Linkable: resource("Linkable"),
      aws: { Function: FakeFunction, Dynamo: FakeDynamo, SnsTopic: FakeTopic, Bus: FakeBus, permission: (input: Args) => ({ type: "aws.permission", ...input }) },
    },
    aws: {
      getCallerIdentityOutput: () => ({ accountId: new h.Out(ACCOUNT) }),
      getRegionOutput: () => ({ region: new h.Out("us-east-1") }),
      lambda: { Permission: resource("LambdaPermission") },
      sns: { TopicPolicy: resource("TopicPolicy") },
    },
  });
}

async function load(phoneNumberId = "not-connected") {
  h.created.length = 0;
  h.secretValues.WhatsAppPhoneNumberId = phoneNumberId;
  vi.resetModules();
  const mocks = await import("./mocks");
  const whatsapp = await import("./messaging-whatsapp");
  const feeds = await import("./feeds");
  return { mocks, whatsapp, feeds, created: [...h.created] };
}

type Loaded = Awaited<ReturnType<typeof load>>;
type Statement = { actions: string[]; resources: string[]; conditions?: Array<{ test: string; variable: string; values: string[] }> };

const one = (loaded: Loaded, kind: string, name: string): Args => {
  const found = loaded.created.filter((item) => item.kind === kind && item.name === name);
  expect(found, `${kind} ${name}`).toHaveLength(1);
  return plain(found[0]?.args) as Args;
};
const componentName = (link: unknown): string => {
  if (link !== null && typeof link === "object") {
    if ("__name" in link) return String(link.__name);
    if ("storage" in link) return String(link.storage);
    if ("late" in link) return "late";
  }
  throw new Error("unknown link");
};
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const handlerExists = (handler: string): boolean => {
  const file = `${handler.slice(0, handler.lastIndexOf("."))}.ts`;
  return existsSync(resolve(process.cwd(), file)) && /export (?:const|async function|function) handler\b/.test(read(file));
};

installGlobals();
let loaded: Loaded;
beforeAll(async () => {
  loaded = await load();
});

describe("WhatsApp inbound topic and InboundWhatsApp", () => {
  it("names the topic as docs/architecture.md §1 and the CI bootstrap fence it", () => {
    const fixed = /\| Topic SNS de WhatsApp \| `([^`]+)` \|/.exec(read("docs/architecture.md"))?.[1];
    expect(loaded.whatsapp.WHATSAPP_TOPIC_NAME).toBe(fixed);
    expect(one(loaded, "SnsTopic", "WhatsAppInbound")).toBeDefined();
    expect(read("infra/bootstrap/ci-role.yaml")).toContain(":${AppName}-wa-inbound\"");
  });

  it("lets only End User Messaging Social publish, on behalf of this account", () => {
    const policy = JSON.parse(String(one(loaded, "TopicPolicy", "WhatsAppInboundPolicy").policy)) as { Statement: Array<Record<string, unknown>> };
    expect(policy.Statement).toEqual([
      {
        Sid: "EndUserMessagingSocialPublishes",
        Effect: "Allow",
        Principal: { Service: "social-messaging.amazonaws.com" },
        Action: "sns:Publish",
        Resource: `arn:aws:sns:us-east-1:${ACCOUNT}:${APP}-wa-inbound`,
        Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } },
      },
    ]);
  });

  it("subscribes InboundWhatsApp by ARN and points at an existing handler", () => {
    expect(one(loaded, "SnsSubscription", "InboundWhatsApp").subscriber).toBe(`arn:aws:lambda:us-east-1:${ACCOUNT}:function:InboundWhatsApp`);
    const fn = one(loaded, "Function", "InboundWhatsApp");
    expect(handlerExists(String(fn.handler))).toBe(true);
  });

  it("links its tables and Media, the channel mode, the WhatsApp secrets and the queue producer", () => {
    const link = one(loaded, "Function", "InboundWhatsApp").link as unknown[];
    const needs = storageFor("InboundWhatsApp");
    expect(link.map(componentName).sort()).toEqual(
      [...needs.tables, ...needs.buckets, "ChannelModes", "SessionTokenKey", "WabaId", "WhatsAppPhoneNumberId", "SeedOverrides", "late"].sort(),
    );
    expect(link).toContainEqual({ late: { consumer: "messaging-whatsapp", owner: "operations", exportNames: ["OperationEvents"], mode: "required" } });
  });

  it("grants no End User Messaging Social action while the phone number is not connected", () => {
    expect(one(loaded, "Function", "InboundWhatsApp").permissions).toEqual([]);
    expect(plain(loaded.whatsapp.sendWhatsAppPermissions)).toEqual([]);
  });

  it("grants sending and media only on the phone number of the secret once it is connected", async () => {
    const connected = await load("phone-number-id-0a1b2c3d");
    const phone = `arn:aws:social-messaging:us-east-1:${ACCOUNT}:phone-number-id/0a1b2c3d`;
    const permissions = one(connected, "Function", "InboundWhatsApp").permissions as Statement[];
    expect(permissions).toEqual([{ actions: ["social-messaging:SendWhatsAppMessage", "social-messaging:GetWhatsAppMessageMedia"], resources: [phone] }]);
    expect(plain(connected.whatsapp.sendWhatsAppPermissions)).toEqual([{ actions: ["social-messaging:SendWhatsAppMessage"], resources: [phone] }]);
    const generated = [...permissions.flatMap((statement) => statement.actions), ...connected.whatsapp.OPERATION_EVENTS_PRODUCER.actions];
    expect(actionDrift("InboundWhatsApp", generated)).toEqual({ extra: [], missing: [] });
  });

  it("accepts the phone id or its ARN of this account and region, and never echoes a bad value", () => {
    const { phoneNumberIdArn } = loaded.whatsapp;
    const scope = { region: "us-east-1", accountId: ACCOUNT };
    const arn = `arn:aws:social-messaging:us-east-1:${ACCOUNT}:phone-number-id/abc123`;
    expect(phoneNumberIdArn({ ...scope, phoneNumberId: "not-connected" })).toBeUndefined();
    expect(phoneNumberIdArn({ ...scope, phoneNumberId: "phone-number-id-abc123" })).toBe(arn);
    expect(phoneNumberIdArn({ ...scope, phoneNumberId: arn })).toBe(arn);
    for (const bad of ["*", "phone-number-id-*", "abc123", arn.replace(ACCOUNT, "123456789012"), `${arn}/x`, "phone-number-id-ab-cd"]) {
      const message = (() => {
        try {
          return String(phoneNumberIdArn({ ...scope, phoneNumberId: bad }));
        } catch (error) {
          return String(error);
        }
      })();
      expect(message, bad).toMatch(/must be "not-connected"/);
      if (bad.length > 1) expect(message).not.toContain(bad);
    }
  });
});

describe("Feeds bus and FeedEvents", () => {
  it("links the bus as Feeds with events:PutEvents only", () => {
    const feeds = one(loaded, "Linkable", "Feeds");
    expect(feeds.properties).toEqual({ name: "bus-FeedsBus", arn: `arn:aws:events:us-east-1:${ACCOUNT}:event-bus/bus-FeedsBus` });
    expect(feeds.include).toEqual([{ type: "aws.permission", actions: ["events:PutEvents"], resources: [`arn:aws:events:us-east-1:${ACCOUNT}:event-bus/bus-FeedsBus`] }]);
  });

  it("hands FeedEvents exactly the two events the platform mock publishes", () => {
    const subscription = one(loaded, "BusSubscription", "FeedEvents");
    expect(componentName(subscription.subscriber)).toBe("FeedEvents");
    expect(subscription.pattern).toEqual({ source: Object.values(PLATFORM_EVENT_SOURCE), detailType: [...PlatformDetailType.options] });
    expect([...PlatformDetailType.options].sort()).toEqual(["CarrierEtaChanged", "CustomsStatusChanged"]);
  });

  it("links FeedEvents to its tables, the thread key and the queue producer, as its capabilities say", () => {
    const fn = one(loaded, "Function", "FeedEvents");
    expect(handlerExists(String(fn.handler))).toBe(true);
    const link = fn.link as unknown[];
    expect(link.map(componentName).sort()).toEqual([...storageFor("FeedEvents").tables, "SessionTokenKey", "late"].sort());
    expect(link).toContainEqual({ late: { consumer: "feeds", owner: "operations", exportNames: ["OperationEvents"], mode: "required" } });
    expect(actionDrift("FeedEvents", [...loaded.whatsapp.OPERATION_EVENTS_PRODUCER.actions])).toEqual({ extra: [], missing: [] });
  });
});

describe("ReaderMock and PlatformMock", () => {
  const API = { ReaderMock: "ReaderMockApi", PlatformMock: "PlatformMockApi" } as const;

  it("serve on Function URLs with AWS_IAM, no CORS, from the packages' handlers", () => {
    for (const name of Object.values(API)) {
      const fn = one(loaded, "Function", name);
      expect(fn.url, name).toEqual({ authorization: "iam", cors: false });
      expect(handlerExists(String(fn.handler)), name).toBe(true);
    }
    // Read as text: packages/reader-mock/src/source.ts does not type-check under the infra program's globals.
    const sourceTimeoutMs = Number(/SOURCE_TIMEOUT_MS = ([\d_]+);/.exec(read("packages/reader-mock/src/source.ts"))?.[1]?.replace(/_/g, ""));
    const readerTimeout = Number(/^(\d+) seconds$/.exec(String(one(loaded, "Function", API.ReaderMock).timeout))?.[1]);
    expect(sourceTimeoutMs).toBeGreaterThan(0);
    expect(readerTimeout * 1000).toBeGreaterThan(FAULT_DELAYS_MS.timeout + sourceTimeoutMs);
  });

  it("create their tables with PK/SK, no GSI and the expiresAt TTL of docs/architecture.md §5", () => {
    const section = read("docs/architecture.md").split("## 5. DynamoDB")[1]?.split("## 6.")[0] ?? "";
    for (const [table, component] of [["ReaderCatalog", "ReaderCatalog"], ["Platform", "PlatformData"]] as const) {
      const row = section.split("\n").find((line) => line.startsWith(`| \`${table}\` |`))?.split("|").map((cell) => cell.trim());
      expect(row?.[5], `${table} GSIs`).toBe("—");
      const args = one(loaded, "Dynamo", component);
      expect(args).toEqual({ fields: { PK: "string", SK: "string" }, primaryIndex: { hashKey: "PK", rangeKey: "SK" }, ttl: "expiresAt" });
    }
  });

  it("expose the Linkables and properties the packages read", () => {
    expect(one(loaded, "Linkable", "ReaderMockConfig").properties).toEqual({ documentsBucket: "documents-bucket" });
    expect(one(loaded, "Linkable", "Platform")).toEqual({ properties: { name: "table-PlatformData" } });
    expect(read("packages/reader-mock/src/handler.ts")).toMatch(/linked\("ReaderCatalog".*\n[\s\S]*linked\("ReaderMockConfig", ConfigLink\)\.documentsBucket/);
    expect(read("packages/platform-mock/src/handler.ts")).toContain('logicalName: "Platform" | "Feeds"');
    expect(read("packages/bff/src/reader/linked.ts")).toContain('readLinked("ReaderMock", ReaderLink).url');
    expect(read("packages/bff/src/routers/deps.ts")).toContain('readLinked("PlatformMock", FunctionUrlLink).url');
    expect(componentName((one(loaded, "Function", API.ReaderMock).link as unknown[])[0])).toBe("ReaderCatalog");
    expect((one(loaded, "Function", API.PlatformMock).link as unknown[]).map(componentName)).toEqual(["Platform", "Feeds"]);
  });

  it("give every caller both identity permissions on the mock's function", () => {
    for (const [mock, name] of Object.entries(API)) {
      const arn = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${name}`;
      const linkable = one(loaded, "Linkable", mock);
      expect(linkable.properties).toEqual({ url: `https://${name.toLowerCase()}.lambda-url.us-east-1.on.aws/` });
      expect(linkable.include).toEqual([
        {
          type: "aws.permission",
          actions: ["lambda:InvokeFunctionUrl"],
          resources: [arn],
          conditions: [{ test: "StringEquals", variable: "lambda:FunctionUrlAuthType", values: ["AWS_IAM"] }],
        },
        { type: "aws.permission", actions: ["lambda:InvokeFunction"], resources: [arn] },
      ]);
    }
  });

  it("take their callers from the capabilities, as docs/architecture.md §14 lists them", () => {
    const row = /Invocantes de `ReaderMock`: ([^.]*)\. De `PlatformMock`: ([^|]*)\|/.exec(read("docs/architecture.md"));
    const names = (cell: string | undefined) => [...(cell ?? "").matchAll(/`(\w+)`/g)].map((match) => match[1]).sort();
    expect(loaded.mocks.mockInvokers("ReaderMock")).toEqual(names(row?.[1]));
    expect(loaded.mocks.mockInvokers("PlatformMock")).toEqual(names(row?.[2]));
  });

  it("add one resource-policy pair per calling role and refuse a Lambda that may not call", () => {
    const callers = [...new Set([...loaded.mocks.mockInvokers("ReaderMock"), ...loaded.mocks.mockInvokers("PlatformMock")])];
    for (const fn of callers) {
      const caller = new sst.aws.Function(`${fn}Caller`, { handler: "x.handler" });
      const permissions = loaded.mocks.grantMockInvoke(fn, caller).map((permission) => plain((permission as unknown as { args: unknown }).args));
      const role = `arn:aws:iam::${ACCOUNT}:role/${APP}/${fn}CallerRole`;
      expect(permissions, fn).toEqual(
        loaded.mocks.mocksCalledBy(fn).flatMap((mock) => [
          { action: "lambda:InvokeFunctionUrl", function: `fn-${API[mock]}`, principal: role, functionUrlAuthType: "AWS_IAM" },
          { action: "lambda:InvokeFunction", function: `fn-${API[mock]}`, principal: role, invokedViaFunctionUrl: true },
        ]),
      );
    }
    const names = h.created.filter((item) => item.kind === "LambdaPermission").map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    for (const fn of ["WorldJanitor", "InboundWhatsApp", "PlatformMock"] as const) {
      expect(() => loaded.mocks.grantMockInvoke(fn, new sst.aws.Function(`${fn}Other`, { handler: "x.handler" }))).toThrow(/MOCK_READER nor MOCK_PLATFORM/);
    }
  });

  it("link each caller to the mocks it calls and the mock tables it reaches", () => {
    const linked = (fn: LambdaName) => loaded.mocks.mockLinks(fn).map(componentName);
    expect(linked("QaDriver")).toEqual(["ReaderMock", "PlatformMock", "Platform", "ReaderCatalog"]);
    expect(linked("Bff")).toEqual(["PlatformMock", "Platform"]);
    expect(linked("OperationWorker")).toEqual(["ReaderMock"]);
    expect(linked("ToolDocuments")).toEqual(["ReaderMock"]);
    expect(linked("WorldJanitor")).toEqual(["Platform"]);
    expect(linked("InboundWhatsApp")).toEqual([]);
  });

  it("fence Platform by leading keys for the world roles and to the store's commands for the mock", () => {
    const table = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/table-PlatformData`;
    for (const role of Object.keys(WORLDS_LEADING_KEYS) as Array<keyof typeof WORLDS_LEADING_KEYS>) {
      expect(plain(loaded.mocks.mockPermissions(role)), role).toEqual([
        {
          actions: ["dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
          resources: [table],
          conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...WORLDS_LEADING_KEYS[role]] }],
        },
      ]);
    }
    expect(one(loaded, "Function", API.PlatformMock).permissions).toEqual([
      { actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"], resources: [table] },
    ]);
    for (const fn of ["ReaderMock", "OperationWorker", "InboundWhatsApp"] as const) expect(loaded.mocks.mockPermissions(fn), fn).toEqual([]);
  });

  it("cover every command the platform store sends", () => {
    const store = read("packages/platform-mock/src/dynamo-store.ts");
    const commands = [...store.matchAll(/new (\w+)Command\(/g)].map((match) => match[1]).filter((name) => name !== "TransactWrite");
    const transacted = [...store.matchAll(/\{ (Put|Update|Delete|ConditionCheck): \{/g)].map((match) => match[1]);
    const needed = [...commands, ...transacted].map((name) => `dynamodb:${name === "ConditionCheck" ? "ConditionCheckItem" : `${name}${name === "Query" ? "" : "Item"}`}`);
    expect([...new Set(needed)].sort()).toEqual([...loaded.mocks.PLATFORM_MOCK_TABLE_ACTIONS]);
  });

  it("generate exactly the actions infra/iam-capabilities.ts declares for both mocks", () => {
    expect(actionDrift("ReaderMock", [])).toEqual({ extra: [], missing: [] });
    const feedsActions = (one(loaded, "Linkable", "Feeds").include as Statement[]).flatMap((statement) => statement.actions);
    expect(actionDrift("PlatformMock", feedsActions)).toEqual({ extra: [], missing: [] });
  });
});
