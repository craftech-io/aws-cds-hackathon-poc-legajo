import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTICES_ADDRESS } from "../packages/shared/src/addresses";
import { parsePlan } from "../scripts/lint/wp-ownership";
import { CAPABILITIES, LAMBDA_CAPABILITIES, actionDrift, expectedActions, type LambdaName } from "./iam-capabilities";
import {
  CONFIGURATION_SETS, DKIM_TOKEN_COUNT, DMARC_RECORD, EMAIL_DNS_RECORDS, EMAIL_DOMAINS, EMAIL_EVENTS, EMAIL_FUNCTIONS, INBOUND_MAIL_LINKS,
  INBOUND_MAIL_READERS, LATE_LINKS, MAIL_FROM_SPF_RECORD, QUARANTINE_LINK, RECEIPT_LAMBDA_INVOCATION, RECEIPT_RULE_SCAN, RECEIPT_RULE_TLS_POLICY,
  SENDERS, SENDER_PROFILES, assertEmailDomains, assertSesRegion, configurationSetName, demoRecipientEmails, dkimRecord, emailEventPattern,
  emailLinkNames, generatedActions, generatedBuckets, quarantineObjectArns, receiptRules, s3ObjectsArn, sendStatement, senderProfileOf,
  type EmailFunction, type IamStatement, type SenderProfile,
} from "./messaging-email-spec";
import { expectedBuckets, inboundRuleSetName, receiptRuleArn, sesDeliveryStatements } from "./storage-keys";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const architecture = read("docs/architecture.md");
const integrations = read("docs/architecture-integrations.md");
const bootstrap = read("infra/bootstrap/ci-role.yaml");
const deployWorkflow = read(".github/workflows/deploy.yml");
const dnsModule = read("infra/dns.ts");
const emailModule = stripComments(read("infra/messaging-email.ts"));

const APP = "aws-cds-hackathon-poc-legajo";
const STAGE = "poc";
const SCOPE = { account: "776805327629", region: "us-east-1", app: APP, stage: STAGE };
const DEMO = ["ops-team@mail.craftech.io"];
const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];
const EMAIL_FUNCTION_NAMES = Object.keys(EMAIL_FUNCTIONS) as EmailFunction[];

/** IAM `StringLike`: `*` is any run of characters, `?` exactly one, case-sensitive. */
function stringLike(value: string, pattern: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}

const valuesOf = (statement: IamStatement, test: string, variable: string): string[] =>
  statement.conditions.find((condition) => condition.test === test && condition.variable === variable)?.values ?? [];

/** What the statement lets through: the From, and EVERY recipient (ForAllValues), with the key present. */
function iamAllows(statement: IamStatement, from: string, recipients: string[]): boolean {
  const fromOk = valuesOf(statement, "StringLike", "ses:FromAddress").some((pattern) => stringLike(from, pattern));
  const present = valuesOf(statement, "Null", "ses:Recipients")[0] === "false" && recipients.length > 0;
  const allowed = valuesOf(statement, "ForAllValues:StringLike", "ses:Recipients");
  return fromOk && present && recipients.every((recipient) => allowed.some((pattern) => stringLike(recipient, pattern)));
}

const statement = (profile: SenderProfile): IamStatement => sendStatement(profile, SCOPE, DEMO);
const OP = "op-4471-k7p2q9@legajo.demo.craftech.io";
const QA_OP = "op-7012-m3v8xa@legajo.demo.craftech.io";
const RESERVED = ["x@shop.example", "x@example.com", "x@mail.example.net", "x@host.test", "x@a.invalid", "x@localhost"];

describe("domains", () => {
  it("sends and receives on legajo.demo.craftech.io, sim. and the bounce. MAIL FROM", () => {
    expect(EMAIL_DOMAINS).toEqual({ app: "legajo.demo.craftech.io", sim: "sim.legajo.demo.craftech.io", mailFrom: "bounce.legajo.demo.craftech.io" });
    expect(architecture).toContain("MAIL FROM `bounce.legajo.demo.craftech.io`");
  });

  it("names the same domains as infra/dns.ts, and a drift fails the deploy", () => {
    const sub = /PRODUCT_SUBDOMAIN = "([a-z]+)"/.exec(dnsModule)?.[1];
    const zone = /ZONE_NAME = "([a-z.]+)"/.exec(dnsModule)?.[1];
    expect(dnsModule).toContain("export const simDomain = `sim.${appDomain}`;");
    expect(dnsModule).toContain("export const mailFromDomain = `bounce.${appDomain}`;");
    const app = `${sub}.${zone}`;
    expect(() => assertEmailDomains({ app, sim: `sim.${app}`, mailFrom: `bounce.${app}` })).not.toThrow();
    expect(() => assertEmailDomains({ ...EMAIL_DOMAINS, sim: `mail.${app}` })).toThrow(/sim domain/);
    expect(emailModule).toContain("assertEmailDomains({ app: appDomain, sim: simDomain, mailFrom: mailFromDomain });");
  });

  it("fails the deploy outside SES's region", () => {
    expect(() => assertSesRegion("us-east-1")).not.toThrow();
    expect(() => assertSesRegion("sa-east-1")).toThrow(/us-east-1/);
  });
});

describe("DNS records: DMARC, MX and MAIL FROM", () => {
  const byName = (type: string, name: string) => EMAIL_DNS_RECORDS.filter((record) => record.type === type && record.name === name);

  it("publishes DMARC p=reject with relaxed alignment for both domains we send from or receive for", () => {
    expect(DMARC_RECORD).toBe("v=DMARC1; p=reject; adkim=r; aspf=r");
    for (const name of ["_dmarc.legajo.demo.craftech.io", "_dmarc.sim.legajo.demo.craftech.io"]) {
      expect(byName("TXT", name).map((record) => record.records)).toEqual([[DMARC_RECORD]]);
      expect(architecture).toContain(`\`${name}\``);
    }
    expect(architecture).toContain(`\`${DMARC_RECORD}\``);
    expect(EMAIL_DNS_RECORDS.filter((record) => record.name.startsWith("_dmarc.")).length).toBe(2);
  });

  it("routes mail for legajo. and sim. to SES inbound of the region", () => {
    for (const name of [EMAIL_DOMAINS.app, EMAIL_DOMAINS.sim]) {
      expect(byName("MX", name).map((record) => record.records)).toEqual([["10 inbound-smtp.us-east-1.amazonaws.com"]]);
    }
  });

  it("gives the MAIL FROM domain the SES feedback MX and an SPF that only allows SES", () => {
    expect(byName("MX", EMAIL_DOMAINS.mailFrom).map((record) => record.records)).toEqual([["10 feedback-smtp.us-east-1.amazonses.com"]]);
    expect(byName("TXT", EMAIL_DOMAINS.mailFrom).map((record) => record.records)).toEqual([[MAIL_FROM_SPF_RECORD]]);
    expect(architecture).toContain(`TXT SPF \`${MAIL_FROM_SPF_RECORD}\``);
  });

  it("stays inside the record names the CI deploy role may change, once each", () => {
    expect(bootstrap).toMatch(/route53:ChangeResourceRecordSetsNormalizedRecordNames:\s*- !Ref AppDomain\s*- !Sub "\*\.\$\{AppDomain\}"/);
    const names = [...EMAIL_DNS_RECORDS.map((record) => record.name), dkimRecord("abc123", EMAIL_DOMAINS.app).name];
    for (const name of names) expect(name === EMAIL_DOMAINS.app || name.endsWith(`.${EMAIL_DOMAINS.app}`), name).toBe(true);
    const keys = EMAIL_DNS_RECORDS.map((record) => `${record.type} ${record.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(EMAIL_DNS_RECORDS.map((record) => record.logicalName)).size).toBe(EMAIL_DNS_RECORDS.length);
  });

  it("describes the Easy DKIM CNAMEs and refuses a malformed token", () => {
    expect(DKIM_TOKEN_COUNT).toBe(3);
    expect(dkimRecord("abc123", EMAIL_DOMAINS.app)).toEqual({ name: "abc123._domainkey.legajo.demo.craftech.io", value: "abc123.dkim.amazonses.com" });
    expect(() => dkimRecord("abc.evil", EMAIL_DOMAINS.app)).toThrow();
  });
});

describe("configuration sets and events", () => {
  it("keeps the fixed names of docs/architecture.md §1, fenced by name in the bootstrap", () => {
    expect(configurationSetName(APP, STAGE, "email")).toBe("aws-cds-hackathon-poc-legajo-email-poc");
    expect(configurationSetName(APP, STAGE, "sim")).toBe("aws-cds-hackathon-poc-legajo-sim-poc");
    for (const purpose of ["email", "sim"] as const) {
      expect(architecture).toContain(`\`${configurationSetName(APP, STAGE, purpose)}\``);
      expect(bootstrap).toContain(`configuration-set/\${AppName}-${purpose}-\${DeployStage}`);
    }
  });

  it("publishes events only from the email set; the simulator's set suppresses nothing", () => {
    expect(CONFIGURATION_SETS.email.events).toBe(true);
    expect(CONFIGURATION_SETS.sim.events).toBe(false);
    expect(CONFIGURATION_SETS.email.suppressedReasons).toEqual(["BOUNCE", "COMPLAINT"]);
    expect(CONFIGURATION_SETS.sim.suppressedReasons).toEqual([]);
  });

  it("consumes exactly the events of docs/architecture-integrations.md §1, never OPEN or CLICK", () => {
    const row = integrations.split("\n").find((line) => line.startsWith("| Eventos |")) ?? "";
    const documented = [...(row.split("; sin")[0] ?? "").matchAll(/`([A-Z_]+)`/g)].map((match) => match[1]);
    expect(EMAIL_EVENTS.map((event) => event.sesType)).toEqual(documented);
    expect(row).toContain(`ses:configuration-set = ${configurationSetName(APP, STAGE, "email")}`);
    const detailTypes = EMAIL_EVENTS.map((event) => event.detailType);
    expect(new Set(detailTypes).size).toBe(detailTypes.length);
    for (const detailType of detailTypes) expect(detailType).toMatch(/^Email [A-Z]/);
    expect(emailModule).not.toMatch(/trackingOptions/);
  });

  it("filters the shared default bus by the email set only", () => {
    const pattern = emailEventPattern(configurationSetName(APP, STAGE, "email"));
    expect(pattern.source).toEqual(["aws.ses"]);
    expect(pattern.detailType).toEqual(EMAIL_EVENTS.map((event) => event.detailType));
    expect(pattern.detail.mail.tags["ses:configuration-set"]).toEqual(["aws-cds-hackathon-poc-legajo-email-poc"]);
  });
});

describe("receipt rules", () => {
  const rules = receiptRules(STAGE);

  it("keep the one rule set of docs/architecture.md §1, fenced by ARN in the bootstrap", () => {
    expect(inboundRuleSetName(APP)).toBe("aws-cds-hackathon-poc-legajo-inbound");
    expect(architecture).toContain("| Receipt rule set SES activo | `aws-cds-hackathon-poc-legajo-inbound` |");
    expect(bootstrap).toContain("receipt-rule-set/${AppName}-inbound:receipt-rule/*");
  });

  it("are the two rules of the table of docs/architecture.md §2", () => {
    const documented = [...architecture.matchAll(/^\| `([a-z]+-poc)` \| `([^`]+)` \| S3 `[^`]*?(poc\/[a-z]+\/)` → Lambda `([A-Za-z]+)` \(`Event`\) \|$/gm)].map(
      (match) => ({ rule: match[1], recipients: [match[2]], prefix: match[3], fn: match[4] }),
    );
    expect(rules.map(({ rule, recipients, prefix, fn }) => ({ rule, recipients, prefix, fn }))).toEqual(documented);
    expect(documented).toHaveLength(2);
    expect(RECEIPT_LAMBDA_INVOCATION).toBe("Event");
  });

  it("scan spam and viruses and require TLS on every rule", () => {
    expect(RECEIPT_RULE_SCAN).toBe(true);
    expect(architecture).toContain("Las dos con `scanEnabled: true`");
    expect(RECEIPT_RULE_TLS_POLICY).toBe("Require");
  });

  it("write where the mail bucket policy lets exactly these rules write", () => {
    const statements = sesDeliveryStatements({ app: APP, stage: STAGE, region: SCOPE.region, accountId: SCOPE.account });
    expect(statements.map((entry) => entry.paths)).toEqual(rules.map((rule) => [`${rule.prefix}*`]));
    const trusted = statements.map((entry) => entry.conditions.find((condition) => condition.variable === "aws:SourceArn")?.values);
    expect(trusted).toEqual(rules.map((rule) => [receiptRuleArn(SCOPE.region, SCOPE.account, APP, rule.rule)]));
  });

  it("match a bare domain each, so the two routes never overlap", () => {
    for (const rule of rules) for (const recipient of rule.recipients) expect(recipient).toMatch(/^[a-z]/);
    expect(new Set(rules.flatMap((rule) => rule.recipients)).size).toBe(2);
  });
});

describe("send statements: the IAM half of the recipient fence", () => {
  it("grant only the SEND_EMAIL action on the identity and the profile's own configuration set", () => {
    for (const profile of SENDER_PROFILES) {
      const current = statement(profile);
      expect(current.actions).toEqual([...CAPABILITIES.SEND_EMAIL.actions]);
      expect(current.resources).toEqual([
        "arn:aws:ses:us-east-1:776805327629:identity/legajo.demo.craftech.io",
        `arn:aws:ses:us-east-1:776805327629:configuration-set/${configurationSetName(APP, STAGE, SENDERS[profile].configurationSet)}`,
      ]);
      expect(valuesOf(current, "Null", "ses:Recipients")).toEqual(["false"]);
    }
  });

  it("stay under the ceiling of the permissions boundary of every role", () => {
    const start = bootstrap.indexOf("Sid: SesSendAsThisApp");
    const boundary = bootstrap.slice(start, bootstrap.indexOf("- Sid:", start));
    expect(boundary).toContain("- ses:SendEmail");
    for (const resource of ["identity/${AppDomain}", "configuration-set/${AppName}-email-${DeployStage}", "configuration-set/${AppName}-sim-${DeployStage}"]) {
      expect(boundary).toContain(resource);
    }
  });

  it("SYSTEM: from op-*@ or avisos@ to simulated mailboxes, the SES simulator and registered demo recipients only", () => {
    const system = statement("SYSTEM");
    expect(iamAllows(system, NOTICES_ADDRESS, ["estudio-delta@sim.legajo.demo.craftech.io"])).toBe(true);
    expect(iamAllows(system, OP, ["supplier-qingdao@sim.legajo.demo.craftech.io", "bounce@simulator.amazonses.com"])).toBe(true);
    expect(iamAllows(system, OP, DEMO)).toBe(true);
    expect(iamAllows(system, OP, [QA_OP])).toBe(false);
    expect(iamAllows(system, OP, ["someone-else@mail.craftech.io"])).toBe(false);
    expect(iamAllows(system, OP, ["supplier-qingdao@sim.legajo.demo.craftech.io", "x@elsewhere.io"])).toBe(false);
    expect(iamAllows(system, "supplier-qingdao@sim.legajo.demo.craftech.io", ["estudio-delta@sim.legajo.demo.craftech.io"])).toBe(false);
    expect(iamAllows(system, "no-reply@legajo.demo.craftech.io", ["estudio-delta@sim.legajo.demo.craftech.io"])).toBe(false);
  });

  it("SIMULATOR: from a simulated mailbox to an operation thread only", () => {
    const simulator = statement("SIMULATOR");
    expect(iamAllows(simulator, "supplier-qingdao@sim.legajo.demo.craftech.io", [OP])).toBe(true);
    expect(iamAllows(simulator, "qa-812-sc16-a-qingdao@sim.legajo.demo.craftech.io", [QA_OP])).toBe(true);
    expect(iamAllows(simulator, "supplier-qingdao@sim.legajo.demo.craftech.io", [NOTICES_ADDRESS])).toBe(false);
    expect(iamAllows(simulator, "supplier-qingdao@sim.legajo.demo.craftech.io", ["estudio-delta@sim.legajo.demo.craftech.io"])).toBe(false);
    expect(iamAllows(simulator, OP, [QA_OP])).toBe(false);
    expect(valuesOf(simulator, "ForAllValues:StringLike", "ses:Recipients")).not.toContain(DEMO[0]);
  });

  it("QA: from the injector or a QA party to QA mailboxes and operation threads only", () => {
    const qa = statement("QA");
    expect(iamAllows(qa, "qainject-812-sc15@sim.legajo.demo.craftech.io", [QA_OP])).toBe(true);
    expect(iamAllows(qa, "qa-812-sc15-b-konkan@sim.legajo.demo.craftech.io", [QA_OP])).toBe(true);
    expect(iamAllows(qa, "qainject-812-sc15@sim.legajo.demo.craftech.io", ["qa-812-sc15-a-qingdao@sim.legajo.demo.craftech.io"])).toBe(true);
    expect(iamAllows(qa, "supplier-qingdao@sim.legajo.demo.craftech.io", [QA_OP])).toBe(false);
    expect(iamAllows(qa, "qainject-812-sc15@sim.legajo.demo.craftech.io", ["supplier-qingdao@sim.legajo.demo.craftech.io"])).toBe(false);
    expect(iamAllows(qa, "qainject-812-sc15@sim.legajo.demo.craftech.io", ["estudio-delta@sim.legajo.demo.craftech.io"])).toBe(false);
  });

  it("never reach a reserved domain, from any profile", () => {
    for (const profile of SENDER_PROFILES) {
      const from = SENDERS[profile].fromAddresses[0]?.replace("*", "x") ?? "";
      for (const reserved of RESERVED) expect(iamAllows(statement(profile), from, [reserved]), `${profile} ${reserved}`).toBe(false);
    }
  });

  it("say what the fences of infra/iam-capabilities.ts say", () => {
    for (const fragment of ["op-*@", "avisos@", "*@sim.legajo.demo.craftech.io", "*@simulator.amazonses.com", "SeedOverrides.demoRecipients", "…-email-poc"]) {
      expect(CAPABILITIES.SEND_EMAIL.fence).toContain(fragment);
    }
    expect(LAMBDA_CAPABILITIES.SimMail.fence).toContain("ses:FromAddress *@sim.legajo.demo.craftech.io; ses:Recipients op-*@legajo.demo.craftech.io; configuration set …-sim-poc");
    expect(LAMBDA_CAPABILITIES.QaDriver.fence).toContain("ses:FromAddress qainject-*@sim / qa-*@sim, ses:Recipients op-*@ / qa-*@sim, configuration set …-sim-poc");
    expect(SENDERS.QA.fromAddresses).toEqual(["qainject-*@sim.legajo.demo.craftech.io", "qa-*@sim.legajo.demo.craftech.io"]);
    expect(SENDERS.QA.recipients).toEqual(["op-*@legajo.demo.craftech.io", "qa-*@sim.legajo.demo.craftech.io"]);
  });

  it("give every sender of docs/architecture.md §14 exactly one profile", () => {
    const senders = LAMBDAS.filter((fn) => expectedActions(fn).includes("ses:SendEmail"));
    expect(senders.map((fn) => [fn, senderProfileOf(fn)])).toEqual(
      senders.map((fn) => [fn, fn === "SimMail" ? "SIMULATOR" : fn === "QaDriver" ? "QA" : "SYSTEM"]),
    );
    expect(senders.filter((fn) => senderProfileOf(fn) === "SYSTEM").sort()).toEqual(["OperationWorker", "ToolHandoff", "ToolMessaging"]);
    for (const fn of LAMBDAS.filter((name) => !senders.includes(name))) expect(senderProfileOf(fn), fn).toBeUndefined();
  });
});

describe("scoped storage links", () => {
  it("let only the readers of §14 read the mail bucket, each only its route", () => {
    const readers = LAMBDAS.filter((fn) => expectedBuckets(fn).includes("InboundMail")).sort();
    expect(Object.keys(INBOUND_MAIL_READERS).sort()).toEqual(readers);
    expect(INBOUND_MAIL_READERS).toEqual({ InboundEmail: "ops", OperationWorker: "ops", QaDriver: "ops", SimMail: "sim" });
    expect(s3ObjectsArn("mail-bucket", "poc/sim/")).toBe("arn:aws:s3:::mail-bucket/poc/sim/*");
  });

  it("write quarantined attachments only under quarantine/, in live and QA worlds", () => {
    expect(quarantineObjectArns("docs")).toEqual(["arn:aws:s3:::docs/quarantine/*", "arn:aws:s3:::docs/qa/*/quarantine/*"]);
    expect(stringLike("qa/run-812/quarantine/op-7012/msg/0.pdf", "qa/*/quarantine/*")).toBe(true);
  });

  it("name the Linkables each function links", () => {
    expect(emailLinkNames("InboundEmail")).toEqual([INBOUND_MAIL_LINKS.ops, QUARANTINE_LINK]);
    expect(emailLinkNames("SimMail")).toEqual(["EmailSenderSimulator", INBOUND_MAIL_LINKS.sim]);
    expect(emailLinkNames("OperationWorker")).toEqual(["EmailSenderSystem", INBOUND_MAIL_LINKS.ops]);
    expect(emailLinkNames("QaDriver")).toEqual(["EmailSenderQa", INBOUND_MAIL_LINKS.ops]);
    expect(emailLinkNames("ToolMessaging")).toEqual(["EmailSenderSystem"]);
    expect(emailLinkNames("ChannelEvents")).toEqual([]);
    expect(emailLinkNames("Bff")).toEqual([]);
  });
});

describe("demo recipients from SeedOverrides", () => {
  it("renders exact addresses, normalized, deduplicated and sorted", () => {
    expect(demoRecipientEmails("{}")).toEqual([]);
    expect(demoRecipientEmails(JSON.stringify({ demoRecipients: { phones: [] } }))).toEqual([]);
    const emails = [" B.Team@Mail.Craftech.io ", "a+demo@mail.craftech.io", "b.team@mail.craftech.io", "success@simulator.amazonses.com"];
    expect(demoRecipientEmails(JSON.stringify({ demoRecipients: { emails } }))).toEqual(["a+demo@mail.craftech.io", "b.team@mail.craftech.io"]);
  });

  it("fails the deploy on patterns, reserved or own domains and bad shapes, without echoing the address", () => {
    const refuse = (emails: unknown, message: RegExp) => expect(() => demoRecipientEmails(JSON.stringify({ demoRecipients: { emails } }))).toThrow(message);
    refuse(["*@mail.craftech.io"], /emails\[0\] is not one exact/);
    refuse(["ok@mail.craftech.io", "who?@mail.craftech.io"], /emails\[1\] is not one exact/);
    refuse(["x@shop.example"], /reserved domain/);
    refuse([OP], /own domains/);
    refuse(["supplier@sim.legajo.demo.craftech.io"], /own domains/);
    refuse("x@mail.craftech.io", /must be an array/);
    expect(() => demoRecipientEmails("not json")).toThrow(/not valid JSON/);
    expect(() => demoRecipientEmails("[]")).toThrow(/JSON object/);
    let message = "";
    try {
      demoRecipientEmails(JSON.stringify({ demoRecipients: { emails: ["secret.person@shop.example"] } }));
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/reserved domain/);
    expect(message).not.toContain("secret.person");
  });

  it("accepts the committed overrides example that docs/architecture.md §15 step 3 loads as the secret", () => {
    expect(() => demoRecipientEmails(read("scripts/seed/overrides.example.json"))).not.toThrow();
    expect(demoRecipientEmails(read("scripts/seed/overrides.example.json"))).toEqual([]);
  });
});

describe("functions", () => {
  it("are Lambdas of docs/architecture.md §14 with the reserved concurrency of §12", () => {
    const line = /Concurrencia reservada: (.+)$/m.exec(architecture)?.[1] ?? "";
    const reserved = Object.fromEntries([...line.matchAll(/`(\w+)` (\d+)/g)].map((match) => [match[1], Number(match[2])]));
    for (const fn of EMAIL_FUNCTION_NAMES) {
      expect(LAMBDAS).toContain(fn);
      expect(EMAIL_FUNCTIONS[fn].reservedConcurrency, fn).toBe(reserved[fn]);
    }
  });

  it("point at handlers owned by WP-29 and WP-30 (docs/build-plan.md)", () => {
    const owners = Object.fromEntries(parsePlan(read("docs/build-plan.md")).flatMap((wave) => wave.packages.map((wp) => [wp.id, wp.files])));
    const fileOf = (fn: EmailFunction) => EMAIL_FUNCTIONS[fn].handler.replace(/\.handler$/, ".ts");
    expect(owners["WP-29"]).toEqual(expect.arrayContaining([fileOf("InboundEmail"), fileOf("ChannelEvents")]));
    expect(owners["WP-30"]).toContain(fileOf("SimMail"));
    for (const fn of EMAIL_FUNCTION_NAMES) expect(read(fileOf(fn)), fn).toMatch(/^export (?:async function|const) handler\b/m);
    expect(owners["WP-18"]).toEqual(["infra/messaging-email.ts", "infra/messaging-email-spec.ts", "infra/messaging-email-spec.test.ts"]);
  });

  it("end up with exactly the actions and buckets infra/iam-capabilities.ts declares", () => {
    for (const fn of EMAIL_FUNCTION_NAMES) {
      expect(actionDrift(fn, generatedActions(fn)), fn).toEqual({ extra: [], missing: [] });
      expect(generatedBuckets(fn), fn).toEqual(expectedBuckets(fn));
      for (const bucket of EMAIL_FUNCTIONS[fn].linkedBuckets) expect(["InboundMail", "Documents"], fn).not.toContain(bucket);
    }
    expect(LATE_LINKS.OperationEvents).toEqual({ owner: "operations", actions: ["sqs:SendMessage"] });
    expect(LATE_LINKS.Scheduler.actions).toEqual(CAPABILITIES.TIMERS.actions);
  });
});

describe("deploy workflow and module", () => {
  it("stops before sst deploy when another project's receipt rule set is active", () => {
    const check = deployWorkflow.indexOf("aws ses describe-active-receipt-rule-set");
    const deploy = deployWorkflow.indexOf("npx sst deploy --stage poc");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(deploy);
    const step = deployWorkflow.slice(check, deploy);
    expect(step).toContain(`""|"None"|"${inboundRuleSetName(APP)}")`);
    expect(step).toMatch(/\*\) echo "::error::[^"]*"; exit 1 ;;/);
  });

  it("creates the Ingress once, lets only its own rules invoke the Functions and exports the identity", () => {
    expect(emailModule.match(/new aws\.ses\.ActiveReceiptRuleSet\(/g)).toHaveLength(1);
    expect(emailModule).toMatch(/\{ ruleSetName: inboundRuleSet\.ruleSetName \},\s*\{ dependsOn: receiptRuleResources \}/);
    expect(emailModule).toMatch(/principal: SES_PRINCIPAL,\s*sourceAccount: place\.account,\s*sourceArn: place\.apply\(\(where\) => receiptRuleArn\(/);
    expect(emailModule).toMatch(/\{ dependsOn: \[inboundMailBucket, invoke\] \}/);
    expect(emailModule).toContain('export const emailIdentity = new aws.sesv2.EmailIdentity("EmailIdentity"');
    expect(emailModule).not.toMatch(/process\.env/);
  });
});
