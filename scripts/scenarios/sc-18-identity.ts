// SC-18 · identity and robustness of WhatsApp (docs/test-plan.md §4.5). World `sc18`: op-4474 (`a`) and
// op-4475 (`b`) share one importer (two open operations), and a clone of op-4471 (`c`) has its own;
// default rate limit (20 per sender and simulated hour). World `sc18-rate`: a clone of op-4474 with a
// limit of 3. Thursday 15/10 10:30, inside business hours.
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import { SENT_STATUSES, decisions, inbound, outbound } from "./lib/asserts";
import { importerSays } from "./lib/flows";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { advanceBy, awaitState, createWorld, opOf, worldOf } from "./lib/world";

const START = "2026-10-15T10:30:00-03:00";
const ETA = "2026-10-29T10:00:00-03:00";

const turnsOf = (snapshot: QaSnapshot) => snapshot.turnNotes.length;

async function turnsInWorld(ctx: ScenarioContext, suffix = "main"): Promise<number> {
  const metrics = (await ctx.qa("metrics.get", { clockId: worldOf(ctx, suffix).clockId })) as { usage: { turns: number } };
  return metrics.usage.turns;
}

export const sc18 = defineScenario({
  id: "SC-18",
  slug: "sc18",
  title: "WhatsApp identity and robustness",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "a number that is not registered runs no turn",
      flows: ["FL-093"],
      async run(ctx) {
        await createWorld(ctx, {
          startAtSim: START,
          operations: [
            { key: "a", model: "op-4474", etaOverride: ETA },
            { key: "b", model: "op-4475", etaOverride: ETA, importer: "a" },
            { key: "c", model: "op-4471", etaOverride: ETA },
          ],
        });
        const { operationId } = opOf(ctx, "a");
        const before = await turnsInWorld(ctx);
        await ctx.qa("wa.inbound", { operationId, from: "UNREGISTERED", message: { type: "text", text: "Hola, ¿me pasan el estado de mi importación?" } });
        const settled = await ctx.settled(operationId);
        ctx.none(settled, "inbound messages from an unknown number in the operation", inbound(settled, { channel: "WHATSAPP" }));
        ctx.check((await turnsInWorld(ctx)) === before, "no turn and no Bedrock cost");
      },
    },
    {
      n: 2,
      title: "the fourth message of a sender in one simulated hour is refused; the next hour it passes",
      flows: ["FL-094"],
      async run(ctx) {
        await createWorld(ctx, { suffix: "rate", rateLimitPerHour: 3, startAtSim: START, operations: [{ key: "a", model: "op-4474", etaOverride: ETA }] });
        const { operationId } = opOf(ctx, "a", "rate");
        for (const text of ["Hola", "¿Siguen ahí?", "Mando el packing list después", "Una consulta más"]) await importerSays(ctx, operationId, text);
        const limited = await ctx.settled(operationId);
        ctx.exactly(limited, 1, "DENY RATE_LIMIT", decisions(limited, { decision: "DENY", action: "RATE_LIMIT" }));
        await advanceBy(ctx, operationId, 60);
        await importerSays(ctx, operationId, "Ahora sí, ¿me confirman?");
        const passed = await ctx.settled(operationId);
        ctx.check(inbound(passed, { channel: "WHATSAPP" }).length === inbound(limited, { channel: "WHATSAPP" }).length + 1, "the message of the next hour entered");
        ctx.exactly(passed, 1, "DENY RATE_LIMIT (none new)", decisions(passed, { decision: "DENY", action: "RATE_LIMIT" }));
      },
    },
    {
      n: 3,
      title: "the same wamid delivered twice is one message",
      flows: ["FL-034"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "c");
        await importerSays(ctx, operationId, "¿Cómo sigue lo de los documentos?");
        const wamidOf = ctx.lastKey();
        await ctx.qa("wa.inbound", { operationId, message: { type: "text", text: "¿Cómo sigue lo de los documentos?" }, ...(wamidOf === undefined ? {} : { wamidOf }) });
        const settled = await ctx.settled(operationId);
        ctx.exactly(settled, 1, "inbound messages for one wamid", inbound(settled, { channel: "WHATSAPP" }));
        ctx.check(turnsOf(settled) <= 1, "one turn");
      },
    },
    {
      n: 4,
      title: "an importer with two open operations gets the list and no turn yet",
      flows: ["FL-019"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        await importerSays(ctx, operationId, "¿Ya llegó lo del proveedor?");
        await awaitState(ctx, operationId, "OPERATION_CHOICE", (snapshot) => outbound(snapshot, { kind: "OPERATION_CHOICE", status: [...SENT_STATUSES] }).length > 0);
        for (const key of ["a", "b"]) {
          const settled = await ctx.settled(opOf(ctx, key).operationId);
          ctx.none(settled, `turns of ${key} before the choice`, settled.turnNotes);
        }
      },
    },
    {
      n: 5,
      title: "the choice runs the turn in the chosen operation only",
      flows: ["FL-019"],
      async run(ctx) {
        const [a, b] = [opOf(ctx, "a").operationId, opOf(ctx, "b").operationId];
        await ctx.qa("wa.inbound", { operationId: a, message: { type: "choice", choose: b } });
        await awaitState(ctx, b, "the turn in the chosen operation", (snapshot) => snapshot.turnNotes.length > 0);
        const other = await ctx.settled(a);
        ctx.none(other, "turns in the operation not chosen", other.turnNotes);
      },
    },
    {
      n: 6,
      title: "“¿qué me falta?” lists the missing documents",
      flows: ["FL-020"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "c");
        const since = (await ctx.snapshot(operationId)).clock.simNow;
        await importerSays(ctx, operationId, "¿Qué me falta?");
        const answered = await awaitState(ctx, operationId, "a REPLY", (snapshot) => outbound(snapshot, { kind: "REPLY", status: [...SENT_STATUSES], sinceSim: since }).length > 0);
        const missing = answered.documents.filter((row) => row.status !== "VALID").map((row) => row.docType).sort();
        const reply = outbound(answered, { kind: "REPLY", sinceSim: since })[0];
        ctx.check(JSON.stringify([...(reply?.refs.docTypes ?? [])].sort()) === JSON.stringify(missing), "refs.docTypes are the missing documents");
      },
    },
    {
      n: 7,
      title: "a foreign nonce and an expired one do nothing",
      flows: ["FL-095"],
      async run(ctx) {
        const [a, c] = [opOf(ctx, "a").operationId, opOf(ctx, "c").operationId];
        await ctx.qa("wa.inbound", { operationId: a, message: { type: "button", action: "SUPPLIER_SENDS", nonceFrom: c } });
        await ctx.qa("nonce.expire", { operationId: c, action: "UPLOAD" });
        await ctx.qa("wa.inbound", { operationId: c, message: { type: "button", action: "UPLOAD" } });
        let refusals = 0;
        for (const operationId of [a, c]) {
          const settled = await ctx.settled(operationId);
          refusals += settled.decisions.filter((row) => row.decision === "DENY" && row.action.startsWith("NONCE_")).length;
          ctx.none(settled, "contact confirmations caused by a refused nonce", outbound(settled, { kind: "CONTACT_CONFIRMATION" }));
        }
        ctx.check(refusals >= 2, `both refused nonces are audited (found ${refusals})`);
      },
    },
  ],
});
