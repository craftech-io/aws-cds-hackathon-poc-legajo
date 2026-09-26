// A signed-in broker or analyst changes its own password: Cognito `ChangePassword` with the
// session's access token, after the same policy checks the sign-in forms apply. Never for a judge:
// judge accounts keep the permanent password the operator set, so the next judge of the same
// account is not locked out (docs/design-brief.md §7.1); the console hides the option and this
// refuses it as well.
import type { CognitoApi } from "./cognito";
import { hasOuterSpaces, missingPasswordRules } from "./credentials";
import { type AuthFlowErrorCode, errorCodeOf } from "./errors";
import type { TokenSet } from "./tokens";

export type PasswordChangeResult = { readonly ok: true } | { readonly ok: false; readonly error: AuthFlowErrorCode };

export interface PasswordChangeInput {
  readonly current: string;
  readonly proposed: string;
}

export async function changeOwnPassword(
  cognito: Pick<CognitoApi, "changePassword">,
  session: { readonly tokens: TokenSet; readonly isJudge: boolean },
  { current, proposed }: PasswordChangeInput,
): Promise<PasswordChangeResult> {
  if (session.isJudge) return { ok: false, error: "UNSUPPORTED" };
  if (!current) return { ok: false, error: "INVALID_CREDENTIALS" };
  if (missingPasswordRules(proposed).length > 0 || hasOuterSpaces(proposed) || proposed === current) return { ok: false, error: "WEAK_PASSWORD" };
  try {
    await cognito.changePassword(session.tokens.accessToken, current, proposed);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorCodeOf(error, "change") };
  }
}
