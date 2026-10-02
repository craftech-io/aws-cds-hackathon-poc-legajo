import { describe, expect, it } from "vitest";
import { leadEmailHash } from "../../packages/bff/src/lib/crypto";
import { LEADS_TABLE, tombKey } from "../../packages/bff/src/leads/lead";
import { runDelete } from "./delete";
import { leadsWorld } from "./testing";

const EMAIL = "ana@despachos-del-sur.com.ar";

describe("[FL-118] npm run leads:delete", () => {
  it("asks first without --yes, and deletes nothing on a no", async () => {
    const world = leadsWorld();
    await world.addLead(EMAIL);
    const printed: string[] = [];
    expect(await runDelete(world.deps, ["--email", EMAIL], async () => false, (line) => printed.push(line))).toBeUndefined();
    expect(printed).toEqual(["leads:delete: nothing deleted"]);
    expect(await world.access.leads.get(leadEmailHash(world.deps.leadEmailKey, EMAIL))).toBeDefined();
  });

  it("with --yes deletes the account and the lead, leaves the tombstone and prints only the leadId", async () => {
    const world = leadsWorld();
    await world.addLead(EMAIL);
    world.access.cognito.seed({ username: "usr-ana", email: EMAIL, groups: ["GUEST"] });
    const leadId = (await world.access.leads.get(leadEmailHash(world.deps.leadEmailKey, EMAIL)))?.leadId;
    const printed: string[] = [];
    expect(await runDelete(world.deps, ["--email", EMAIL, "--yes"], async () => false, (line) => printed.push(line))).toBe(leadId);
    expect(printed).toEqual([`leads:delete: ${leadId ?? ""}`]);
    expect(world.access.cognito.users.has("usr-ana")).toBe(false);
    expect(await world.access.leads.get(leadEmailHash(world.deps.leadEmailKey, EMAIL))).toBeUndefined();
    expect(await world.deps.client.get(LEADS_TABLE, tombKey(leadId ?? ""))).toMatchObject({ reason: "REQUEST" });
  });
});
