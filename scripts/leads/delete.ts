// `npm run leads:delete -- --email <address> [--yes]` (ADR-0015 §6, FL-118; Ley 25.326 art. 16): deletes
// a lead and its account with packages/bff/src/leads/delete.ts, the same module as the retention of the
// sweep and SC-26's `lead.purge`: the world through `WorldJanitor` (`GUEST_DESTROY`, with its S3
// objects), every Cognito user of the address, the lead, its pending sign-ups, `MAILSTATUS#` and the
// counters of its hash, and a `DELETED#<leadId>` tombstone without personal data. Without `--yes` it
// asks first. The terminal shows only the `leadId`.
import { createInterface } from "node:readline/promises";
import { deleteLead } from "../../packages/bff/src/leads/delete";
import { type LeadScriptDeps, runIfMain, stageDeps } from "./common";
import { parseEmailArgs } from "./optout";

export type Confirm = (question: string) => Promise<boolean>;

const askOnTerminal: Confirm = async (question) => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(`${question} (yes/no) `)).trim().toLowerCase() === "yes";
  } finally {
    terminal.close();
  }
};

export async function runDelete(deps: LeadScriptDeps, argv: readonly string[], confirm: Confirm = askOnTerminal, print: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<string | undefined> {
  const { email, yes } = parseEmailArgs(argv, { yes: true });
  if (!yes && !(await confirm("Delete the lead, its account and its world for good?"))) {
    print("leads:delete: nothing deleted");
    return undefined;
  }
  const deletion = await deleteLead(deps, email, "REQUEST");
  print(deletion.leadId === undefined ? `leads:delete: no lead; ${deletion.users} account(s) deleted` : `leads:delete: ${deletion.leadId}`);
  return deletion.leadId;
}

runIfMain(import.meta.url, async () => void (await runDelete(stageDeps(), process.argv.slice(2))));
