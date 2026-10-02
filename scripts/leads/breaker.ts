// `npm run signup:breaker [-- --close]` (ADR-0015 §3.2, FL-114): the reputation breaker of the account
// emails. Without flags it prints its state; with `--close`, the operator closes it after reviewing the
// cause (only the operator does: `ChannelEvents` opens it, nothing closes it by itself). Inside
// `sst shell --stage poc`; it prints only the state.
import { closeBreaker, readBreaker } from "../../packages/bff/src/channels/email/mail-status";
import { parseFlags } from "../channels/cli-args";
import { type LeadScriptDeps, assertStage, runIfMain, stageDeps } from "./common";

export async function runBreaker(deps: Pick<LeadScriptDeps, "client" | "now">, argv: readonly string[], print: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<"OPEN" | "CLOSED"> {
  let close = false;
  let stage: string | undefined;
  parseFlags(argv, { "--close": () => void (close = true), "--stage": (value) => void (stage = value()) });
  assertStage(stage);
  const state = close ? await closeBreaker(deps.client, deps.now()) : await readBreaker(deps.client);
  print(`signup:breaker: ${state.state}`);
  return state.state;
}

runIfMain(import.meta.url, async () => void (await runBreaker(stageDeps(), process.argv.slice(2))));
