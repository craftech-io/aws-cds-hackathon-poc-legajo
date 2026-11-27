// Where a session goes when it starts and when it ends (docs/landing-spec.md §8.1, §8.7; FL-105,
// FL-108). A guest whose token carries no firm yet has no live world: it waits on `/welcome` until
// `account.ensureWorld` made one. Anybody else lands where it was going, or on the operations; every
// sign-in passes the SMS code of `/verify-phone` first (ADR-0021). Signing
// out drops the refreshes in flight, clears the tokens, revokes the refresh token at Cognito and lands
// on the landing with its "Cerraste sesión" notice; the world and the lead stay as they were.
import type { Language } from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import type { CognitoApi } from "../../lib/auth/cognito";
import { type TokenSet, revokeSession } from "../../lib/auth/tokens";
import type { Principal } from "../../lib/auth-claims";
import type { ConsoleClient } from "../../lib/trpc";
import { PHONE_PATH, SIGNED_OUT_PARAM, WELCOME_PATH } from "../../routes";
import { hrefWithLang } from "./lang";

export function needsWorld(principal: Pick<Principal, "isGuest" | "firmId">): boolean {
  return principal.isGuest && principal.firmId === undefined;
}

/** `/verify-phone?returnTo=…`: the SMS code of the session first (ADR-0021), then where the session was going. */
export function phoneStepHref(returnTo: string): string {
  return `${PHONE_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** After a sign-in: the SMS code of the session, then `/welcome` for a guest without a world, else the page it asked for. */
export function destinationAfterSignIn(principal: Pick<Principal, "isGuest" | "firmId">, returnTo: string): string {
  return phoneStepHref(needsWorld(principal) ? WELCOME_PATH : returnTo);
}

/** The landing with the sign-out notice, in the person's language. */
export function signedOutHref(lang: Language): string {
  return hrefWithLang("/", lang, new URLSearchParams(`${SIGNED_OUT_PARAM}=1`));
}

/** `?notice=unconfirmed`: `/signup` or `/signup/verify` reached from a sign-in whose email is not verified (§8.4). */
export const NOTICE_PARAM = "notice";
export const UNCONFIRMED_NOTICE = "unconfirmed";

export function cameUnconfirmed(search: URLSearchParams): boolean {
  return search.get(NOTICE_PARAM) === UNCONFIRMED_NOTICE;
}

export function isSignedOutLanding(search: URLSearchParams): boolean {
  return search.get(SIGNED_OUT_PARAM) === "1";
}

/** Ends the session: no refresh in flight survives it, the tokens go, the refresh token is revoked. */
export async function endSession(cognito: Pick<CognitoApi, "revoke"> | undefined, tokens: TokenSet | undefined): Promise<void> {
  await revokeSession(cognito ?? { revoke: () => Promise.resolve() }, tokens);
}

/** Sign-out also removes the mark of this session's SMS code (ADR-0021); best effort, the token is going anyway. */
export async function endPhoneSession(trpc: ConsoleClient): Promise<void> {
  try {
    await getUntypedClient(trpc).mutation("account.endPhoneSession", {});
  } catch {
    // An expired or refused token has nothing to end.
  }
}
