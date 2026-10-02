// `npm run leads:optout -- --email <address>` (ADR-0015 §6, FL-117): the contact consent of a lead goes
// to false, with the withdrawal dated in its `consentHistory`; the account keeps working. Inside
// `sst shell --stage poc`; the terminal never shows the address or any data of the lead.
import { leadEmailHash } from "../../packages/bff/src/lib/crypto";
import { parseFlags } from "../channels/cli-args";
import { type LeadScriptDeps, assertStage, runIfMain, stageDeps } from "./common";

export function parseEmailArgs(argv: readonly string[], options: { readonly yes?: boolean } = {}): { email: string; yes: boolean } {
  let email: string | undefined;
  let stage: string | undefined;
  let yes = false;
  parseFlags(argv, {
    "--email": (value) => void (email = value()),
    "--stage": (value) => void (stage = value()),
    ...(options.yes === true ? { "--yes": () => void (yes = true) } : {}),
  });
  if (email === undefined || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) throw new RangeError("--email <address> is required");
  assertStage(stage);
  return { email: email.trim().toLowerCase(), yes };
}

export async function runOptout(deps: Pick<LeadScriptDeps, "leads" | "leadEmailKey" | "now">, argv: readonly string[], print: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<boolean> {
  const { email } = parseEmailArgs(argv);
  const now = deps.now();
  const lead = await deps.leads.optOutContact(leadEmailHash(deps.leadEmailKey, email), now.toISOString(), now);
  print(lead === undefined ? "leads:optout: no lead with that address" : `leads:optout: contact consent withdrawn for lead ${lead.leadId}`);
  return lead !== undefined;
}

runIfMain(import.meta.url, async () => void (await runOptout(stageDeps(), process.argv.slice(2))));
