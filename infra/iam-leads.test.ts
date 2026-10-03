// Who touches `Leads` (ADR-0015 §6, docs/architecture.md §3, §5 and §14), asserted on the capabilities
// table every module builds its permissions from (infra/iam-capabilities.ts) and on the per-role
// statements of infra/leads-spec.ts. The list is closed: Bff, SignupDispatch, WorldJanitor, LeadNotice
// and, fenced to SC-26, the QaDriver; never ChannelEvents, the Cognito triggers, the worker, the tools
// or PolicyAudit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LAMBDA_CAPABILITIES, expectedActions, expectedTables, type LambdaName } from "./iam-capabilities";
import { LEADS_ACCESS, LEADS_ROLES, LEAD_WRITE_ACTIONS, RUNTIME_KEY_FENCES, RUNTIME_KEYS_LINK, SIGNUP_DISPATCH_LINKS, leadsStatement, runtimeKeysStatement } from "./leads-spec";
import { FENCED_TABLES, KEY_FENCED_TABLES, storageFor } from "./storage-keys";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];
const reachesLeads = (fn: LambdaName): boolean => "Leads" in expectedTables(fn);
const TABLE = "arn:aws:dynamodb:us-east-1:776805327629:table/aws-cds-hackathon-poc-legajo-poc-LeadsDataTable-abc";

describe("[FL-121] the lead data never leaves Leads", () => {
  it("[FL-121] reaches Leads only from the closed list of ADR-0015 §6", () => {
    expect(LAMBDAS.filter(reachesLeads).sort()).toEqual([...LEADS_ROLES].sort());
    expect(Object.keys(LEADS_ACCESS).sort()).toEqual([...LEADS_ROLES].sort());
    const adr = read("docs/adr/0015-alta-publica-de-invitados-y-leads.md");
    for (const fn of LEADS_ROLES) expect(adr, fn).toContain(`\`${fn}\``);
    expect(adr).toContain("**Nunca** el worker, las tools, `PolicyAudit`, `ChannelEvents` ni los triggers de Cognito");
  });

  it("[FL-121] keeps Leads away from ChannelEvents, the Cognito triggers, the worker, the tools and PolicyAudit", () => {
    const never: LambdaName[] = ["ChannelEvents", "AuthCustomMessage", "AuthPreSignUp", "AuthPreToken", "OperationWorker", "PolicyAudit"];
    for (const fn of [...never, ...LAMBDAS.filter((name) => name.startsWith("Tool"))]) expect(reachesLeads(fn), fn).toBe(false);
  });

  it("[FL-121] never links Leads whole: every role gets only its own statement", () => {
    expect(FENCED_TABLES).toContain("Leads");
    for (const fn of LAMBDAS) {
      expect(storageFor(fn).tables as string[], fn).not.toContain("Leads");
      expect(storageFor(fn).fencedTables.includes("Leads"), fn).toBe(reachesLeads(fn));
    }
    for (const fn of LEADS_ROLES) for (const action of LEADS_ACCESS[fn].actions) expect(action, fn).toMatch(/^dynamodb:[A-Z][A-Za-z]+$/);
  });

  it("[FL-121] lets SignupDispatch read, update and delete its own SIGNUP# only, never write a lead nor invoke LeadNotice (§1.4)", () => {
    const statement = leadsStatement("SignupDispatch", TABLE);
    expect(statement.actions).toEqual(["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(statement.conditions).toEqual([{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["SIGNUP#*"] }]);
    for (const action of LEAD_WRITE_ACTIONS) expect(statement.actions).not.toContain(action);
    expect(expectedActions("SignupDispatch")).not.toContain("lambda:InvokeFunction");
    expect(read("docs/architecture.md")).toContain("| `SignupDispatch` | DynamoDB `Leads` (`GetItem`, `UpdateItem` y `DeleteItem` de `SIGNUP#`, nada sobre `LEAD`");
  });

  it("[FL-121] lets LeadNotice read a lead and write its noticeStatus, without Runtime or Conversations", () => {
    expect(expectedTables("LeadNotice")).toEqual({ Leads: "write" });
    const statement = leadsStatement("LeadNotice", TABLE);
    expect(statement.actions).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(statement.conditions?.[0]?.values).toEqual(["EMAIL#*"]);
  });

  it("[FL-121] gives write access to a lead item only to finalizeSignup (Bff), the sweep (WorldJanitor) and SC-26's cleanup (QaDriver)", () => {
    const writers = LEADS_ROLES.filter((fn) => LEADS_ACCESS[fn].actions.some((action) => (LEAD_WRITE_ACTIONS as readonly string[]).includes(action)));
    expect([...writers].sort()).toEqual(["Bff", "QaDriver", "WorldJanitor"]);
    expect(leadsStatement("Bff", TABLE).conditions?.[0]?.values).toEqual(["EMAIL#*", "SIGNUP#*"]);
    for (const fn of LEADS_ROLES) expect(LEADS_ACCESS[fn].actions, fn).not.toContain("dynamodb:*");
  });

  it("[FL-121] fences the QaDriver to the SC-26 actions of docs/test-plan.md §4.1", () => {
    expect([...LEADS_ACCESS.QaDriver.actions].sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan"]);
    expect(LAMBDA_CAPABILITIES.QaDriver.capabilities).toContain("QA_SIGNUP");
    expect(read("docs/architecture.md")).toContain("DynamoDB `Leads` (`GetItem`, `Query`, `DeleteItem`, `PutItem`)");
  });
});

describe("Runtime of the signup's dispatcher and of the Cognito trigger, by key only (docs/architecture.md §14)", () => {
  const RUNTIME = "arn:aws:dynamodb:us-east-1:776805327629:table/aws-cds-hackathon-poc-legajo-poc-RuntimeTable-abc";
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const reaches = (keys: readonly string[], pk: string) => keys.some((key) => glob(key).test(pk));

  it.each(["SignupDispatch", "AuthCustomMessage"] as const)("%s never links Runtime whole: name-only link plus a key-fenced statement", (fn) => {
    expect(Object.keys(KEY_FENCED_TABLES)).toContain(fn);
    expect(storageFor(fn).tables as string[]).not.toContain("Runtime");
    expect(storageFor(fn).fencedTables as string[]).toContain("Runtime");
    const statement = runtimeKeysStatement(fn, RUNTIME);
    expect(statement.actions).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
    expect(statement.resources).toEqual([RUNTIME]);
    expect(statement.conditions).toEqual([{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...(RUNTIME_KEY_FENCES[fn].leadingKeys ?? [])] }]);
    for (const pk of ["LINK#tok123", "SLOT#GUEST#41", "GUESTWORLD#sub-1", "PENDING#mail-1", "MAIL#x", "SESSION#1", "QUOTA#GUEST#x", "CLOCK#c1"]) expect(reaches(statement.conditions?.[0]?.values ?? [], pk), `${fn} ${pk}`).toBe(false);
    for (const pk of ["MAILSTATUS#abc", "MAILBREAKER"]) expect(reaches(statement.conditions?.[0]?.values ?? [], pk), `${fn} ${pk}`).toBe(true);
  });

  it("each role reaches only its own counters", () => {
    const dispatch = RUNTIME_KEY_FENCES.SignupDispatch.leadingKeys ?? [];
    const trigger = RUNTIME_KEY_FENCES.AuthCustomMessage.leadingKeys ?? [];
    expect(reaches(dispatch, "RL#START#EMAIL#h#2026-10-14")).toBe(true);
    expect(reaches(dispatch, "RL#MAIL#RCPT#h#2026-10-14")).toBe(false);
    expect(reaches(trigger, "RL#MAIL#RCPT#h#2026-10-14")).toBe(true);
    expect(reaches(trigger, "RL#START#IP#h#2026-10-14T13")).toBe(false);
  });

  it("links RuntimeKeys, never Runtime, in both modules", () => {
    expect([...SIGNUP_DISPATCH_LINKS]).toContain(RUNTIME_KEYS_LINK);
    expect([...SIGNUP_DISPATCH_LINKS]).not.toContain("Runtime");
    const auth = read("infra/auth.ts");
    expect(auth).toContain("tableLinks([RUNTIME_KEYS_LINK])");
    expect(auth).not.toContain('tableLinks(["Runtime"])');
    expect(read("infra/storage-tables.ts")).toContain('new sst.Linkable("RuntimeKeys", { properties: { name: Runtime.name } })');
    for (const row of ["| `SignupDispatch` |", "| `AuthCustomMessage` |"]) {
      const line = read("docs/architecture.md").split("\n").find((entry) => entry.startsWith(row)) ?? "";
      expect(line, row).toContain("`RuntimeKeys`");
      expect(line, row).toContain("`MAILSTATUS#*`, `MAILBREAKER`");
    }
  });
});
