// What the operator's lead scripts share (ADR-0015 §6): the stage (only `poc`), the stores they reach
// inside `sst shell --stage poc` (the same discovery as `console:invite`: tables, pool, functions and
// the `SessionTokenKey` arrive as linked resources, never from the environment), and the two rules of
// their output: a file only outside the repository, and nothing on the terminal but counts or ids.
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authConfig } from "../../packages/bff/src/auth/config";
import { type TableClient, tableClient } from "../../packages/bff/src/connector/index";
import { subkey } from "../../packages/bff/src/lib/secrets";
import { type LeadStore, createLeadStore } from "../../packages/bff/src/leads/store";
import { type SignupCognito, createSignupCognito } from "../../packages/bff/src/signup/cognito";
import { type AsyncInvoker, lambdaAsyncInvoker } from "../../packages/bff/src/signup/invoke";
import { type SignupStore, createSignupStore } from "../../packages/bff/src/signup/store";

export const STAGE = "poc";
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface LeadScriptDeps {
  readonly client: TableClient;
  readonly leads: LeadStore;
  readonly signups: SignupStore;
  readonly cognito: SignupCognito;
  readonly invoker: AsyncInvoker;
  readonly leadEmailKey: Uint8Array;
  readonly now: () => Date;
}

/** The stage's stores, read through the links `sst shell` provides. */
export function stageDeps(): LeadScriptDeps {
  const client = tableClient();
  return {
    client,
    leads: createLeadStore(client),
    signups: createSignupStore(client),
    cognito: createSignupCognito(authConfig()),
    invoker: lambdaAsyncInvoker(),
    leadEmailKey: subkey("lead-email"),
    now: () => new Date(),
  };
}

export function assertStage(stage: string | undefined): void {
  if (stage !== undefined && stage !== STAGE) throw new RangeError(`these scripts only run on the ${STAGE} stage`);
}

/** True when `path` is inside the repository (a lead file there could be committed). */
export function insideRepo(path: string, root: string = REPO_ROOT): boolean {
  const rel = relative(resolve(root), resolve(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** Runs `main` when the file is executed directly, printing only a generic error. */
export function runIfMain(metaUrl: string, main: () => Promise<void>): void {
  if (process.argv[1] === undefined || resolve(process.argv[1]) !== fileURLToPath(metaUrl)) return;
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof RangeError ? error.message : "failed (no lead data is printed)"}\n`);
    process.exitCode = 1;
  });
}
