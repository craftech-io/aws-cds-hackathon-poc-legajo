// What a button of the tour calls: the console's own procedures, never a shortcut. Clock moves go
// through the clock view's commands and the shell's "Avanzar al próximo evento"; the ETA move reads
// the current ETA of 4471 from `operations.list`; approving calls `dossier.approve`, which asks for a
// recent sign-in (the panel shows the password prompt when the BFF says so). Opening a view is
// navigation and never reaches here.
import { OperationId } from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import { moveClock } from "../../lib/console-api";
import type { ConsoleClient } from "../../lib/trpc";
import { runClockCommand } from "../clock/clock-api";
import { shiftEta } from "../clock/clock-model";
import { TOUR_OPERATION_NUMBER, type TourAction } from "./steps";

export interface TourOperation {
  readonly operationId: string;
  readonly eta: string;
}

/** Operation 4471 of the user's world (its id differs between worlds; its number does not). */
export async function findTourOperation(trpc: ConsoleClient): Promise<TourOperation | undefined> {
  const { operations } = await trpc.operations.list.query({});
  const found = operations.find((operation) => operation.operationNumber === TOUR_OPERATION_NUMBER);
  return found === undefined ? undefined : { operationId: found.operationId, eta: found.eta };
}

export class TourOperationMissing extends Error {
  constructor() {
    super(`operation ${TOUR_OPERATION_NUMBER} is not in this world`);
    this.name = "TourOperationMissing";
  }
}

async function requireOperation(trpc: ConsoleClient): Promise<TourOperation> {
  const operation = await findTourOperation(trpc);
  if (operation === undefined) throw new TourOperationMissing();
  return operation;
}

export async function runTourAction(trpc: ConsoleClient, action: Exclude<TourAction, { kind: "open" }>): Promise<void> {
  switch (action.kind) {
    case "advanceTo":
      await runClockCommand(trpc, { kind: "advanceTo", toSim: action.toSim });
      return;
    case "advanceToNext":
      await moveClock(trpc, { kind: "next" });
      return;
    case "moveEta": {
      const operation = await requireOperation(trpc);
      await runClockCommand(trpc, { kind: "moveEta", operationId: operation.operationId, eta: shiftEta(operation.eta, action.shiftDays) });
      return;
    }
    case "approve": {
      const operation = await requireOperation(trpc);
      await getUntypedClient(trpc).mutation("dossier.approve", { operationId: OperationId.parse(operation.operationId) });
      return;
    }
    case "emitDispatchStatus": {
      const operation = await requireOperation(trpc);
      const channel = action.status === "CANAL_ASIGNADO" ? { channel: action.channel } : {};
      await runClockCommand(trpc, { kind: "emitDispatchStatus", operationId: operation.operationId, status: action.status, ...channel });
      return;
    }
  }
}
