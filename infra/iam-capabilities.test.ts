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

/** The text of the row of docs/architecture.md §14 whose first cell is `name`. */
function documentedRow(name: string): string {
  const section = architecture.slice(architecture.indexOf("## 14."), architecture.indexOf("## 15."));
  return section.split("\n").find((line) => line.startsWith(`| \`${name}\` |`)) ?? "";
}

/** Every `cognito-idp:{A, B}` (or `cognito-idp:A`) a §14 row names, as full action names. */
function documentedCognitoActions(row: string): string[] {
  const actions = new Set<string>();
  for (const match of row.matchAll(/cognito-idp:\{([^}]+)\}/g)) for (const name of (match[1] ?? "").split(",")) actions.add(`cognito-idp:${name.trim()}`);
  return [...actions].sort();
}

const cognitoActions = (fn: LambdaName): string[] => expectedActions(fn).filter((action) => action.startsWith("cognito-idp:"));

describe("capabilities table", () => {
  it("has one entry per Lambda of docs/architecture.md §14 and nothing else", () => {
    const documented = documentedLambdas();
    expect(documented.length).toBeGreaterThan(20);
    expect([...LAMBDAS].sort()).toEqual([...documented].sort());
  });

  it("has the rows of the public signup as §14 states them (ADR-0015)", () => {
    // The Cognito triggers: no table but what each reads, never Leads.
    expect(expectedTables("AuthPreSignUp")).toEqual({});
    expect(documentedRow("AuthPreSignUp")).toContain("ninguna tabla");
    expect(expectedTables("AuthPreToken")).toEqual({ Firms: "read" });
    expect(documentedRow("AuthPreToken")).toContain("DynamoDB `Firms` (lectura");
    expect(expectedTables("AuthCustomMessage")).toEqual({ Runtime: "write" });
    expect(documentedRow("AuthCustomMessage")).toContain("**Sin `Leads`**");
    for (const trigger of ["AuthPreSignUp", "AuthPreToken", "AuthCustomMessage"] as const) {
      expect(expectedActions(trigger), trigger).toEqual([]);
      expect(LAMBDA_CAPABILITIES[trigger].fence, trigger).toContain("invoked only by cognito-idp.amazonaws.com with the pool as SourceArn");
    }
    // SignupDispatch: Leads and Runtime, the Cognito reads and the fenced delete, never LeadNotice.
    expect(expectedTables("SignupDispatch")).toEqual({ Leads: "write", Runtime: "write" });
    expect(expectedActions("SignupDispatch")).not.toContain("lambda:InvokeFunction");
    expect(LAMBDA_CAPABILITIES.SignupDispatch.fence).toContain("never writes a lead");
    expect(LAMBDA_CAPABILITIES.SignupDispatch.fence).toContain("no InvokeFunction of LeadNotice");
    // LeadNotice: Leads and its own sender, without Runtime or Conversations.
    expect(expectedTables("LeadNotice")).toEqual({ Leads: "write" });
    expect(expectedActions("LeadNotice")).toEqual(["ses:SendEmail"]);
    for (const fragment of ["ses:FromAddress avisos@legajo.demo.craftech.io", "ses:Recipients *@craftech.io", "no Runtime, no Conversations"]) {
      expect(LAMBDA_CAPABILITIES.LeadNotice.fence).toContain(fragment);
    }
    expect(documentedRow("LeadNotice")).toContain("`ForAllValues:StringLike ses:Recipients` = `*@craftech.io`");
  });

  it("grants every Lambda exactly the cognito-idp actions its §14 row names", () => {
    const holders = LAMBDAS.filter((fn) => cognitoActions(fn).length > 0).sort();
    expect(holders).toEqual(["Bff", "QaDriver", "SignupDispatch", "WorldJanitor"]);
    for (const fn of ["Bff", "SignupDispatch", "WorldJanitor"] as const) expect(cognitoActions(fn), fn).toEqual(documentedCognitoActions(documentedRow(fn)));
    // The QaDriver row also names the BFF's (it runs the appRouter): its own set is the SC-26 one.
    const qaRow = documentedRow("QaDriver");
    const sc26 = qaRow.slice(qaRow.indexOf("`lead.purge` (`SC-26`)"));
    expect(cognitoActions("QaDriver")).toEqual(documentedCognitoActions(sc26));
    expect(cognitoActions("Bff")).not.toContain("cognito-idp:AdminDeleteUser");
  });

  it("gives ChannelEvents the bounce state of a recipient and never Leads", () => {
    expect(resolveCapabilities(LAMBDA_CAPABILITIES.ChannelEvents.capabilities)).toEqual(["MAIL_STATUS"]);
    expect(expectedTables("ChannelEvents")).toEqual({ Conversations: "write", Runtime: "write" });
    for (const fragment of ["MAILSTATUS#", "RL#MAILBAD#", "MAILBREAKER", "lead-email"]) expect(CAPABILITIES.MAIL_STATUS.fence).toContain(fragment);
    expect(documentedRow("ChannelEvents")).toContain("**Sin `Leads`**");
  });

  it("lets only the BFF invoke SignupDispatch, and only the BFF and WorldJanitor invoke LeadNotice", () => {
    const holders = (capability: "SIGNUP_DISPATCH" | "LEAD_NOTICE") => LAMBDAS.filter((fn) => resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes(capability)).sort();
    expect(holders("SIGNUP_DISPATCH")).toEqual(["Bff"]);
    expect(holders("LEAD_NOTICE")).toEqual(["Bff", "WorldJanitor"]);
    expect(documentedRow("SignupDispatch")).toContain("Invocación asíncrona solo del rol de `Bff`");
    expect(documentedRow("LeadNotice")).toContain("Invocación asíncrona solo de los roles de `Bff` y `WorldJanitor`");
  });

  it("puts both Function URLs of the edge behind OAC", () => {
    for (const fn of ["Bff", "PublicWeb"] as const) {
      expect(LAMBDA_CAPABILITIES[fn].fence, fn).toContain("Function URL AWS_IAM, only cloudfront.amazonaws.com with the distribution as SourceArn (OAC)");
      expect(documentedRow(fn), fn).toContain("Function URL `AWS_IAM`: solo `cloudfront.amazonaws.com` con `SourceArn` de la distribución (OAC)");
    }
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
    expect(Object.keys(CAPABILITIES.WORLDS.tables ?? {}).sort()).toEqual(
      ["AuditLog", "Conversations", "Firms", "LegajoMetrics", "Operations", "Parties", "Platform", "Runtime"].sort(),
    );
    // WorldJanitor adds the leads' sweep and retention (ADR-0015 §5).
    expect(Object.keys(expectedTables("WorldJanitor")).sort()).toEqual([...Object.keys(CAPABILITIES.WORLDS.tables ?? {}), "Leads"].sort());
  });
});

describe("WORLDS fences per role", () => {
  it("limits Platform by leading keys for every role that holds WORLDS", () => {
    const holders = LAMBDAS.filter((fn) => resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes("WORLDS"));
    expect(holders.sort()).toEqual(Object.keys(WORLDS_LEADING_KEYS).sort());
  });

  it("keeps the QA driver on QA and guest-test worlds and the janitor on guest worlds", () => {
    expect(WORLDS_LEADING_KEYS.QaDriver).toEqual(["POP#firm-qa#*", "POP#firm-sim#*", "POP#firm-guest-test#*"]);
    expect(WORLDS_LEADING_KEYS.WorldJanitor).toEqual(["POP#firm-guest-*"]);
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
