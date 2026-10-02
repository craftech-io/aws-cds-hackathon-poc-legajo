// Which existing account may follow the "you already have an account" path (ADR-0015 §1.2). Pure:
// `SignupDispatch` reads the users of the email and their groups, and this table decides.
//
//   no user                                                  NEW
//   UNCONFIRMED, enabled, no group                          NEW (delete it first, then SignUp)
//   CONFIRMED, enabled, groups exactly [GUEST], no firmId   EXISTING_GUEST (a public guest)
//   anything else: staff, reserved guests, guest-test,      INELIGIBLE: no call to Cognito beyond the
//   several groups, FORCE_CHANGE_PASSWORD, RESET_REQUIRED,   reads, no email, no group, no lead
//   disabled, more than one user with the email
import type { CognitoUser } from "./cognito";
import { GUEST_GROUP } from "./cognito";

export interface FoundUser {
  readonly user: CognitoUser;
  readonly groups: readonly string[];
}

export type Classification =
  | { readonly branch: "NEW"; readonly replace?: FoundUser }
  | { readonly branch: "EXISTING_GUEST"; readonly existing: FoundUser }
  | { readonly branch: "INELIGIBLE" };

export function classifyExisting(found: readonly FoundUser[]): Classification {
  if (found.length === 0) return { branch: "NEW" };
  const [only] = found;
  if (found.length > 1 || only === undefined || !only.user.enabled) return { branch: "INELIGIBLE" };
  const { user, groups } = only;
  if (user.status === "UNCONFIRMED" && groups.length === 0) return { branch: "NEW", replace: only };
  const publicGuest = user.status === "CONFIRMED" && groups.length === 1 && groups[0] === GUEST_GROUP && user.firmId === undefined;
  return publicGuest ? { branch: "EXISTING_GUEST", existing: only } : { branch: "INELIGIBLE" };
}
