import { describe, expect, it } from "vitest";
import { MAIL_BREAKER_KEY, isBreakerOpen } from "../../packages/bff/src/channels/email/mail-status";
import { RUNTIME_TABLE } from "../../packages/bff/src/signup/counters";
import { runBreaker } from "./breaker";
import { NOW, leadsWorld } from "./testing";

describe("[FL-114] npm run signup:breaker", () => {
  it("prints the state, and --close closes an open breaker", async () => {
    const world = leadsWorld();
    const printed: string[] = [];
    expect(await runBreaker(world.deps, [], (line) => printed.push(line))).toBe("CLOSED");
    await world.deps.client.put(RUNTIME_TABLE, { ...MAIL_BREAKER_KEY, entity: "MailBreaker", state: "OPEN", openedAt: NOW.toISOString(), reason: "10 bounces or complaints in 24 h" });
    expect(await runBreaker(world.deps, [], (line) => printed.push(line))).toBe("OPEN");
    expect(await runBreaker(world.deps, ["--close"], (line) => printed.push(line))).toBe("CLOSED");
    expect(await isBreakerOpen(world.deps.client)).toBe(false);
    expect(printed).toEqual(["signup:breaker: CLOSED", "signup:breaker: OPEN", "signup:breaker: CLOSED"]);
    await expect(runBreaker(world.deps, ["--open"])).rejects.toThrow(RangeError);
  });
});
