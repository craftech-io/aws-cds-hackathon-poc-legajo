// The edge's web ACL as plain data (ADR-0015 §3.3 amendment of 2026-11-27, docs/architecture.md §10
// and §13). Since that date the Router no longer creates a web ACL of its own: it takes the one every
// demo of the account shares, `demos-borde`, created and kept by the `craftech/demos` project of the
// `labs` repository (its `infra/borde.ts`). infra/edge-waf.ts looks it up by name on every deploy and
// infra/web.ts puts its ARN on the distribution (`transform.cdn`, `webAclArn`). It must exist before
// the deploy; this app never changes it.
//
// What `demos-borde` does today (owned by craftech/demos, listed here for the operator and the tests):
//   - an IP block list and AWS's IP reputation list
//   - sign-ups from hosting providers blocked
//   - 20 requests per IP every 5 min to paths with `signup.` or `password.`
//   - 30 per IP every 5 min to the SMS-code paths `telefono.`, `phone.`, `cuenta.enviarCodigo` and
//     `cuenta.verificarCodigo` (this app's are named otherwise: SMS_CODE_PATHS)
//   - 5,000 per IP every 5 min to `/api/`
//
// What the app's own web ACL had and the shared one does not: `/api/` at 1,500 (now 5,000), and the
// counted `signup` rule with its `LegajoEdge*` metrics (it never challenged: the CSP refuses the
// interstitial). The app keeps its own limits in the BFF (ADR-0015 §3.2, ADR-0021 §8) and the user
// pool keeps its own regional web ACL (infra/auth-waf.ts), which this change does not touch.
//
// No SDK of WAF, no CAPTCHA, no Bot Control: the CSP adds no WAF domain and there is no
// `VITE_WAF_INTEGRATION_URL`.

/** The web ACL every demo of the account shares (scope CLOUDFRONT, us-east-1). */
export const SHARED_EDGE_WEB_ACL = "demos-borde";
export const WEB_ACL_SCOPE = "CLOUDFRONT";

/** Name of the app's own web ACL before the shared one: the first deploy with this change deletes it. */
export function formerWebAclName(app: string, stage: string): string {
  return `${app}-${stage}-edge`;
}

/** The paths of this app's SMS code (ADR-0021), as they reach the edge: none matches the shared rule's texts. */
export const SMS_CODE_PATHS = ["/api/account.phoneStatus", "/api/account.sendPhoneCode", "/api/account.verifyPhoneCode", "/api/account.endPhoneSession"] as const;

/** The texts of the shared rule on the SMS-code paths (`demos-borde`, craftech/demos). */
export const SHARED_SMS_RULE_TEXTS = ["telefono.", "phone.", "cuenta.enviarCodigo", "cuenta.verificarCodigo"] as const;

/** The header the console sends its id token in: the shared ACL's logs redact it (craftech/demos). */
export const ID_TOKEN_HEADER = "x-legajo-auth";

/**
 * Monthly cost the rate card of WP-41 records for the edge (us-east-1, 2026-09-26, ADR-0015 §3.3): the
 * figure of the app's own web ACL. The shared one is paid once for every demo of the account.
 */
export const EDGE_WAF_MONTHLY_COST_USD = { min: 9.4, max: 11 } as const;
