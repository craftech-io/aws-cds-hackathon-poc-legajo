// `npm run leads:export -- --out <file.csv> [--contactable] [--since AAAA-MM-DD]` (ADR-0015 §6, FL-116):
// the leads as CSV for Craftech's sales follow-up, inside `sst shell --stage poc`. Only `LEAD` items
// (never a pending sign-up or a tombstone), never the QA mailboxes of `sim.legajo.demo.craftech.io`;
// `emailStatus` from `Runtime/MAILSTATUS#<emailHash>` (`OK` when there is none). The file goes only
// outside the repository, with mode 0600, every cell that starts with = + - @ neutralized against
// formula injection; the terminal shows only how many rows were written.
import { chmodSync, writeFileSync } from "node:fs";
import { SIM_MAIL_DOMAIN } from "@legajo/shared";
import { readMailStatus } from "../../packages/bff/src/channels/email/mail-status";
import type { Lead } from "../../packages/bff/src/leads/lead";
import { parseFlags } from "../channels/cli-args";
import { type LeadScriptDeps, assertStage, insideRepo, runIfMain, stageDeps } from "./common";

export const EXPORT_COLUMNS = [
  "email",
  "name",
  "company",
  "jobTitle",
  "language",
  "sourcePoc",
  "contactConsent",
  "contactConsentAt",
  "contactConsentVersion",
  "termsVersion",
  "termsAcceptedAt",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
  "referrer",
  "signupAt",
  "lastLoginAt",
  "emailStatus",
] as const;

export interface ExportArgs {
  out?: string;
  contactable: boolean;
  since?: string;
  stage?: string;
}

export function parseExportArgs(argv: readonly string[]): ExportArgs & { out: string } {
  const args: ExportArgs = { contactable: false };
  parseFlags(argv, {
    "--out": (value) => void (args.out = value()),
    "--contactable": () => void (args.contactable = true),
    "--since": (value) => void (args.since = value()),
    "--stage": (value) => void (args.stage = value()),
  });
  if (args.out === undefined) throw new RangeError("--out <file.csv> is required");
  if (args.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new RangeError("--since takes AAAA-MM-DD");
  assertStage(args.stage);
  return { ...args, out: args.out };
}

/** A CSV cell: quoted, inner quotes doubled, and a leading = + - @ neutralized with an apostrophe. */
export function csvCell(value: string | undefined): string {
  const text = value ?? "";
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export type EmailStatus = "OK" | "BOUNCED" | "COMPLAINED";

export function exportRow(lead: Lead, emailStatus: EmailStatus): string[] {
  const { contact, terms } = lead.consents;
  return [
    lead.email,
    lead.name,
    lead.company,
    lead.jobTitle,
    lead.language,
    lead.sourcePoc,
    contact.accepted ? "true" : "false",
    contact.at,
    contact.version,
    terms.version,
    terms.at,
    lead.utm.source,
    lead.utm.medium,
    lead.utm.campaign,
    lead.utm.term,
    lead.utm.content,
    lead.referrer,
    lead.signupAt,
    lead.lastLoginAt,
    emailStatus,
  ].map(csvCell);
}

/** The CSV and how many rows it has; the leads of QA mailboxes never appear. */
export async function buildExport(deps: Pick<LeadScriptDeps, "leads" | "client">, args: Pick<ExportArgs, "contactable" | "since">): Promise<{ readonly csv: string; readonly rows: number }> {
  const lines = [EXPORT_COLUMNS.map(csvCell).join(",")];
  let rows = 0;
  const leads = (await deps.leads.listLeads()).sort((a, b) => a.signupAt.localeCompare(b.signupAt));
  for (const lead of leads) {
    if (lead.email.endsWith(`@${SIM_MAIL_DOMAIN}`)) continue;
    if (args.since !== undefined && lead.signupAt.slice(0, 10) < args.since) continue;
    const status: EmailStatus = (await readMailStatus(deps.client, lead.emailHash))?.status ?? "OK";
    if (args.contactable && (!lead.consents.contact.accepted || status !== "OK")) continue;
    lines.push(exportRow(lead, status).join(","));
    rows += 1;
  }
  return { csv: `${lines.join("\n")}\n`, rows };
}

export async function runExport(deps: Pick<LeadScriptDeps, "leads" | "client">, argv: readonly string[], print: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  const args = parseExportArgs(argv);
  if (insideRepo(args.out)) throw new RangeError("--out must be outside the repository: a lead file is never committed");
  const { csv, rows } = await buildExport(deps, args);
  writeFileSync(args.out, csv, { mode: 0o600 });
  chmodSync(args.out, 0o600);
  print(`leads:export: ${rows} row(s) written`);
  return rows;
}

runIfMain(import.meta.url, async () => void (await runExport(stageDeps(), process.argv.slice(2))));
