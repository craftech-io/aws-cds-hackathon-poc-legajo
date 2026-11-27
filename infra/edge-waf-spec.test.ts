// The edge's web ACL since the 2026-11-27 amendment of ADR-0015 §3.3: the shared `demos-borde`, looked
// up by name and put on the Router's distribution; the app creates no edge web ACL of its own.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_HEADER } from "../packages/bff/src/routers/trpc";
import { CONSOLE_CSP } from "./ci-spec";
import { EDGE_WAF_MONTHLY_COST_USD, ID_TOKEN_HEADER, SHARED_EDGE_WEB_ACL, SHARED_SMS_RULE_TEXTS, SMS_CODE_PATHS, WEB_ACL_SCOPE, formerWebAclName } from "./edge-waf-spec";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const adr = read("docs/adr/0015-alta-publica-de-invitados-y-leads.md");
const infraSources = readdirSync(resolve(process.cwd(), "infra"))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => `infra/${file}`);

describe("[FL-112] the shared web ACL at the edge", () => {
  it("[FL-112] is demos-borde, scope CLOUDFRONT, looked up by name on every deploy", () => {
    expect(SHARED_EDGE_WEB_ACL).toBe("demos-borde");
    expect(WEB_ACL_SCOPE).toBe("CLOUDFRONT");
    expect(stripComments(read("infra/edge-waf.ts"))).toContain("aws.wafv2.getWebAclOutput({ name: SHARED_EDGE_WEB_ACL, scope: WEB_ACL_SCOPE })");
  });

  it("[FL-112] goes on the Router's distribution, and the Router creates none", () => {
    const web = stripComments(read("infra/web.ts"));
    expect(web).toContain("args.webAclArn = sharedEdgeWebAcl.arn;");
    expect(web).not.toMatch(/\bwaf:/);
    for (const file of infraSources.filter((path) => path !== "infra/auth-waf.ts")) expect(stripComments(read(file)), file).not.toMatch(/new aws\.wafv2\.WebAcl\(/);
    expect(formerWebAclName("aws-cds-hackathon-poc-legajo", "poc")).toBe("aws-cds-hackathon-poc-legajo-poc-edge");
  });

  it("[FL-112] names what the operator needs for the shared rules: the SMS-code paths and the id token's header", () => {
    for (const path of SMS_CODE_PATHS) for (const text of SHARED_SMS_RULE_TEXTS) expect(path.toLowerCase(), path).not.toContain(text.toLowerCase());
    expect(ID_TOKEN_HEADER).toBe(AUTH_HEADER);
  });
});

describe("[FL-113] bots at the edge", () => {
  it("[FL-113] the deploy role reads the shared web ACL, and only that one", () => {
    const role = read("infra/bootstrap/ci-role.yaml");
    expect(role).toContain('Resource: !Sub "arn:${AWS::Partition}:wafv2:us-east-1:${AWS::AccountId}:global/webacl/demos-borde/*"');
    expect(role).toMatch(/Sid: EdgeWebAclLookup\s+Effect: Allow\s+Action: wafv2:ListWebACLs/);
  });

  it("[FL-113] uses no SDK nor CAPTCHA, so the CSP adds no WAF domain", () => {
    expect(CONSOLE_CSP).not.toMatch(/awswaf|captcha|waf/i);
    const sources = ["infra", "packages/web/src"].flatMap((dir) =>
      readdirSync(resolve(process.cwd(), dir), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.tsx?$/.test(file))
        .map((file) => `${dir}/${file}`),
    );
    for (const file of sources.filter((path) => !path.endsWith("edge-waf-spec.test.ts"))) expect(stripComments(read(file)), file).not.toContain("VITE_WAF_INTEGRATION_URL");
  });

  it("records the edge's cost for the rate card (ADR-0015 §3.3)", () => {
    expect(EDGE_WAF_MONTHLY_COST_USD).toEqual({ min: 9.4, max: 11 });
    expect(adr).toContain("**US$ 9,4 a 11/mes**");
  });
});
