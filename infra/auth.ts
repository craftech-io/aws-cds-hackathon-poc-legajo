// Cognito user pool of the console (docs/architecture.md §10, docs/build-plan.md WP-11). Every value
// the pool and its web client take lives in infra/auth-email.ts as plain data, checked by
// infra/auth-email.test.ts; this module only turns it into resources.
//
// Who gets in. Nobody signs up: `allowAdminCreateUserOnly`, and the operator creates every user with
// AdminCreateUser through `npm run console:invite` (scripts/console/invite.ts), which sets the group
// and `custom:firmId`. Sign-in names: email is an alias, so brokers and analysts sign in with the
// email the invitation verified, and guests (`guest-01..NN`, `guest-test`) with a plain username and
// no email at all. Cognito refuses an email-shaped username while email is an alias, so the invite
// script generates the username of an invited broker.
//
// Tenancy. Groups BROKER, GUEST and ANALYST; `custom:firmId` is readable by the web client and never
// writable by it (WEB_CLIENT_SETTINGS.writeAttributes). The pre token generation trigger (event
// V2_0, packages/bff/src/auth-triggers/pre-token.ts) adds `firmId`, the role and `isGuest` from
// `Firms/BROKER#`; Cognito waits at most 5 s for it, hence the explicit timeout.
//
// Sign-in surface. The console's own screen (packages/web/src/views/login) speaks USER_SRP_AUTH,
// REFRESH_TOKEN_AUTH, the challenges, ForgotPassword and RevokeToken to the Cognito API. The pool has
// no domain and the client no OAuth flow, so there is no hosted UI. MFA is optional TOTP (no SMS):
// brokers and analysts may turn it on; guest accounts are created with it off and the console hides it.
//
// Email. Cognito sends the invitation and the code message with its service-linked role
// (AWSServiceRoleForAmazonCognitoIdpEmailService, created by the first deploy that sets DEVELOPER),
// from `Legajo listo <no-reply@legajo.demo.craftech.io>` through the SES identity of
// infra/messaging-email.ts, once that identity exists and is verified; until then from Cognito's
// default sender with the same templates, and the deploy log says so (auth-email.ts `emailSenderFor`).
// These emails bypass the app's SES client and its recipient fence: the only recipients are the
// addresses the operator passes to console:invite (guests get no email).
//
// Verify:
//   aws --profile craftech-demos cognito-idp describe-user-pool --user-pool-id <id>
//     AdminCreateUserConfig.AllowAdminCreateUserOnly = true · AliasAttributes = [email] ·
//     MfaConfiguration = OPTIONAL · UserPoolTier = ESSENTIALS · SchemaAttributes has custom:firmId ·
//     LambdaConfig.PreTokenGenerationConfig.LambdaVersion = V2_0 · no Domain ·
//     EmailConfiguration.EmailSendingAccount = DEVELOPER (once the SES identity is verified)
//   aws --profile craftech-demos cognito-idp list-groups --user-pool-id <id>        BROKER, GUEST, ANALYST
//   aws --profile craftech-demos cognito-idp describe-user-pool-client --user-pool-id <id> --client-id <clientId>
//     ExplicitAuthFlows = [ALLOW_USER_SRP_AUTH, ALLOW_REFRESH_TOKEN_AUTH] · AllowedOAuthFlowsUserPoolClient = false ·
//     AccessTokenValidity = IdTokenValidity = 15 (minutes) · RefreshTokenValidity = 12 (hours)

import {
  AUTH_LINK_ACTIONS,
  CONSOLE_GROUPS,
  CONSOLE_GROUP_NAMES,
  LOGIN_PATH,
  WEB_CLIENT_SETTINGS,
  WEB_ENV_NAMES,
  emailSenderFor,
  userPoolSettings,
  type ConsoleGroup,
  type EmailConfiguration,
  type EmailSenderChoice,
} from "./auth-email";
import { appDomain, appUrl } from "./dns";
import { lateLinks } from "./late-links";

/** Handler of the trigger (WP-14); the path is the contract with packages/bff. */
const PRE_TOKEN_HANDLER = "packages/bff/src/auth-triggers/pre-token.handler";

function applySender(choice: EmailSenderChoice): EmailConfiguration {
  if (choice.warning) $util.log.warn(choice.warning);
  return choice.configuration;
}

// The identity is read live on every deploy: the resource's own state would keep the "not verified
// yet" of its creation. `dependsOn` skips the read while the identity is still being created.
function senderConfiguration(identity: unknown): $util.Output<EmailConfiguration> {
  if (identity === undefined) return $util.output(applySender(emailSenderFor(undefined, appDomain)));
  if (!aws.sesv2.EmailIdentity.isInstance(identity)) {
    throw new Error("infra/messaging-email.ts exports emailIdentity, but it is not an aws.sesv2.EmailIdentity.");
  }
  return aws.sesv2
    .getEmailIdentityOutput({ emailIdentity: identity.emailIdentity }, { dependsOn: [identity] })
    .apply((live) => applySender(emailSenderFor({ domain: live.emailIdentity, arn: live.arn, verified: live.verifiedForSendingStatus }, appDomain)));
}

// The SES identity belongs to infra/messaging-email.ts (`emailIdentity`), which sst.config.ts
// evaluates after this module. A dynamic import inside an Output settles once that module has run,
// whatever the order.
const emailConfiguration = $util.output(import("./messaging-email").then((module) => senderConfiguration(Reflect.get(module, "emailIdentity"))));

/** Adds `firmId`, the role and `isGuest` to the tokens; reads only `Firms` (its broker rows and GSI1). */
export const preTokenTrigger = new sst.aws.Function("AuthPreToken", {
  description: "Cognito pre token generation (V2_0): firmId, role and isGuest from Firms/BROKER#.",
  handler: PRE_TOKEN_HANDLER,
  link: lateLinks("auth", "storage-tables", () => import("./storage-tables"), ["Firms"]),
  timeout: "5 seconds",
  memory: "256 MB",
});

export const userPool = new sst.aws.CognitoUserPool("UserPool", {
  aliases: ["email"],
  mfa: "optional",
  softwareToken: true,
  triggers: {
    preTokenGeneration: preTokenTrigger.arn,
    // V2_0 also shapes the access token; it needs the ESSENTIALS feature plan (userPoolSettings).
    preTokenGenerationVersion: "v2",
  },
  transform: {
    userPool: {
      ...userPoolSettings({ loginUrl: `${appUrl}${LOGIN_PATH}`, brandUrl: `${appUrl}/brand` }),
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
 * only AUTH_LINK_ACTIONS on this pool. Users are created by the operator's script, never by a Lambda.
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
