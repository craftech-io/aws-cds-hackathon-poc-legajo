// Light load (docs/test-plan.md §6), only on demand (`npm run scenarios -- --scenario LOAD`): 20
// simultaneous messages over 10 operations of one QA world. Nothing goes to the DLQ (no process error
// on any operation), the order per operation holds (FIFO by operation), no message gets two turns, and
// no Bedrock throttle is left unretried (it would surface as a process error).
import { inbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { defineScenario } from "./lib/steps";
import { createWorld, opOf } from "./lib/world";

const START = "2026-10-15T10:30:00-03:00";
const ETA = "2026-10-29T10:00:00-03:00";
const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
const TEXTS = ["¿Qué documentos me faltan?", "¿Hasta cuándo tengo para mandarlos?"];

export const loadLight = defineScenario({
  id: "LOAD",
  slug: "sc90-load",
  title: "Light load: 20 simultaneous messages over 10 operations",
  suites: [],
  steps: [
    {
      n: 1,
      title: "20 messages at once, two per operation",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: KEYS.map((key) => ({ key, model: "op-4471", etaOverride: ETA })) });
        await Promise.all(KEYS.map(async (key) => {
          for (const text of TEXTS) await ctx.qa("wa.inbound", { operationId: opOf(ctx, key).operationId, message: { type: "text", text } });
        }));
      },
    },
    {
      n: 2,
      title: "no process error, the order held and one turn per message at most",
      flows: [],
      async run(ctx) {
        for (const key of KEYS) {
          const settled = await ctx.settled(opOf(ctx, key).operationId, WAITS.settleSec);
          ctx.check(settled.processError === null, `${key}: an event went to the DLQ`);
          const received = inbound(settled, { channel: "WHATSAPP" }).map((message) => message.body);
          ctx.check(received.length === TEXTS.length && received.every((body, index) => body === TEXTS[index]), `${key}: the messages kept their order`);
          ctx.check(settled.turnNotes.length <= TEXTS.length, `${key}: no message got two turns`);
        }
      },
    },
  ],
});
