import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, LAMBDA_CAPABILITIES, expectedActions } from "./iam-capabilities";
import {
  GUEST_OBJECT_PREFIXES,
  LEADS_FUNCTIONS,
  LEAD_NOTICE_LINKS,
  QA_SIGNUP_MAIL_PREFIX,
  SIGNUP_DISPATCH_LINKS,
  SIGNUP_GRANT_LINKS,
  SIGNUP_GRANT_STATEMENTS,
  SIGNUP_RUNTIME_KEYS,
  cognitoActions,
  cognitoStatement,
  guestObjectStatements,
  invokersOf,
  qaSignupMailStatements,
  signupRuntimeStatement,
  type LeadsFunction,
} from "./leads-spec";
import { SENDERS, emailLinkNames } from "./messaging-email-spec";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const architecture = read("docs/architecture.md");
const leadsModule = stripComments(read("infra/leads.ts"));
const POOL = "arn:aws:cognito-idp:us-east-1:776805327629:userpool/us-east-1_abc";
const FUNCTIONS = Object.keys(LEADS_FUNCTIONS) as LeadsFunction[];

describe("[FL-115] the lead notice to Craftech", () => {
  it("[FL-115] sends only from avisos@ to *@craftech.io through its own sender, with recipients only from LeadNoticeTo", () => {
    expect([...LEAD_NOTICE_LINKS]).toEqual(["Leads", "LeadNoticeTo", "EmailSenderLeadNotice"]);
    expect(emailLinkNames("LeadNotice")).toEqual(["EmailSenderLeadNotice"]);
    expect(SENDERS.LEAD_NOTICE.fromAddresses).toEqual(["avisos@legajo.demo.craftech.io"]);
    expect(SENDERS.LEAD_NOTICE.recipients).toEqual(["*@craftech.io"]);
    expect(expectedActions("LeadNotice")).toEqual(["ses:SendEmail"]);
    expect(architecture).toContain("`ses:FromAddress` = `avisos@legajo.demo.craftech.io`, `ForAllValues:StringLike ses:Recipients` = `*@craftech.io`");
  });

  it("[FL-115] writes no recipient address anywhere in infra/: only the domain pattern", () => {
    const files = readdirSync(resolve(process.cwd(), "infra")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    for (const file of files) expect(stripComments(read(`infra/${file}`)), file).not.toMatch(/[A-Za-z0-9._%+-]+@craftech\.io/);
  });

  it("[FL-115] is the only function that links LeadNoticeTo, and it has no Runtime nor Conversations", () => {
    const files = readdirSync(resolve(process.cwd(), "infra")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    const users = files.filter((file) => /\bLeadNoticeTo\b/.test(stripComments(read(`infra/${file}`))));
    expect(users.sort()).toEqual(["leads-spec.ts", "leads.ts", "secrets.ts"]);
    expect(leadsModule).toContain("LeadNoticeTo,\n  EmailSenderLeadNotice: emailLinks(\"LeadNotice\")[0],");
    expect(Object.keys(LAMBDA_CAPABILITIES.LeadNotice.tables)).toEqual(["Leads"]);
    expect(architecture).toContain("**Sin `Runtime` ni `Conversations`**");
  });

  it("[FL-115] is invoked asynchronously only by Bff and WorldJanitor, without Lambda retries", () => {
    expect(LEADS_FUNCTIONS.LeadNotice.invokedBy).toEqual(invokersOf("LeadNotice"));
    expect(invokersOf("LeadNotice")).toEqual(["Bff", "WorldJanitor"]);
    expect(LEADS_FUNCTIONS.LeadNotice.retries).toBe(0);
  });
});

describe("SignupDispatch (ADR-0015 §1.1 and §1.2)", () => {
  it("is invoked asynchronously only by the BFF, with no retries and a reserved concurrency of 2", () => {
    expect(LEADS_FUNCTIONS.SignupDispatch).toMatchObject({ reservedConcurrency: 2, retries: 0, invokedBy: ["Bff"] });
    expect(invokersOf("SignupDispatch")).toEqual(["Bff"]);
    expect(architecture).toContain("`SignupDispatch` 2");
    expect(architecture).toContain("Invocación asíncrona solo del rol de `Bff`; sin reintentos asíncronos; concurrencia reservada 2");
  });

  it("links the table's name, Runtime's name only, the master key and the pool, and calls Cognito only as §14 says", () => {
    expect([...SIGNUP_DISPATCH_LINKS]).toEqual(["Leads", "RuntimeKeys", "SessionTokenKey", "Auth"]);
    expect(leadsModule).toContain("{ Leads, RuntimeKeys, SessionTokenKey, Auth }");
    expect(leadsModule).toContain('asPermission(runtimeKeysStatement("SignupDispatch", Runtime.arn))');
    expect(cognitoActions("SignupDispatch")).toEqual(["cognito-idp:AdminDeleteUser", "cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser", "cognito-idp:ListUsers"]);
    expect(cognitoStatement("SignupDispatch", POOL)?.resources).toEqual([POOL]);
    expect(leadsModule).toContain('[...leadsPermissions("SignupDispatch"), ...cognitoPermissions("SignupDispatch"), asPermission(runtimeKeysStatement("SignupDispatch", Runtime.arn))]');
  });

  it("uses the reserved concurrency of docs/architecture.md §12 for both functions, and builds them from the spec", () => {
    const line = /Concurrencia reservada: (.+)$/m.exec(architecture)?.[1] ?? "";
    for (const fn of FUNCTIONS) expect(line, fn).toContain(`\`${fn}\` ${LEADS_FUNCTIONS[fn].reservedConcurrency}`);
    expect(leadsModule).toContain("concurrency: { reserved: spec.reservedConcurrency },");
    expect(leadsModule).toContain("retries: spec.retries,");
  });

  it("points at handlers WP-50 owns", () => {
    const plan = read("docs/build-plan.md");
    const wp50 = plan.slice(plan.indexOf("**WP-50 · "), plan.indexOf("**WP-51 · "));
    expect(wp50).toContain("`packages/bff/src/handlers/{lead-notice,signup-dispatch,world-janitor}.ts`");
    for (const fn of FUNCTIONS) expect(LEADS_FUNCTIONS[fn].handler).toMatch(/^packages\/bff\/src\/handlers\/(lead-notice|signup-dispatch)\.handler$/);
  });
});

describe("signupGrants (Bff by WP-32, WorldJanitor here, QaDriver by WP-32)", () => {
  it("gives the BFF the table, both functions, the origin key, the guest objects, its Cognito admin reads and its Runtime keys", () => {
    expect(SIGNUP_GRANT_LINKS.Bff).toEqual(["Leads", "SignupDispatch", "LeadNotice", "OriginVerifyKey", "GuestObjects"]);
    expect(SIGNUP_GRANT_STATEMENTS.Bff).toEqual(["leads", "cognito", "signupRuntime"]);
    expect(cognitoActions("Bff")).toEqual([...CAPABILITIES.SIGNUP_ADMIN.actions].sort());
    const runtime = signupRuntimeStatement("arn:runtime");
    expect(runtime.conditions).toEqual([{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["RL#*", "QUOTA#*", "SLOT#*", "GUESTWORLD#*"] }]);
    expect([...SIGNUP_RUNTIME_KEYS]).toEqual(["RL#*", "QUOTA#*", "SLOT#*", "GUESTWORLD#*"]);
  });

  it("gives WorldJanitor the table, LeadNotice, the pool and the guest objects, never SignupDispatch nor the origin key", () => {
    expect(SIGNUP_GRANT_LINKS.WorldJanitor).toEqual(["Leads", "LeadNotice", "Auth", "GuestObjects"]);
    expect(SIGNUP_GRANT_LINKS.WorldJanitor).not.toContain("SignupDispatch");
    expect(SIGNUP_GRANT_LINKS.WorldJanitor).not.toContain("OriginVerifyKey");
    expect(cognitoActions("WorldJanitor")).toEqual(
      ["cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminDeleteUser", "cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser", "cognito-idp:ListUsers"],
    );
  });

  it("deletes only the guest prefixes of §14 when it destroys a guest world", () => {
    expect(GUEST_OBJECT_PREFIXES).toEqual({ Documents: ["guest/"], Media: ["guest/"], Uploads: ["uploads/"], InboundMail: ["poc/ops/", "poc/sim/"] });
    const statements = guestObjectStatements({ Documents: "docs", Media: "media", Uploads: "uploads", InboundMail: "mail" });
    const deletes = statements.filter((statement) => statement.actions.includes("s3:DeleteObject")).flatMap((statement) => statement.resources);
    expect(deletes).toEqual(["arn:aws:s3:::docs/guest/*", "arn:aws:s3:::media/guest/*", "arn:aws:s3:::uploads/uploads/*", "arn:aws:s3:::mail/poc/ops/*", "arn:aws:s3:::mail/poc/sim/*"]);
    for (const list of statements.filter((statement) => statement.actions.includes("s3:ListBucket"))) {
      expect(list.resources[0]).toMatch(/^arn:aws:s3:::[a-z]+$/);
      expect(list.conditions?.[0]?.variable).toBe("s3:prefix");
    }
    expect(architecture).toContain("`s3:DeleteObject` y `s3:ListBucket` sobre `guest/*` de `Documents` y `Media`, `uploads/*` de `Uploads` y `poc/ops/*`, `poc/sim/*` del bucket de correo");
  });

  it("gives the QaDriver only the SC-26 actions (its leads, the codes of poc/sim/ and three Cognito calls) and the guest objects of world.destroy", () => {
    expect(SIGNUP_GRANT_LINKS.QaDriver).toEqual(["Leads", "InboundMailSim", "GuestObjects"]);
    expect(SIGNUP_GRANT_STATEMENTS.QaDriver).toEqual(["leads", "cognito", "qaSignupMail"]);
    expect(QA_SIGNUP_MAIL_PREFIX).toBe("poc/sim/");
    expect(qaSignupMailStatements("mail")).toEqual([
      { actions: ["s3:GetObject"], resources: ["arn:aws:s3:::mail/poc/sim/*"] },
      { actions: ["s3:ListBucket"], resources: ["arn:aws:s3:::mail"], conditions: [{ test: "StringLike", variable: "s3:prefix", values: ["poc/sim/*"] }] },
    ]);
    expect(cognitoActions("QaDriver")).toEqual(["cognito-idp:AdminDeleteUser", "cognito-idp:AdminGetUser", "cognito-idp:ListUsers"]);
  });

  it("is exported by infra/leads.ts for WP-32 and applied to WorldJanitor by infra/scheduler.ts", () => {
    expect(leadsModule).toContain("export function signupGrants(fn: SignupGrantRole): SignupGrants {");
    expect(stripComments(read("infra/scheduler.ts"))).toContain('signupGrants("WorldJanitor")');
    expect(stripComments(read("infra/scheduler.ts"))).not.toMatch(/signupGrants\("(Bff|QaDriver)"\)/);
  });
});

describe("one signup flow, no modes (ADR-0015 §1.4)", () => {
  it("has no setting, secret or build variable that changes the signup, the CTA or robots", () => {
    const files = [...readdirSync(resolve(process.cwd(), "infra")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).map((file) => `infra/${file}`), "sst.config.ts"];
    for (const file of files) expect(stripComments(read(file)), file).not.toMatch(/SignupMode|signup-mode|SIGNUP_MODE|waitlist|WAITLIST|ROBOTS/i);
  });
});
