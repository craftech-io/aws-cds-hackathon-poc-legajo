// Local flows of the contact policy in time (docs/flows-catalog.md, areas C and F): a send out of the
// supplier's business hours is deferred as a `TIMER#DEFERRED_SEND` and goes out when the clock reaches
// it, and free text after the 24-hour window needs a template. The demo world's clock is paused; only the
// clock module moves it, so every hour is exact.
import { describe, expect, it } from "vitest";
import { READ_DOSSIER, READ_OPERATION, field, missingText, reply } from "./support/plans";
import { useFlowWorld } from "./support/lifecycle";
import type { Plan } from "./support/scripted-harness";
import { DELEGATED, delegateToSupplier } from "./support/stories";

const worlds = useFlowWorld();

describe("contact policy flows", () => {
  it("[FL-033] a request to Shenzhen at 23:00 Shenzhen time is DEFERRED by CP-HOURS-SUPPLIER to 09:00 there as a TIMER#DEFERRED_SEND, and the clock reaching it re-decides and sends it inside business hours", async () => {
    const flow = await worlds.open({ "4486": { ...DELEGATED } });
    await flow.advance({ to: "2026-10-15T12:00:00-03:00" });

    await delegateToSupplier(flow, "op-4486");

    const [deferred] = (await flow.messages("op-4486")).filter((message) => message.channel === "EMAIL");
    expect(deferred).toMatchObject({ status: "DEFERRED", kind: "DOCS_REQUEST" });
    const [timer] = await flow.data.timers.listTimers("op-4486", { kind: "DEFERRED_SEND" });
    expect(timer).toMatchObject({ status: "SCHEDULED", reason: "CP-HOURS-SUPPLIER" });
    expect(Date.parse(timer?.dueAtSim ?? "")).toBe(Date.parse("2026-10-16T09:00:00+08:00"));
    const defer = (await flow.data.audit.listByOperation("op-4486")).find((row) => row.decision === "DEFER");
    expect(defer?.ruleIds).toContain("CP-HOURS-SUPPLIER");

    await flow.advance({ next: true });

    const [sent] = (await flow.messages("op-4486")).filter((message) => message.channel === "EMAIL" && message.direction === "OUT");
    expect(sent).toMatchObject({ status: "SENT", messageId: deferred?.messageId });
    expect(Date.parse(sent?.sentAtSim ?? "")).toBe(Date.parse("2026-10-16T09:00:00+08:00"));
    expect((await flow.data.timers.listTimers("op-4486", { kind: "DEFERRED_SEND" }))[0]?.status).toBe("FIRED");
  });

  it("[FL-055] (a) free text inside the importer's 24-hour window goes out", async () => {
    const flow = await worlds.open({ "4474": { IMPORTER_MESSAGE: [{ steps: [READ_DOSSIER, reply("REPLY", (context) => `Te faltan ${missingText(context)}.`)], note: "Respondí." }] } });

    await flow.say("imp-patagonia", "4474", "¿Qué me falta?");

    const turn = flow.harness.turns[0];
    expect(turn?.calls[1]?.output).toMatchObject({ ok: true, status: "SENT", windowState: "OPEN" });
  });

  it("[FL-055] (b) 25 hours after the importer's last message, free text answers TEMPLATE_REQUIRED and the plan's second call uses legajo_recordatorio; no free text leaves", async () => {
    const reminder: Plan = {
      steps: [
        READ_OPERATION,
        READ_DOSSIER,
        reply("REMINDER", (context) => `Siguen faltando ${missingText(context)}.`),
        { tool: "send_whatsapp", input: (context) => ({ recipientRole: "IMPORTER", kind: "REMINDER", template: { name: "legajo_recordatorio", params: [field(context.calls, "get_operation", "operation", "operationNumber"), missingText(context), field(context.calls, "get_dossier", "deadlines", "importer", "text")] } }) },
      ],
      note: "Recordatorio con plantilla.",
    };
    const flow = await worlds.open({ "4474": { IMPORTER_MESSAGE: [{ steps: [READ_OPERATION], note: "Leí." }], MILESTONE: [reminder] } });
    await flow.say("imp-patagonia", "4474", "Mañana los mando.");
    await flow.advance({ to: "2026-10-15T11:31:00-03:00" });

    await flow.fire("op-4474", "DOCS_REQUEST");

    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "MILESTONE" && candidate.envelope.event.operation === "4474");
    expect(turn?.calls[2]?.output).toMatchObject({ ok: false, error: { code: "TEMPLATE_REQUIRED" } });
    expect(turn?.calls[3]?.output).toMatchObject({ ok: true, templateUsed: "legajo_recordatorio" });
    const out = (await flow.messages("op-4474")).filter((message) => message.direction === "OUT" && message.author === "AGENT");
    expect(out.map((message) => message.template?.name)).toEqual(["legajo_recordatorio"]);
  });
});
