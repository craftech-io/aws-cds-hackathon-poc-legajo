// Local flows of an ETA change (docs/flows-catalog.md, area G): the console's "Mover ETA" goes to the
// platform mock in process, the platform publishes `CarrierEtaChanged` on the `Feeds` bus and the event
// reaches `FeedEvents` as EventBridge delivers it; `reschedule_on_eta_change` moves the milestones by
// code and the turn only tells the parties the new deadline.
import { describe, expect, it } from "vitest";
import { DOCS_REQUEST_PLAN, READ_DOSSIER, READ_OPERATION, field, supplierEmail } from "./support/plans";
import { useFlowWorld } from "./support/lifecycle";
import type { Plan } from "./support/scripted-harness";
import { DELEGATE_PLAN } from "./support/stories";

const worlds = useFlowWorld();

const ETA_NOTICE: Plan = {
  steps: [
    READ_OPERATION,
    READ_DOSSIER,
    { tool: "send_whatsapp", input: (context) => ({ recipientRole: "IMPORTER", kind: "ETA_CHANGE", template: { name: "legajo_nuevo_plazo", params: [field(context.calls, "get_operation", "operation", "operationNumber"), field(context.calls, "get_operation", "operation", "etaText"), field(context.calls, "get_dossier", "deadlines", "importer", "text")] } }) },
  ],
  note: "Avisé el nuevo plazo.",
};

const milestone = async (flow: Awaited<ReturnType<typeof worlds.open>>, name: string) => (await flow.data.timers.listTimers("op-4471", { kind: "MILESTONE" })).find((timer) => timer.timerId === name);

describe("ETA change flows", () => {
  it("[FL-061] CarrierEtaChanged 22/10 → 20/10 on op-4471: the pending milestones move by code (version + 1), META.eta and etaHistory change, and the ETA_CHANGED turn tells the importer (legajo_nuevo_plazo) and the supplier with an open request (send_email ETA_CHANGE)", async () => {
    const toSupplier = supplierEmail("ETA_CHANGE", (context) => `Hello,\n\nThe vessel for invoice ${field(context.calls, "get_operation", "operation", "invoiceNumber")} now arrives earlier. Please send the documents by ${field(context.calls, "get_dossier", "deadlines", "supplier", "text")}.\n\nThank you.`);
    const flow = await worlds.open({ "4471": { MILESTONE: [DOCS_REQUEST_PLAN], IMPORTER_MESSAGE: [DELEGATE_PLAN], ETA_CHANGED: [{ ...ETA_NOTICE, steps: [...ETA_NOTICE.steps, toSupplier] }] } });
    await flow.advance({ next: true });
    await flow.tap("op-4471", "SUPPLIER_SENDS");
    const arrivalBefore = await milestone(flow, "ARRIVAL");

    await flow.console().clock.moveEta({ operationId: "op-4471", eta: "2026-10-20T08:00:00-03:00" });
    await flow.entries.settle();

    expect(flow.platform.published.map((event) => event.detailType)).toEqual(["CarrierEtaChanged"]);
    const operation = await flow.data.operations.getOperation("op-4471");
    expect(Date.parse(operation.eta)).toBe(Date.parse("2026-10-20T08:00:00-03:00"));
    expect(operation.etaHistory?.length).toBeGreaterThan(0);
    const arrival = await milestone(flow, "ARRIVAL");
    expect(Date.parse(arrival?.dueAtSim ?? "")).toBe(Date.parse("2026-10-20T08:00:00-03:00"));
    expect(arrival?.version).toBe((arrivalBefore?.version ?? 0) + 1);
    for (const name of ["FOLLOWUP", "FOLLOWUP_FINAL", "ESCALATION"]) expect(Date.parse((await milestone(flow, name))?.dueAtSim ?? "")).toBeLessThan(Date.parse(arrival?.dueAtSim ?? ""));
    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "ETA_CHANGED");
    expect(turn?.calls[2]?.output).toMatchObject({ ok: true, templateUsed: "legajo_nuevo_plazo" });
    expect(turn?.calls[3]?.output).toMatchObject({ ok: true });
    expect((await flow.messages("op-4471")).filter((message) => message.kind === "ETA_CHANGE").map((message) => message.channel).sort()).toEqual(["EMAIL", "WHATSAPP"]);
  });

  it("[FL-062] CarrierEtaChanged 22/10 → 26/10: the milestones move later, the importer gets the new deadline, and no milestone fires twice", async () => {
    const flow = await worlds.open({ "4471": { ETA_CHANGED: [ETA_NOTICE], MILESTONE: [DOCS_REQUEST_PLAN] } });
    const docsBefore = await milestone(flow, "DOCS_REQUEST");

    await flow.console().clock.moveEta({ operationId: "op-4471", eta: "2026-10-26T08:00:00-03:00" });
    await flow.entries.settle();

    const arrival = await milestone(flow, "ARRIVAL");
    expect(Date.parse(arrival?.dueAtSim ?? "")).toBe(Date.parse("2026-10-26T08:00:00-03:00"));
    expect(Date.parse((await milestone(flow, "DOCS_REQUEST"))?.dueAtSim ?? "")).toBeGreaterThanOrEqual(Date.parse(docsBefore?.dueAtSim ?? ""));
    expect((await flow.messages("op-4471")).filter((message) => message.kind === "ETA_CHANGE")).toHaveLength(1);

    for (let move = 0; move < 3; move += 1) await flow.advance({ next: true });
    const fired = (await flow.data.audit.listByOperation("op-4471")).filter((row) => row.action === "MILESTONE_FIRED");
    const keys = fired.map((row) => (row.detail as { milestone?: string } | undefined)?.milestone ?? row.refs?.timerKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
