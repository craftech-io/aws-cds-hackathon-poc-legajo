// One action of the firm on the dossier at a time (a double click never sends twice): run it, then
// read the dossier again and ask the world clock right away, because most actions queue an event
// (a message to send, a turn of the agent) that keeps the world busy for a moment. "Avanzar hasta ahí"
// is one more: it moves the operation's world exactly to a pending (`clock.advanceTo`).
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { type Action, useAction } from "../../lib/use-remote";
import { type DossierAction, advanceClockTo, runDossierAction } from "./api";

export function useDossierAction(onDone: () => void): Action<DossierAction, true> {
  const { trpc } = useSession();
  const { refresh } = useWorldClock();
  return useAction(async (action: DossierAction) => {
    await runDossierAction(trpc, action);
    onDone();
    refresh();
    return true as const;
  });
}

export interface AdvanceTarget {
  readonly clockId: string;
  readonly toSim: string;
}

export function useAdvanceTo(onDone: () => void): Action<AdvanceTarget, true> {
  const { trpc } = useSession();
  const { refresh } = useWorldClock();
  return useAction(async ({ clockId, toSim }: AdvanceTarget) => {
    try {
      await advanceClockTo(trpc, clockId, toSim);
    } finally {
      // A refused move (`WORLD_BUSY`, a usage limit) still tells the shell to read the world again.
      refresh();
    }
    onDone();
    return true as const;
  });
}
