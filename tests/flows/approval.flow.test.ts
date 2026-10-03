// Local flows after the human approval (docs/flows-catalog.md, area I): the console injects customs
// statuses through the platform mock in process ("Emitir estado de despacho"), the platform publishes
// them on `Feeds`, and `notify_dispatch_status` tells the importer of the approved dossier with a fixed
// template and the glossary's generic explanation; the release closes the operation.
import { describe, expect, it } from "vitest";
import { useFlowWorld } from "./support/lifecycle";

const worlds = useFlowWorld();

describe("approval and dispatch flows", () => {
  it("[FL-077] OFICIALIZADO → CANAL_ASIGNADO NARANJA → LIBERADO on op-4487 (approved): three DISPATCH_STATUS with despacho_estado and the generic explanation, META.dispatch follows, LIBERADO closes the operation and cancels its timers", async () => {
    const flow = await worlds.open({});
    const caller = flow.console();

    await caller.clock.emitDispatchStatus({ operationId: "op-4487", status: "OFICIALIZADO" });
    await flow.entries.settle();
    await caller.clock.emitDispatchStatus({ operationId: "op-4487", status: "CANAL_ASIGNADO", channel: "NARANJA" });
    await flow.entries.settle();
    expect((await flow.data.operations.getOperation("op-4487")).dispatch).toMatchObject({ status: "CANAL_ASIGNADO", channel: "NARANJA" });
    await caller.clock.emitDispatchStatus({ operationId: "op-4487", status: "LIBERADO" });
    await flow.entries.settle();

    const notices = (await flow.messages("op-4487")).filter((message) => message.kind === "DISPATCH_STATUS");
    expect(notices).toHaveLength(3);
    expect(notices.every((message) => message.template?.name === "despacho_estado" && message.author === "SYSTEM")).toBe(true);
    const glossary = await flow.data.reference.getDispatchGlossary("CANAL_ASIGNADO", "NARANJA");
    expect(glossary?.text).toBeDefined();
    expect(notices.some((message) => message.template?.params?.includes(glossary?.text ?? "") === true)).toBe(true);
    const operation = await flow.data.operations.getOperation("op-4487");
    expect(operation.dispatch.status).toBe("LIBERADO");
    expect(operation.dossierStatus).toBe("APPROVED");
    expect((await flow.data.timers.listTimers("op-4487")).filter((timer) => timer.status === "SCHEDULED")).toEqual([]);
    const allowed = (await flow.data.audit.listByOperation("op-4487")).filter((row) => row.action === "SEND_WHATSAPP" && row.decision === "ALLOW").slice(-3);
    expect(allowed.every((row) => (row.ruleIds ?? []).includes("CP-APPROVED-SCOPE"))).toBe(true);
    expect(flow.harness.turns).toEqual([]);
  });
});
