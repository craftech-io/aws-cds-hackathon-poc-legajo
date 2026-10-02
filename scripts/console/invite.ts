// Creates console users (docs/architecture.md §10, docs/pending.md P-05): nobody signs up, the
// operator invites. Runs inside `sst shell` (the pool id and the `Firms` table arrive through the
// linked resources) and writes nothing unless every flag parsed.
//
//   npm run console:invite -- --stage poc --guest <n>                 guest-NN of firm-guest-NN
//   npm run console:invite -- --stage poc --guest-test                guest-test of firm-guest-test
//   npm run console:invite -- --stage poc --email <address> --firm <firmId> --broker <brokerId>
//   add --reset-password to give an existing guest account a new password
//
// Guests get no email: a permanent password (generated, or GUEST_TEST_PASSWORD for `guest-test`, the
// CI secret `SC-24` and `SC-25` sign in with), MFA off, group GUEST and `custom:firmId`. Their broker
// row and world are created by their first sign-in. A generated password is never printed: it is
// appended to `guest-credentials.local.json` (git-ignored, mode 0600) for the operator to hand over
// through a private channel. A broker or analyst gets Cognito's invitation email with a temporary
// password, the group of its broker row, and the row is bound to the new user's `sub` (the seed keeps
// that binding across reloads).
import { createHash, randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrokerId, FirmId, type ConsoleRole } from "@legajo/shared";
import { parseFlags } from "../channels/cli-args";

export const CREDENTIALS_FILE = "guest-credentials.local.json";
export const GUEST_TEST_PASSWORD_ENV = "GUEST_TEST_PASSWORD";
export const STAGE = "poc";

/** Cognito's policy of the pool (infra/auth-email.ts `PASSWORD_POLICY`): 12+ with every class. */
export const PASSWORD_LENGTH = 20;
const CLASSES = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+-=?@^_"] as const;

export type InvitePlan =
  | { readonly kind: "GUEST"; readonly username: string; readonly firmId: string; readonly password: "GENERATE" | "FROM_ENV"; readonly resetPassword: boolean }
  | { readonly kind: "BROKER"; readonly username: string; readonly email: string; readonly firmId: string; readonly brokerId: string };

export interface InviteArgs {
  stage?: string;
  guest?: string;
  guestTest?: boolean;
  email?: string;
  firm?: string;
  broker?: string;
  resetPassword?: boolean;
}

export function parseInviteArgs(argv: readonly string[]): InviteArgs {
  const args: InviteArgs = {};
  parseFlags(argv, {
    "--stage": (value) => void (args.stage = value()),
    "--guest": (value) => void (args.guest = value()),
    "--guest-test": () => void (args.guestTest = true),
    "--email": (value) => void (args.email = value()),
    "--firm": (value) => void (args.firm = value()),
    "--broker": (value) => void (args.broker = value()),
    "--reset-password": () => void (args.resetPassword = true),
  });
  return args;
}

/** `b` + 8 hex characters of the address: Cognito refuses an email-shaped username while email is an alias. */
export function brokerUsername(email: string): string {
  return `b${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 8)}`;
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function planInvite(args: InviteArgs): InvitePlan {
  if (args.stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  const guest = args.guest !== undefined || args.guestTest === true;
  const broker = args.email !== undefined || args.firm !== undefined || args.broker !== undefined;
  if (guest === broker || (args.guest !== undefined && args.guestTest === true)) throw new RangeError("choose one of --guest <n>, --guest-test, or --email with --firm and --broker");
  if (args.guestTest) return { kind: "GUEST", username: "guest-test", firmId: "firm-guest-test", password: "FROM_ENV", resetPassword: args.resetPassword === true };
  if (args.guest !== undefined) {
    const number = Number(args.guest);
    if (!Number.isInteger(number) || number < 1 || number > 99) throw new RangeError("--guest takes a number from 1 to 99");
    const nn = String(number).padStart(2, "0");
    return { kind: "GUEST", username: `guest-${nn}`, firmId: `firm-guest-${nn}`, password: "GENERATE", resetPassword: args.resetPassword === true };
  }
  if (args.resetPassword) throw new RangeError("--reset-password only applies to guest accounts");
  const email = (args.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new RangeError("--email needs an address");
  const firmId = FirmId.parse(args.firm);
  if (firmId.startsWith("firm-guest-")) throw new RangeError("guest firms get guest accounts (--guest)");
  return { kind: "BROKER", username: brokerUsername(email), email, firmId, brokerId: BrokerId.parse(args.broker) };
}

/** A password of every class the pool requires, from a CSPRNG. */
export function generatePassword(length: number = PASSWORD_LENGTH): string {
  const all = CLASSES.join("");
  const chars = [...CLASSES.map((set) => set[randomInt(set.length)] ?? ""), ...Array.from({ length: length - CLASSES.length }, () => all[randomInt(all.length)] ?? "")];
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [chars[index], chars[other]] = [chars[other] ?? "", chars[index] ?? ""];
  }
  return chars.join("");
}

/** What the script needs of Cognito and of `Firms`; invite-cognito.ts talks to the real ones. */
export interface InviteDeps {
  findUser(username: string): Promise<{ readonly sub: string } | undefined>;
  createUser(input: { readonly username: string; readonly firmId: string; readonly email?: string }): Promise<{ readonly sub: string }>;
  setPermanentPassword(username: string, password: string): Promise<void>;
  disableMfa(username: string): Promise<void>;
  addToGroup(username: string, group: ConsoleRole): Promise<void>;
  brokerRole(firmId: string, brokerId: string): Promise<ConsoleRole>;
  bindBroker(firmId: string, brokerId: string, sub: string): Promise<void>;
  guestTestPassword(): string | undefined;
  /** Keeps a generated password for the operator; never printed. */
  saveCredential(username: string, firmId: string, password: string): void;
  report(line: string): void;
}

export async function runInvite(plan: InvitePlan, deps: InviteDeps): Promise<void> {
  if (plan.kind === "BROKER") {
    const role = await deps.brokerRole(plan.firmId, plan.brokerId);
    if (role === "GUEST") throw new RangeError("a GUEST broker row is not invited by email");
    const existing = await deps.findUser(plan.username);
    const { sub } = existing ?? (await deps.createUser({ username: plan.username, firmId: plan.firmId, email: plan.email }));
    await deps.addToGroup(plan.username, role);
    await deps.bindBroker(plan.firmId, plan.brokerId, sub);
    deps.report(`${existing ? "kept" : "invited"} ${plan.username} (${role} of ${plan.firmId}, broker ${plan.brokerId})`);
    return;
  }
  const existing = await deps.findUser(plan.username);
  if (existing === undefined) await deps.createUser({ username: plan.username, firmId: plan.firmId });
  if (existing === undefined || plan.resetPassword) {
    const password = plan.password === "FROM_ENV" ? deps.guestTestPassword() : generatePassword();
    if (!password) throw new RangeError(`${GUEST_TEST_PASSWORD_ENV} is required for guest-test`);
    await deps.setPermanentPassword(plan.username, password);
    if (plan.password === "GENERATE") deps.saveCredential(plan.username, plan.firmId, password);
  }
  await deps.disableMfa(plan.username);
  await deps.addToGroup(plan.username, "GUEST");
  const passwordNote = existing !== undefined && !plan.resetPassword ? "password unchanged" : plan.password === "GENERATE" ? `password in ${CREDENTIALS_FILE}` : "password from the environment";
  deps.report(`${existing ? "kept" : "created"} ${plan.username} (GUEST of ${plan.firmId}; ${passwordNote})`);
}

/** Appends to the git-ignored credentials file, readable by the operator only. */
export function saveCredentialTo(path: string, username: string, firmId: string, password: string, now: Date): void {
  const current: Record<string, unknown> = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  current[username] = { firmId, password, createdAt: now.toISOString(), login: "https://legajo.demo.craftech.io/login" };
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function main(): Promise<void> {
  const plan = planInvite(parseInviteArgs(process.argv.slice(2)));
  const { cognitoInviteDeps } = await import("./invite-cognito");
  const credentials = resolve(process.cwd(), CREDENTIALS_FILE);
  await runInvite(plan, cognitoInviteDeps({ saveCredential: (username, firmId, password) => saveCredentialTo(credentials, username, firmId, password, new Date()) }));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
    process.stderr.write(`console:invite: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
