import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  LAMBDA_CAPABILITIES,
  QA_DRIVER_DLQ_ONLY_ACTIONS,
  WORLDS_LEADING_KEYS,
  actionDrift,
  expectedActions,
  expectedTables,
  resolveCapabilities,
  type LambdaName,
} from "./iam-capabilities";

const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");

/** First cell of every row of the per-role table of docs/architecture.md §14 that names a Lambda. */
function documentedLambdas(): string[] {
  const section = architecture.slice(architecture.indexOf("## 14."), architecture.indexOf("## 15."));
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const cell = /^\| `([A-Za-z]+)` \|/.exec(line)?.[1];
    if (cell && !/^[A-Z_]+$/.test(cell)) names.push(cell);
  }
  return names;
}

const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];

describe("capabilities table", () => {
  it("has one entry per Lambda of docs/architecture.md §14 and nothing else", () => {
    const documented = documentedLambdas();
    expect(documented.length).toBeGreaterThan(15);
    expect([...LAMBDAS].sort()).toEqual([...documented].sort());
  });

  it("builds PIPELINE from both senders, the output guardrail and the timers", () => {
    expect(resolveCapabilities(["PIPELINE"])).toEqual(["PIPELINE", "SEND_EMAIL", "SEND_WHATSAPP", "TIMERS"]);
    expect(CAPABILITIES.PIPELINE.actions).toContain("bedrock:ApplyGuardrail");
  });

  it("grants both actions a Function URL with AWS_IAM needs since October 2025", () => {
    for (const mock of ["MOCK_READER", "MOCK_PLATFORM"] as const) {
      expect([...CAPABILITIES[mock].actions].sort()).toEqual(["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"]);
      expect(CAPABILITIES[mock].fence).toContain("lambda:FunctionUrlAuthType = AWS_IAM");
    }
  });

  it("gives WORLDS the world tables, the timers and the memory purge", () => {
    expect(resolveCapabilities(["WORLDS"])).toEqual(["MEMORY_ADMIN", "TIMERS", "WORLDS"]);
    expect(Object.keys(expectedTables("WorldJanitor")).sort()).toEqual(
      ["AuditLog", "Conversations", "Firms", "LegajoMetrics", "Operations", "Parties", "Platform", "Runtime"].sort(),
    );
  });
});

describe("WORLDS fences per role", () => {
  it("limits Platform by leading keys for every role that holds WORLDS", () => {
    const holders = LAMBDAS.filter((fn) => resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes("WORLDS"));
    expect(holders.sort()).toEqual(Object.keys(WORLDS_LEADING_KEYS).sort());
  });

  it("keeps the QA driver on QA and test-judge worlds and the janitor on judge worlds", () => {
    expect(WORLDS_LEADING_KEYS.QaDriver).toEqual(["POP#firm-qa#*", "POP#firm-sim#*", "POP#firm-judge-test#*"]);
    expect(WORLDS_LEADING_KEYS.WorldJanitor).toEqual(["POP#firm-judge-*"]);
    for (const key of WORLDS_LEADING_KEYS.Bff) expect(key).not.toMatch(/firm-qa|firm-sim/);
  });
});

describe("QaDriver", () => {
  it("reads and deletes only from the DLQ and reads only the DLQ alarm history", () => {
    const actions = expectedActions("QaDriver");
    for (const action of QA_DRIVER_DLQ_ONLY_ACTIONS) expect(actions).toContain(action);
    expect(actions).toContain("cloudwatch:DescribeAlarmHistory");
    const fence = LAMBDA_CAPABILITIES.QaDriver.fence;
    expect(fence).toContain("only on OperationEventsDlq.fifo");
    expect(fence).toContain("DescribeAlarmHistory only on the DLQ alarm");
    for (const fn of LAMBDAS.filter((name) => name !== "QaDriver")) {
      for (const action of [...QA_DRIVER_DLQ_ONLY_ACTIONS, "cloudwatch:DescribeAlarmHistory"]) expect(expectedActions(fn), fn).not.toContain(action);
    }
  });
});

describe("least privilege", () => {
  it("never grants a wildcard action", () => {
    for (const fn of LAMBDAS) for (const action of expectedActions(fn)) expect(action, fn).not.toContain("*");
  });

  it("keeps SES, End User Messaging and Guardrails away from the console BFF", () => {
    const actions = expectedActions("Bff");
    expect(actions.some((action) => action.startsWith("ses:") || action.startsWith("social-messaging:") || action.startsWith("bedrock:"))).toBe(false);
  });

  it("lets only the worker invoke the Harness", () => {
    const invokers = LAMBDAS.filter((fn) => expectedActions(fn).includes("bedrock-agentcore:InvokeHarness"));
    expect(invokers).toEqual(["OperationWorker"]);
  });

  it("reports drift between generated and declared actions", () => {
    expect(actionDrift("PlatformMock", ["events:PutEvents"])).toEqual({ extra: [], missing: [] });
    expect(actionDrift("PlatformMock", ["events:PutEvents", "ses:SendEmail"])).toEqual({ extra: ["ses:SendEmail"], missing: [] });
    expect(actionDrift("ToolFollowups", [])).toEqual({ extra: [], missing: expectedActions("ToolFollowups") });
  });
});
