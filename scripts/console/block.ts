// Blocks or unblocks an account (ADR-0021 §16): the operator's answer to an account that abuses the
// demo. Runs inside `sst shell` (the pool id and the `Leads` table arrive through the linked resources)
// and changes nothing unless every flag parsed.
//
//   npm run console:block -- --stage poc --account <username or email>
//   npm run console:unblock -- --stage poc --account <username or email>
//
// Blocking, for every Cognito user of the username or the address: first the server-side mark
// `blockedAt` of `Leads/PHONE#<sub>/ACCOUNT`, which the BFF reads on every request (routers/
// phone-gate.ts), so the account is cut in the act even with an id token that is still valid; then the
// user is disabled in Cognito, every refresh token is revoked (global sign-out) and every session mark
// of the second factor and the SMS code in flight are deleted. Unblocking enables the user again and
// lifts the mark; the account signs in and passes the SMS code like any other. No procedure of the web
// sets or lifts the mark. The terminal shows usernames and counts, never an address.
import { resolve } from "node:path";
import type { PhoneStore } from "@legajo/bff/phone-verification/store";
import { parseFlags } from "../channels/cli-args";

export const STAGE = "poc";

export interface BlockPlan {
  readonly action: "BLOCK" | "UNBLOCK";
  /** A Cognito username, or an email address (lower-cased), as the operator typed it. */
  readonly account: string;
}

export function planBlock(argv: readonly string[]): BlockPlan {
  let stage: string | undefined;
  let account: string | undefined;
  let unblock = false;
  parseFlags(argv, {
    "--stage": (value) => void (stage = value()),
    "--account": (value) => void (account = value()),
    "--unblock": () => void (unblock = true),
  });
  if (stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  const handle = (account ?? "").trim();
  if (handle === "" || /\s/.test(handle)) throw new RangeError("--account <username or email> is required");
  return { action: unblock ? "UNBLOCK" : "BLOCK", account: handle.includes("@") ? handle.toLowerCase() : handle };
}

export interface BlockAccount {
  readonly username: string;
  readonly sub: string;
}

/** What the script needs of Cognito and of `Leads`; block-cognito.ts talks to the real ones. */
export interface BlockDeps {
  /** The user of a username, or every user of an address. */
  findAccounts(account: string): Promise<BlockAccount[]>;
  disableUser(username: string): Promise<void>;
  enableUser(username: string): Promise<void>;
  /** Revokes every refresh token of the user: no session of it gets a new id token. */
  signOutEverywhere(username: string): Promise<void>;
  readonly phones: Pick<PhoneStore, "setBlocked" | "endAllSessions">;
  now(): Date;
  report(line: string): void;
}

export async function runBlock(plan: BlockPlan, deps: BlockDeps): Promise<number> {
  const accounts = await deps.findAccounts(plan.account);
  if (accounts.length === 0) throw new RangeError("no account with that username or email; nothing was changed");
  for (const account of accounts) {
    if (plan.action === "BLOCK") {
      // The mark first: it cuts the account in the act, before Cognito is even asked.
      await deps.phones.setBlocked(account.sub, true, deps.now());
      await deps.disableUser(account.username);
      await deps.signOutEverywhere(account.username);
      const ended = await deps.phones.endAllSessions(account.sub);
      deps.report(`blocked ${account.username} (disabled, signed out, ${ended} phone session item(s) deleted)`);
    } else {
      await deps.enableUser(account.username);
      await deps.phones.setBlocked(account.sub, false, deps.now());
      deps.report(`unblocked ${account.username} (enabled; the next sign-in asks for the SMS code)`);
    }
  }
  return accounts.length;
}

async function main(): Promise<void> {
  const plan = planBlock(process.argv.slice(2));
  const { cognitoBlockDeps } = await import("./block-cognito");
  await runBlock(plan, cognitoBlockDeps());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
    process.stderr.write(`console:block: ${error instanceof RangeError ? error.message : "failed (nothing about the account is printed)"}\n`);
    process.exit(1);
  });
}
