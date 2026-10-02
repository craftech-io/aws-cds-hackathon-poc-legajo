// Visible texts and the email sender of the console's Cognito user pool (infra/auth.ts), as plain
// data and pure functions. No SST or Pulumi dependency, so infra/auth-email.test.ts checks every value
// without an AWS account, and `npm run lint:neutral-surfaces` scans this file (ADR-0014 §4): the group
// descriptions show in the Cognito console and the sender's display name in every account email.
//
// The account emails themselves (signup code, resend, password recovery, "you already have an
// account" and the invitation of internal staff) are no longer templates of the pool: the trigger
// `AuthCustomMessage` builds them, es/en, with the quotas of ADR-0015 §3.2, from
// packages/bff/src/auth-triggers/messages/ (ADR-0015 §7). Cognito only sends what the trigger returns,
// from `Legajo listo <no-reply@legajo.demo.craftech.io>` through the app's SES identity and the email
// configuration set, so a bounce or a complaint reaches ChannelEvents (Runtime/MAILSTATUS#).

/** The public brand is "Legajo listo · Powered by Craftech" (ADR-0006); no other name appears. */
export const PRODUCT_NAME = "Legajo listo";

// ---- Groups --------------------------------------------------------------------------------------

/**
 * Console roles, one Cognito group each; the lowest precedence wins in `cognito:preferred_role`.
 * `totp`: whether the person may turn TOTP on. Cognito has no per-group MFA setting: a GUEST cannot
 * because `AuthPreToken` takes the `aws.cognito.signin.user.admin` scope out of every GUEST access
 * token (ADR-0014 §7, ADR-0015 §1), so AssociateSoftwareToken and SetUserMFAPreference fail for it.
 */
export const CONSOLE_GROUPS = {
  BROKER: { precedence: 10, totp: "optional", description: "Customs broker: works, approves and reopens the dossiers of the firm" },
  GUEST: { precedence: 20, totp: "off", description: "Guest: broker permissions inside its own demo firm, no TOTP" },
  ANALYST: { precedence: 30, totp: "optional", description: "Firm analyst: works the dossiers, never approves or reopens them" },
} as const;

export type ConsoleGroup = keyof typeof CONSOLE_GROUPS;

export const CONSOLE_GROUP_NAMES = Object.keys(CONSOLE_GROUPS) as ConsoleGroup[];

// ---- Sender -------------------------------------------------------------------------------------

export const NO_REPLY_LOCAL_PART = "no-reply";

export interface EmailConfiguration {
  readonly emailSendingAccount: "DEVELOPER" | "COGNITO_DEFAULT";
  readonly sourceArn?: string;
  readonly fromEmailAddress?: string;
  /** Only with DEVELOPER: the set whose events reach ChannelEvents. */
  readonly configurationSet?: string;
}

/** The SES identity as read on this deploy (infra/messaging-email.ts creates it). */
export interface SesIdentityState {
  readonly domain: string;
  readonly arn: string;
  readonly verified: boolean;
}

export interface EmailSenderChoice {
  readonly configuration: EmailConfiguration;
  /** Why Cognito keeps its own sender on this deploy; printed as a deploy warning. */
  readonly warning?: string;
}

/**
 * `Name <address>` for a From header. SES takes only printable ASCII there, and an RFC 5322 phrase
 * without specials needs no quoting, so anything else is refused instead of encoded.
 */
export function fromAddress(displayName: string, address: string): string {
  if (!/^[A-Za-z0-9 ]+$/.test(displayName) || displayName.trim() !== displayName) {
    throw new Error("the display name of a From header must be plain ASCII letters, digits and inner spaces");
  }
  if (!/^[a-z0-9-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address)) throw new Error("the From address must be a lowercase ASCII mailbox");
  return `${displayName} <${address}>`;
}

/**
 * The sender of the account emails. SES (DEVELOPER) from `no-reply@<app domain>`, DKIM-aligned under
 * the domain's `p=reject` DMARC record and through the email configuration set, as soon as the
 * identity exists and is verified; Cognito's own sender, with the same trigger, until then (DKIM can
 * take a while after the identity is created). An identity of another domain, or a configuration set
 * that is not the app's email set, is a wiring error and fails the deploy.
 */
export function emailSenderFor(identity: SesIdentityState | undefined, appDomain: string, configurationSet: string): EmailSenderChoice {
  if (!/^[A-Za-z0-9_-]+-email-[A-Za-z0-9_-]+$/.test(configurationSet)) throw new Error(`the account emails go through the app's email configuration set, not "${configurationSet}"`);
  if (identity === undefined) {
    return {
      configuration: { emailSendingAccount: "COGNITO_DEFAULT" },
      warning: `infra/messaging-email.ts exports no emailIdentity yet: Cognito sends the account emails from its default sender until the SES identity ${appDomain} exists and is verified.`,
    };
  }
  if (identity.domain !== appDomain) throw new Error(`the SES identity is ${identity.domain}, but the account emails are sent from ${appDomain}`);
  if (!identity.verified) {
    return {
      configuration: { emailSendingAccount: "COGNITO_DEFAULT" },
      warning: `The SES identity ${appDomain} is not verified for sending yet: Cognito keeps its default sender until a deploy finds it verified.`,
    };
  }
  return {
    configuration: {
      emailSendingAccount: "DEVELOPER",
      sourceArn: identity.arn,
      fromEmailAddress: fromAddress(PRODUCT_NAME, `${NO_REPLY_LOCAL_PART}@${appDomain}`),
      configurationSet,
    },
  };
}
