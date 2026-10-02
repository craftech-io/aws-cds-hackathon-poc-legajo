// The real side of `console:invite` (invite.ts): Cognito's admin API on the pool of the `Auth` link and
// the broker rows of `Firms` through the connector, both read from the resources `sst shell` links
// (`Resource`, never a hard-coded id). Every call has a deadline and the SDK's retry budget.
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { authConfig } from "@legajo/bff/auth/config";
import { connector } from "@legajo/bff/connector/index";
import { awsClientConfig } from "@legajo/bff/lib/clients";
import { GUEST_TEST_PASSWORD_ENV, type InviteDeps } from "./invite";

const COGNITO_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 2_000, maxAttempts: 4 };

function subOf(attributes: ReadonlyArray<{ readonly Name?: string; readonly Value?: string }> | undefined): string {
  const sub = attributes?.find((attribute) => attribute.Name === "sub")?.Value;
  if (!sub) throw new Error("Cognito answered a user without sub");
  return sub;
}

export function cognitoInviteDeps(options: Pick<InviteDeps, "saveCredential">): InviteDeps {
  const pool = authConfig();
  const client = new CognitoIdentityProviderClient({ region: pool.region, ...awsClientConfig(COGNITO_TIMEOUTS) });
  const firms = connector().firms;
  const UserPoolId = pool.userPoolId;

  return {
    async findUser(username) {
      try {
        const user = await client.send(new AdminGetUserCommand({ UserPoolId, Username: username }));
        return { sub: subOf(user.UserAttributes) };
      } catch (error) {
        if (error instanceof UserNotFoundException) return undefined;
        throw error;
      }
    },

    async createUser({ username, firmId, email }) {
      const attributes = [{ Name: "custom:firmId", Value: firmId }, ...(email === undefined ? [] : [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }])];
      const created = await client.send(
        new AdminCreateUserCommand({
          UserPoolId,
          Username: username,
          UserAttributes: attributes,
          // Guests get no message at all; brokers get the branded invitation with a temporary password.
          ...(email === undefined ? { MessageAction: "SUPPRESS" as const } : { DesiredDeliveryMediums: ["EMAIL" as const] }),
        }),
      );
      return { sub: subOf(created.User?.Attributes) };
    },

    async setPermanentPassword(username, password) {
      await client.send(new AdminSetUserPasswordCommand({ UserPoolId, Username: username, Password: password, Permanent: true }));
    },

    async disableMfa(username) {
      await client.send(new AdminSetUserMFAPreferenceCommand({ UserPoolId, Username: username, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }));
    },

    async addToGroup(username, group) {
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId, Username: username, GroupName: group }));
    },

    async brokerRole(firmId, brokerId) {
      return (await firms.getBroker(firmId, brokerId)).role;
    },

    async bindBroker(firmId, brokerId, sub) {
      await firms.setBrokerCognitoSub(firmId, brokerId, sub);
    },

    guestTestPassword: () => process.env[GUEST_TEST_PASSWORD_ENV],
    saveCredential: options.saveCredential,
    report: (line) => process.stdout.write(`console:invite: ${line}\n`),
  };
}
