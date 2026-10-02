import { describe, expect, it } from "vitest";
import { leadEmailHash } from "../../packages/bff/src/lib/crypto";
import { runOptout } from "./optout";
import { NOW, leadsWorld } from "./testing";

describe("[FL-117] npm run leads:optout", () => {
  it("withdraws the contact consent with its date, keeps the history and never prints the address", async () => {
    const world = leadsWorld();
    await world.addLead("ana@despachos-del-sur.com.ar");
    const printed: string[] = [];
    expect(await runOptout(world.deps, ["--email", " Ana@Despachos-del-Sur.com.ar "], (line) => printed.push(line))).toBe(true);
    const lead = await world.access.leads.get(leadEmailHash(world.deps.leadEmailKey, "ana@despachos-del-sur.com.ar"));
    expect(lead?.consents.contact).toMatchObject({ accepted: false, at: NOW.toISOString() });
    expect(lead?.consentHistory.at(-1)).toMatchObject({ consent: "contact", accepted: false, at: NOW.toISOString() });
    expect(printed.join("\n")).not.toContain("despachos-del-sur");
    expect(printed).toEqual([`leads:optout: contact consent withdrawn for lead ${lead?.leadId ?? ""}`]);
  });

  it("an unknown address changes nothing; a missing one is refused", async () => {
    const world = leadsWorld();
    const printed: string[] = [];
    expect(await runOptout(world.deps, ["--email", "nadie@despachos-del-sur.com.ar"], (line) => printed.push(line))).toBe(false);
    expect(printed).toEqual(["leads:optout: no lead with that address"]);
    await expect(runOptout(world.deps, [])).rejects.toThrow(RangeError);
  });
});
