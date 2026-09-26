// One clock command at a time from a view (the clock view and the guided tour): runs it through
// clock-api.ts, keeps its outcome for the view to show, and asks the shell's world clock again when it
// ends, so the bar, the busy gate and every live view follow the move right away.
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { type Action, useAction } from "../../lib/use-remote";
import { type ClockCommand, type ClockDetail, runClockCommand } from "./clock-api";

export interface CommandRequest {
  readonly command: ClockCommand;
  /** "Avanzar igual": only once the world has been busy for five real minutes. */
  readonly force?: boolean;
}

export function useClockCommand(): Action<CommandRequest, ClockDetail | undefined> {
  const { trpc } = useSession();
  const { refresh } = useWorldClock();
  return useAction(async ({ command, force = false }: CommandRequest) => {
    try {
      return await runClockCommand(trpc, command, force);
    } finally {
      refresh();
    }
  });
}
