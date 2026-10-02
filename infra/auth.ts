// Cognito user pool of the console and the public signup (docs/architecture.md §10, ADR-0015 §1 and
// §3, docs/build-plan.md WP-11 and WP-51). Every value the pool, its web client and its triggers take
// lives in infra/auth-spec.ts (checked by auth-spec.test.ts) and the visible texts and the sender in
// infra/auth-email.ts (auth-email.test.ts); this module only turns them into resources.
//
// Who gets in. Internal staff and reserved guests only by AdminCreateUser (`npm run console:invite`).
// Anyone through `/signup`, but never by calling SignUp from the browser: `SignupDispatch`
// (infra/leads.ts) signs up with a ticket `AuthPreSignUp` checks, so `AllowAdminCreateUserOnly` is
// `false` only because that trigger is wired here (auth-spec.ts `userPoolSettings`).
//
// Triggers (handlers of WP-50, packages/bff/src/auth-triggers/), each invocable only by
// cognito-idp.amazonaws.com with this pool as SourceArn (SST's permission), 5 s, no reserved
// concurrency:
//   AuthPreSignUp      HMAC of the signup ticket (subkey `signup-ticket`), no table
//   AuthCustomMessage  the account emails es/en with the quotas, bounce state and breaker of ADR-0015
//                      §3.2 (Runtime `RL#MAIL…`, `MAILSTATUS#`, `MAILBREAKER`, only by key through
//                      `RuntimeKeys`: never the whole table), never Leads
//   AuthPreToken       V2_0: firmId, role, isGuest and worldLease from Firms/BROKER#; no admin scope
//                      for a GUEST (no password change, no TOTP, no attribute change)
//
// Email. Cognito sends what AuthCustomMessage returns, with its service-linked role, from
// `Legajo listo <no-reply@legajo.demo.craftech.io>` through the SES identity of
// infra/messaging-email.ts and the email configuration set (bounces reach ChannelEvents), once the
// identity exists and is verified; until then from Cognito's default sender (auth-email.ts
// `emailSenderFor`). First deploy check (ADR-0015 §3.2): an error of AuthCustomMessage must fail the
// call with UserLambdaValidationException and Cognito must NOT send the email; otherwise stop and
// escalate to `architect` (plan B: CustomEmailSender with KMS, never without an ADR).
//
// Verify:
//   aws --profile craftech-demos cognito-idp describe-user-pool --user-pool-id <id>
//     AdminCreateUserConfig.AllowAdminCreateUserOnly = false · LambdaConfig.PreSignUp, CustomMessage ·
//     PreTokenGenerationConfig.LambdaVersion = V2_0 · AliasAttributes = [email] · MfaConfiguration = OPTIONAL ·
//     UserPoolTier = ESSENTIALS · EmailConfiguration.EmailSendingAccount = DEVELOPER and ConfigurationSet
//     aws-cds-hackathon-poc-legajo-email-poc (once the SES identity is verified) · no Domain
//   aws --profile craftech-demos cognito-idp list-groups --user-pool-id <id>        BROKER, GUEST, ANALYST
//   aws --profile craftech-demos cognito-idp describe-user-pool-client --user-pool-id <id> --client-id <clientId>
//     ExplicitAuthFlows = [ALLOW_USER_SRP_AUTH, ALLOW_REFRESH_TOKEN_AUTH] · PreventUserExistenceErrors = ENABLED ·
//     AccessTokenValidity = IdTokenValidity = 15 (minutes) · RefreshTokenValidity = 12 (hours)

import { CONSOLE_GROUPS, CONSOLE_GROUP_NAMES, emailSenderFor, type ConsoleGroup, type EmailConfiguration, type EmailSenderChoice } from "./auth-email";
import {
  AUTH_LINK_ACTIONS,
  COGNITO_TRIGGERS,
  PRE_TOKEN_GENERATION_VERSION,
  TRIGGER_KEYS,
  WEB_CLIENT_SETTINGS,
  WEB_ENV_NAMES,
  userPoolSettings,
  type TriggerKey,
} from "./auth-spec";
import { appDomain } from "./dns";
import { lateLinks, links, type LinkList } from "./late-links";
import { RUNTIME_KEYS_LINK, runtimeKeysStatement } from "./leads-spec";
import { configurationSetName } from "./messaging-email-spec";
import { SessionTokenKey } from "./secrets";

function applySender(choice: EmailSenderChoice): EmailConfiguration {
  if (choice.warning) $util.log.warn(choice.warning);
  return choice.configuration;
}

const emailSet = configurationSetName($app.name, $app.stage, "email");

// The identity is read live on every deploy: the resource's own state would keep the "not verified
// yet" of its creation. `dependsOn` skips the read while the identity is still being created.
function senderConfiguration(identity: unknown): $util.Output<EmailConfiguration> {
  if (identity === undefined) return $util.output(applySender(emailSenderFor(undefined, appDomain, emailSet)));
  if (!aws.sesv2.EmailIdentity.isInstance(identity)) {
    throw new Error("infra/messaging-email.ts exports emailIdentity, but it is not an aws.sesv2.EmailIdentity.");
  }
  return aws.sesv2
    .getEmailIdentityOutput({ emailIdentity: identity.emailIdentity }, { dependsOn: [identity] })
    .apply((live) => applySender(emailSenderFor({ domain: live.emailIdentity, arn: live.arn, verified: live.verifiedForSendingStatus }, appDomain, emailSet)));
}

// The SES identity belongs to infra/messaging-email.ts (`emailIdentity`), which sst.config.ts
// evaluates after this module. A dynamic import inside an Output settles once that module has run,
// whatever the order.
const emailConfiguration = $util.output(import("./messaging-email").then((module) => senderConfiguration(Reflect.get(module, "emailIdentity"))));

/** Tables through their SST link, taken late from storage-tables.ts (a trigger never links Leads). */
const tableLinks = (tables: readonly string[]): LinkList => lateLinks("auth", "storage-tables", () => import("./storage-tables"), tables);

/** What each trigger links (docs/architecture.md §14): exactly its row, no more. */
const TRIGGER_LINKS: Readonly<Record<TriggerKey, () => LinkList>> = {
  preSignUp: () => links([SessionTokenKey]),
  customMessage: () => links([SessionTokenKey], tableLinks([RUNTIME_KEYS_LINK])),
  preTokenGeneration: () => tableLinks(["Firms"]),
};

type TriggerPermission = Parameters<typeof sst.aws.permission>[0];

/** AuthCustomMessage reaches `Runtime` only by key (leads-spec.ts `RUNTIME_KEY_FENCES`), never linked whole. */
const TRIGGER_PERMISSIONS: Readonly<Partial<Record<TriggerKey, () => $util.Output<TriggerPermission[]>>>> = {
  customMessage: () =>
    $util.output(import("./storage-tables")).apply((module) => {
      const statement = runtimeKeysStatement("AuthCustomMessage", module.Runtime.arn);
      // `output` unwraps the table ARN inside the statement, so the permission carries plain strings.
      return $util.output([{ actions: statement.actions, resources: statement.resources, conditions: statement.conditions ?? [] }]);
    }),
};

function trigger(key: TriggerKey): sst.aws.Function {
  const spec = COGNITO_TRIGGERS[key];
  return new sst.aws.Function(spec.fn, {
    description: spec.description,
    handler: spec.handler,
    link: TRIGGER_LINKS[key](),
    permissions: TRIGGER_PERMISSIONS[key]?.() ?? [],
    timeout: `${spec.timeoutSeconds} seconds` as const,
    memory: `${spec.memoryMb} MB` as const,
  });
}

export const triggerFunctions = Object.fromEntries(TRIGGER_KEYS.map((key) => [key, trigger(key)])) as Record<TriggerKey, sst.aws.Function>;
/** Kept by name for the modules and tests that read it. */
export const preTokenTrigger = triggerFunctions.preTokenGeneration;

export const userPool = new sst.aws.CognitoUserPool("UserPool", {
  aliases: ["email"],
  mfa: "optional",
  softwareToken: true,
  triggers: {
    preSignUp: triggerFunctions.preSignUp.arn,
    customMessage: triggerFunctions.customMessage.arn,
    preTokenGeneration: triggerFunctions.preTokenGeneration.arn,
    preTokenGenerationVersion: PRE_TOKEN_GENERATION_VERSION,
  },
  transform: {
    userPool: {
      ...userPoolSettings(TRIGGER_KEYS),
      emailConfiguration,
    },
  },
});

export const userGroups = Object.fromEntries(
  CONSOLE_GROUP_NAMES.map((group) => [
    group,
    new aws.cognito.UserGroup(`UserPoolGroup${group.charAt(0)}${group.slice(1).toLowerCase()}`, {
      userPoolId: userPool.id,
      name: group,
      precedence: CONSOLE_GROUPS[group].precedence,
      description: CONSOLE_GROUPS[group].description,
    }),
  ]),
) as Record<ConsoleGroup, aws.cognito.UserGroup>;

export const webClient = userPool.addClient("ConsoleWeb", {
  transform: { client: WEB_CLIENT_SETTINGS },
});

const region = aws.getRegionOutput({}).region;

/** OIDC issuer of the pool; the BFF verifies id tokens offline against `<issuer>/.well-known/jwks.json`. */
export const issuerUrl = $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`;

/**
 * What a Lambda needs to know about the pool (packages/bff/src/auth/config.ts reads it with
 * `readLinked("Auth", …)`). Linking the pool itself would grant `cognito-idp:*`; this link grants
 * only AUTH_LINK_ACTIONS on this pool. The signup's admin actions are fenced statements of
 * infra/leads.ts (`signupGrants`), never a link.
 */
export const Auth = new sst.Linkable("Auth", {
  properties: {
    userPoolId: userPool.id,
    clientId: webClient.id,
    issuerUrl,
    region,
  },
  include: [sst.aws.permission({ actions: [...AUTH_LINK_ACTIONS], resources: [userPool.arn] })],
});

/**
 * Build-time variables of the console (infra/web.ts passes them to the StaticSite; Vite exposes the
 * `VITE_` prefix to the browser). Neither is a secret: the client is public and the pool id is part
 * of every token; the region of the Cognito API is the prefix of the pool id.
 */
export const authWebEnvironment: Record<string, $util.Input<string>> = {
  [WEB_ENV_NAMES.userPoolId]: userPool.id,
  [WEB_ENV_NAMES.clientId]: webClient.id,
};
