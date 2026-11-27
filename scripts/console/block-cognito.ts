// The real side of `console:block` (block.ts): Cognito's admin API on the pool of the `Auth` link and
// the phone items of `Leads` through the connector, both read from the resources `sst shell` links
// (`Resource`, never a hard-coded id). Every call has a deadline and the SDK's retry budget.
import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { authConfig } from "@legajo/bff/auth/config";
import { tableClient } from "@legajo/bff/connector/index";
import { awsClientConfig } from "@legajo/bff/lib/clients";
import { createPhoneStore } from "@legajo/bff/phone-verification/store";
import type { BlockAccount, BlockDeps } from "./block";

const COGNITO_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 2_000, maxAttempts: 4 };

type Attributes = ReadonlyArray<{ readonly Name?: string; readonly Value?: string }> | undefined;

function subOf(attributes: Attributes): string {
  const sub = attributes?.find((attribute) => attribute.Name === "sub")?.Value;
  if (!sub) throw new Error("Cognito answered a user without sub");
  return sub;
}

export function cognitoBlockDeps(): BlockDeps {
  const pool = authConfig();
  const client = new CognitoIdentityProviderClient({ region: pool.region, ...awsClientConfig(COGNITO_TIMEOUTS) });
  const UserPoolId = pool.userPoolId;

  async function byUsername(username: string): Promise<BlockAccount[]> {
    try {
      const user = await client.send(new AdminGetUserCommand({ UserPoolId, Username: username }));
      return [{ username: user.Username ?? username, sub: subOf(user.UserAttributes) }];
    } catch (error) {
      if (error instanceof UserNotFoundException) return [];
      throw error;
    }
  }

  async function byEmail(email: string): Promise<BlockAccount[]> {
    // planBlock refuses whitespace; a quote would end the filter's string, so it is refused here too.
    if (email.includes('"') || email.includes("\\")) throw new RangeError("--account has characters an address does not");
    const found = await client.send(new ListUsersCommand({ UserPoolId, Filter: `email = "${email}"` }));
    return (found.Users ?? []).flatMap((user) => (user.Username === undefined ? [] : [{ username: user.Username, sub: subOf(user.Attributes) }]));
  }

  return {
    findAccounts: (account) => (account.includes("@") ? byEmail(account) : byUsername(account)),
    async disableUser(username) {
      await client.send(new AdminDisableUserCommand({ UserPoolId, Username: username }));
    },
    async enableUser(username) {
      await client.send(new AdminEnableUserCommand({ UserPoolId, Username: username }));
    },
    async signOutEverywhere(username) {
      await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId, Username: username }));
    },
    phones: createPhoneStore(tableClient()),
    now: () => new Date(),
    report: (line) => process.stdout.write(`console:block: ${line}\n`),
  };
}
