// The guided tour over the in-process world (scripts/tour/timeline.ts `TourWorld`): the reserved guest
// world `firm-guest-01` built by the real factory from the seed's `guest` template, the console as its
// guest sees it (the real `clock.*`, `dossier.approve` and simulator procedures), and the agent of the
// story of 4471 (docs/design-brief.md §15) scripted turn by turn. A move answers the timers of the world
// that fired while it ran: the ones that left `SCHEDULED` between the clock before and after it.
import { cognitoSubKey, brokerKey } from "@legajo/bff/connector/keys";
import { SUBS, principalOf } from "@legajo/bff/routers/testing";
import type { TimerKind, WaButtonAction } from "@legajo/shared";
import { createWorld } from "@legajo/bff/worlds/factory";
import { type TourAction, TOUR_OPERATION_NUMBER } from "../../../packages/web/src/views/tour/steps";
import type { TourClockView, TourTimer, TourWorld } from "../../../scripts/tour/timeline";
import { CONTACT_CONFIRMATION, DOCS_REQUEST_PLAN, EMAIL_DOCS_REQUEST, READ_DOSSIER, READ_OPERATION, READ_SUPPLIER, assign, correctionEmail, noActionNeeded, reply } from "./plans";
import { type Plan, type PlanSource, plansByOperation } from "./scripted-harness";
import type { FlowWorld } from "./world";

export const TOUR_FIRM = "firm-guest-01";
export const TOUR_CLOCK = `GUEST#${TOUR_FIRM}`;
/** The guest who walks the tour, bound to the reserved world's broker row. */
export const TOUR_GUEST = principalOf(TOUR_FIRM, "GUEST", SUBS.guest, "brk-guest-01");

const isComplete = (calls: Parameters<NonNullable<Plan["steps"][number]["when"]>>[0]["calls"]) => (calls.find((call) => call.tool === "get_dossier")?.output as { complete?: boolean } | undefined)?.complete === true;
const hasObservation = (calls: Parameters<NonNullable<Plan["steps"][number]["when"]>>[0]["calls"]) => JSON.stringify(calls.find((call) => call.tool === "get_dossier")?.output ?? {}).includes('"status":"OPEN"');

/** The agent of the story: request, contact confirmation, first email, correction, approval request. */
export const TOUR_AGENT: PlanSource = plansByOperation({
  [TOUR_OPERATION_NUMBER]: {
    MILESTONE: [DOCS_REQUEST_PLAN],
    IMPORTER_MESSAGE: [{ steps: [READ_SUPPLIER, CONTACT_CONFIRMATION], note: "Pedí confirmar el contacto." }],
    CONTACT_CONFIRMED: [{ steps: [READ_OPERATION, READ_DOSSIER, EMAIL_DOCS_REQUEST, reply("REPLY", "Le escribimos al proveedor a primera hora de Qingdao.")], note: "Pedí al proveedor." }],
    SUPPLIER_EMAIL: [
      { steps: [READ_OPERATION, READ_DOSSIER, { ...assign("PACKING_LIST", "SUPPLIER"), when: (context) => hasObservation(context.calls) }, { ...correctionEmail("PACKING_LIST", "packing list"), when: (context) => hasObservation(context.calls) }, { ...noActionNeeded("PACKING_LIST"), when: (context) => hasObservation(context.calls) }], note: "Pedí la corrección." },
      { steps: [READ_DOSSIER, { tool: "request_approval", input: { summary: "El proveedor corrigió el packing list; los tres documentos están válidos." }, when: (context) => isComplete(context.calls) }, reply("REPLY", "Llegaron todos los documentos; el estudio los revisa.")], note: "Legajo completo." },
    ],
  },
});

async function pendingOf(flow: FlowWorld): Promise<TourTimer[]> {
  const timers: TourTimer[] = [];
  for (const operation of await flow.data.operations.listOperations(TOUR_FIRM, { clockId: TOUR_CLOCK })) {
    for (const timer of await flow.data.timers.listTimers(operation.operationId, { status: "SCHEDULED" })) timers.push({ operationNumber: operation.operationNumber, kind: timer.kind as TimerKind, dueAtSim: timer.dueAtSim });
  }
  return timers;
}

/** The reserved world of the tour and its guest's broker row bound to the guest's `sub`. */
export async function tourWorld(flow: FlowWorld): Promise<TourWorld> {
  await createWorld({ kind: "GUEST", firmId: TOUR_FIRM }, flow.worlds);
  const at = flow.realNow().toISOString();
  await flow.stores.client.update("Firms", brokerKey(TOUR_FIRM, "brk-guest-01"), { set: { cognitoSub: SUBS.guest, cognitoSubKey: cognitoSubKey(SUBS.guest), role: "GUEST", active: true } }, at, { condition: { ifExists: true } });
  const tour = (await flow.worlds.templates.read("guest")).tour;
  if (tour === undefined) throw new Error("the guest template declares no tour");
  const console = () => flow.console(TOUR_GUEST);
  const operationId = async () => (await flow.data.operations.listOperations(TOUR_FIRM, { clockId: TOUR_CLOCK })).find((operation) => operation.operationNumber === TOUR_OPERATION_NUMBER)?.operationId ?? "";

  async function firedBy(run: () => Promise<unknown>): Promise<TourTimer[]> {
    const before = await pendingOf(flow);
    await run();
    await flow.entries.settle();
    const after = await pendingOf(flow);
    const still = new Set(after.map((timer) => `${timer.operationNumber}:${timer.kind}:${Date.parse(timer.dueAtSim)}`));
    return before.filter((timer) => !still.has(`${timer.operationNumber}:${timer.kind}:${Date.parse(timer.dueAtSim)}`));
  }

  async function act(action: TourAction): Promise<void> {
    const operation = await operationId();
    switch (action.kind) {
      case "open":
        return;
      case "advanceTo":
        await console().clock.advanceTo({ clockId: TOUR_CLOCK, toSim: action.toSim });
        return;
      case "advanceToNext":
        await console().clock.advanceToNext({ clockId: TOUR_CLOCK });
        return;
      case "moveEta": {
        const current = await flow.data.operations.getOperation(operation);
        await console().clock.moveEta({ operationId: operation, eta: new Date(Date.parse(current.eta) + action.shiftDays * 86_400_000).toISOString() });
        return;
      }
      case "approve":
        await console().dossier.approve({ operationId: operation });
        return;
      case "emitDispatchStatus":
        await console().clock.emitDispatchStatus({ operationId: operation, ...(action.status === "CANAL_ASIGNADO" ? { status: action.status, channel: action.channel } : { status: action.status }) });
        return;
    }
  }

  return {
    window: { operationNumber: tour.operationNumber, windowStartSim: tour.windowStartSim, windowEndSim: tour.windowEndSim },
    async clock(): Promise<TourClockView> {
      const clock = await flow.data.world.getClock(TOUR_CLOCK);
      return { simNow: (await flow.simNow(TOUR_CLOCK)).toISOString(), startAtSim: clock.startAtSim, pending: await pendingOf(flow) };
    },
    perform: (action) => firedBy(() => act(action)),
    tap: (action: WaButtonAction) => firedBy(async () => flow.tap(await operationId(), action)),
  };
}
