// The recipient fence of the single SES client for the profiles the public sign-up added or touched
// (docs/architecture-integrations.md §1, ADR-0015 §4 and §6): LEAD_NOTICE writes only from `avisos@` to
// `<local>@craftech.io` exactly, and a SYSTEM mail of a guest world never reaches a registered demo
// recipient. The other profiles' cases live in outbound.test.ts.
import { describe, expect, it } from "vitest";
import { NOTICES_ADDRESS } from "@legajo/shared";
import { checkFence } from "./fence";
import { emailWorld, fenceDeps } from "./testing";

const DEMO_INBOX = "team.lead@legajo-team.example-fict.com";

describe("LEAD_NOTICE: exact @craftech.io recipients", () => {
  it("accepts a mailbox of craftech.io from avisos@", async () => {
    const deps = fenceDeps(await emailWorld());
    expect(await checkFence(deps, { profile: "LEAD_NOTICE", from: NOTICES_ADDRESS, to: "ventas@craftech.io" })).toMatchObject({ allowed: true, awaiting: "SES_EVENT" });
  });

  it.each([
    ["a subdomain", "ventas@mail.craftech.io"],
    ["a look-alike suffix", "ventas@craftech.io.example-fict.com"],
    ["a longer name", "ventas@notcraftech.io"],
    ["another domain", "ventas@example-fict.com"],
    ["a simulated mailbox", "estudio-delta@sim.legajo.demo.craftech.io"],
  ])("refuses %s", async (_label, to) => {
    const deps = fenceDeps(await emailWorld());
    expect(await checkFence(deps, { profile: "LEAD_NOTICE", from: NOTICES_ADDRESS, to })).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "LEAD_NOTICE_RECIPIENT" });
  });

  it("refuses a malformed recipient, a reserved domain and any From but avisos@", async () => {
    const deps = fenceDeps(await emailWorld());
    expect(await checkFence(deps, { profile: "LEAD_NOTICE", from: NOTICES_ADDRESS, to: "Ventas <ventas@craftech.io>" })).toMatchObject({ allowed: false, code: "INVALID" });
    expect(await checkFence(deps, { profile: "LEAD_NOTICE", from: NOTICES_ADDRESS, to: "ventas@example.com" })).toMatchObject({ allowed: false, reason: "RESERVED_DOMAIN" });
    expect(await checkFence(deps, { profile: "LEAD_NOTICE", from: "no-reply@legajo.demo.craftech.io", to: "ventas@craftech.io" })).toMatchObject({ allowed: false, code: "INVALID", reason: "LEAD_NOTICE_FROM" });
  });
});

describe("[FL-123] SYSTEM in a guest world writes only to simulated mailboxes", () => {
  it("a registered demo recipient is reachable from a demo world and never from a guest world", async () => {
    const deps = fenceDeps(await emailWorld(), [DEMO_INBOX]);
    expect(await checkFence(deps, { profile: "SYSTEM", from: NOTICES_ADDRESS, to: DEMO_INBOX, clockId: "GLOBAL#firm-delta" })).toMatchObject({ allowed: true });
    expect(await checkFence(deps, { profile: "SYSTEM", from: NOTICES_ADDRESS, to: DEMO_INBOX, clockId: "GUEST#firm-guest-41" })).toMatchObject({ allowed: false, reason: "SYSTEM_RECIPIENT" });
    expect(await checkFence(deps, { profile: "SYSTEM", from: NOTICES_ADDRESS, to: "estudio-g41@sim.legajo.demo.craftech.io", clockId: "GUEST#firm-guest-41" })).toMatchObject({ allowed: true, awaiting: "SIMMAIL" });
    expect(await checkFence(deps, { profile: "SYSTEM", from: NOTICES_ADDRESS, to: "bounce+g41@simulator.amazonses.com", clockId: "GUEST#firm-guest-41" })).toMatchObject({ allowed: true });
  });
});
