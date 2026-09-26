// SC-16 · consent and registry (docs/test-plan.md §4.5): one world, Thursday 15/10 09:58, every
// request at 10:00. Clones of op-4471 with their own importer and supplier (`a` opts out with the
// button, `b` with the keyword, `c` has its authorization given and taken back, `d` gets its opt-in
// through the console), a clone of op-4473 (importer without opt-in) and one of op-4472 (no
// authorization to write to the supplier). The registry refuses a supplier address outside the fence.
import { SENT_STATUSES, decisions, openEscalations, outbound } from "./lib/asserts";
import type { ConsoleAction } from "./lib/console";
import { importerSays, tap } from "./lib/flows";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { advanceTo, awaitState, createWorld, opOf, worldOf } from "./lib/world";

const START = "2026-10-15T09:58:00-03:00";
const ETA = "2026-10-22T10:00:00-03:00";
const DOCS_REQUEST = "2026-10-15T10:00:00-03:00";
const CONSENT_TEXT_VERSION = "v1";

async function optedOut(ctx: ScenarioContext, key: string) {
  const { operationId } = opOf(ctx, key);
  const revoked = await awaitState(ctx, operationId, "consent revoked and confirmed", (snapshot) => snapshot.parties.consent?.revokedAt !== null && outbound(snapshot, { kind: "OPT_OUT_CONFIRMATION", status: [...SENT_STATUSES] }).length === 1);
  ctx.check(openEscalations(revoked, "OPTED_OUT").length === 1, "the opt-out is escalated to the firm");
  const settled = await ctx.settled(operationId);
  ctx.none(settled, "turns after the opt-out", settled.turnNotes.filter((note) => note.trigger === "IMPORTER_MESSAGE"));
}

export const sc16 = defineScenario({
  id: "SC-16",
  slug: "sc16",
  title: "Consent and registry",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the firm records an importer's WhatsApp opt-in from the console",
      flows: ["FL-001"],
      async run(ctx) {
        const clone = { model: "op-4471", etaOverride: ETA };
        await createWorld(ctx, {
          startAtSim: START,
          operations: [
            { key: "a", ...clone },
            { key: "b", ...clone },
            { key: "c", ...clone },
            { key: "d", ...clone, consent: "NONE" },
            { key: "e", model: "op-4473", etaOverride: ETA, consent: "NONE" },
            { key: "f", model: "op-4472", etaOverride: ETA },
          ],
        });
        const d = opOf(ctx, "d");
        await ctx.qa("console", { procedure: "registry.consent.record", input: { clockId: worldOf(ctx).clockId, importerId: d.importerId, medium: "SIGNED_FORM", grantedAt: START, textVersion: CONSENT_TEXT_VERSION } });
        const settled = await ctx.settled(d.operationId);
        ctx.check(settled.parties.consent !== null && settled.parties.consent.revokedAt === null, "the opt-in is in force");
        ctx.check(decisions(settled, { action: "CONSENT_GRANTED" }).length === 1, "CONSENT_GRANTED is audited");
      },
    },
    {
      n: 2,
      title: "clone a: the “No recibir avisos” button revokes the opt-in without a turn",
      flows: ["FL-016"],
      async run(ctx) {
        await advanceTo(ctx, opOf(ctx, "a").operationId, DOCS_REQUEST);
        await awaitState(ctx, opOf(ctx, "a").operationId, "the request with its buttons", (snapshot) => outbound(snapshot, { kind: "DOCS_REQUEST", status: [...SENT_STATUSES] }).length > 0);
        await tap(ctx, opOf(ctx, "a").operationId, "OPT_OUT");
        await optedOut(ctx, "a");
      },
    },
    {
      n: 3,
      title: "clone b: the keyword BAJA does the same",
      flows: ["FL-016"],
      async run(ctx) {
        await importerSays(ctx, opOf(ctx, "b").operationId, "BAJA");
        await optedOut(ctx, "b");
      },
    },
    {
      n: 4,
      title: "an importer without opt-in gets no WhatsApp: CP-OPTIN and an escalation",
      flows: ["FL-002"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "e");
        await awaitState(ctx, operationId, "DENY CP-OPTIN", (snapshot) => decisions(snapshot, { decision: "DENY", ruleId: "CP-OPTIN" }).length > 0);
        const settled = await ctx.settled(operationId);
        ctx.none(settled, "WhatsApp messages to an importer without opt-in", outbound(settled, { channel: "WHATSAPP" }));
        ctx.check(openEscalations(settled).length >= 1, "the missing opt-in is escalated");
      },
    },
    {
      n: 5,
      title: "clone c: the firm authorizes the agent to write to the supplier, then takes it back",
      flows: ["FL-003", "FL-006"],
      async run(ctx) {
        const c = opOf(ctx, "c");
        const clockId = worldOf(ctx).clockId;
        await ctx.qa("console", { procedure: "registry.authorization.set", input: { clockId, importerId: c.importerId, supplierId: c.supplierId, authorized: true } });
        const given = await ctx.settled(c.operationId);
        ctx.check(given.parties.authorizations.some((row) => row.supplierId === c.supplierId && row.authorized), "AUTH# with the authorization");
        await ctx.qa("console", { procedure: "registry.authorization.set", input: { clockId, importerId: c.importerId, supplierId: c.supplierId, authorized: false } });
        await tap(ctx, c.operationId, "SUPPLIER_SENDS");
        await awaitState(ctx, c.operationId, "DENY CP-SUPPLIER-AUTH on the next attempt", (snapshot) => decisions(snapshot, { decision: "DENY", ruleId: "CP-SUPPLIER-AUTH" }).length > 0);
        const settled = await ctx.settled(c.operationId);
        ctx.none(settled, "emails to the supplier after the revocation", outbound(settled, { channel: "EMAIL" }));
      },
    },
    {
      n: 6,
      title: "“Los manda el proveedor” without authorization: no email, the firm is told",
      flows: ["FL-013"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "f");
        await tap(ctx, operationId, "SUPPLIER_SENDS");
        await awaitState(ctx, operationId, "DENY CP-SUPPLIER-AUTH", (snapshot) => decisions(snapshot, { decision: "DENY", ruleId: "CP-SUPPLIER-AUTH" }).length > 0);
        const settled = await ctx.settled(operationId);
        ctx.none(settled, "emails to the supplier", outbound(settled, { channel: "EMAIL" }));
        ctx.check(openEscalations(settled, "OTHER").length === 1, "escalated to the firm");
      },
    },
    {
      n: 7,
      title: "a supplier address outside the fence is refused; a valid one is added; a repeated one conflicts",
      flows: ["FL-004"],
      async run(ctx) {
        const clockId = worldOf(ctx).clockId;
        const supplier = (email: string): ConsoleAction => ({ procedure: "registry.suppliers.upsert", input: { clockId, name: "Proveedor de prueba (ficticio)", country: "CN", timezone: "Asia/Shanghai", language: "en", contacts: [email] } });
        const fenced = await ctx.attempt("console", supplier("compras@example.com"));
        ctx.check(!fenced.ok && fenced.error.reason === "RECIPIENT_NOT_ALLOWED", "a reserved domain is refused by the fence");
        const valid = `qa-${ctx.runId}-sc16-reg@sim.legajo.demo.craftech.io`;
        const created = await ctx.attempt("console", supplier(valid));
        ctx.check(created.ok, "a supplier with a valid simulated address is created");
        const repeated = await ctx.attempt("console", supplier(valid));
        ctx.check(!repeated.ok && repeated.error.code === "CONFLICT", "the same address again is a CONFLICT");
      },
    },
  ],
});
