// Live state of the user's world for every authenticated view: the demo clock (`clock.get`), asked
// again every 3 s while something is in flight or the clock runs live and every 15 s when the world
// is quiet (docs/architecture.md §10), plus the moves of the clock from the shell. Each answer bumps
// `tick`; `useLiveRemote` re-runs a view's query on it, so the whole console follows the world at
// the same cadence without a state library. A hidden tab stops asking until it is visible again.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type ApiError, isAbortError, toApiError } from "../lib/api-error";
import { fetchClock, moveClock } from "../lib/console-api";
import { type Remote, useRemote } from "../lib/use-remote";
import { type ClockMove, type ClockSnapshot, POLL_IDLE_MS, pollDelayMs } from "../lib/world-clock";
import { useSession } from "./SessionContext";

export interface WorldClockValue {
  /** Last answer of `clock.get`; undefined until the first one arrives. */
  readonly snapshot: ClockSnapshot | undefined;
  /** Why the last poll failed; the last snapshot stays on screen meanwhile. */
  readonly error: ApiError | undefined;
  /** Bumps on every answer: the heartbeat the views refresh on. */
  readonly tick: number;
  readonly moving: boolean;
  readonly moveError: ApiError | undefined;
  /** Asks again now (after an action that changed the world). */
  refresh(): void;
  /** Moves the clock; `force` only once the shell offers "Avanzar igual". */
  move(move: ClockMove, force?: boolean): Promise<void>;
}

const WorldClockContext = createContext<WorldClockValue | undefined>(undefined);

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function WorldClockProvider({ children }: { readonly children: ReactNode }) {
  const { trpc, expireSession } = useSession();
  const [snapshot, setSnapshot] = useState<ClockSnapshot | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [round, setRound] = useState(0);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<ApiError | undefined>(undefined);
  const last = useRef<ClockSnapshot | undefined>(undefined);
  const movingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let inFlight = false;

    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), delay);
    };

    async function poll(): Promise<void> {
      if (inFlight || controller.signal.aborted) return;
      if (isHidden()) {
        schedule(POLL_IDLE_MS);
        return;
      }
      inFlight = true;
      try {
        const next = await fetchClock(trpc, controller.signal);
        if (controller.signal.aborted) return;
        last.current = next;
        setSnapshot(next);
        setError(undefined);
        setTick((value) => value + 1);
        schedule(pollDelayMs(next));
      } catch (failure) {
        if (controller.signal.aborted || isAbortError(failure)) return;
        const apiError = toApiError(failure);
        // The BFF refused the token: the session is over, the login takes it from here.
        if (apiError.kind === "unauthorized") {
          expireSession();
          return;
        }
        setError(apiError);
        schedule(pollDelayMs(last.current));
      } finally {
        inFlight = false;
      }
    }

    const onVisibility = () => {
      if (!isHidden()) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [trpc, expireSession, round]);

  const refresh = useCallback(() => setRound((value) => value + 1), []);

  const move = useCallback(
    async (clockMove: ClockMove, force = false) => {
      if (movingRef.current) return;
      movingRef.current = true;
      setMoving(true);
      setMoveError(undefined);
      try {
        const next = await moveClock(trpc, clockMove, force);
        if (next) {
          last.current = next;
          setSnapshot(next);
        }
      } catch (failure) {
        const apiError = toApiError(failure);
        if (apiError.kind === "unauthorized") expireSession();
        else setMoveError(apiError);
      } finally {
        movingRef.current = false;
        setMoving(false);
        refresh();
      }
    },
    [trpc, expireSession, refresh],
  );

  const value = useMemo<WorldClockValue>(
    () => ({ snapshot, error, tick, moving, moveError, refresh, move }),
    [snapshot, error, tick, moving, moveError, refresh, move],
  );
  return <WorldClockContext.Provider value={value}>{children}</WorldClockContext.Provider>;
}

export function useWorldClock(): WorldClockValue {
  const value = useContext(WorldClockContext);
  if (!value) throw new Error("useWorldClock must be used inside WorldClockProvider");
  return value;
}

/**
 * `useRemote` that follows the world: the query runs again, quietly, on every answer of the clock
 * (every 3 s while something is in flight, every 15 s at rest).
 */
export function useLiveRemote<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Remote<T> {
  const remote = useRemote(key, load);
  const { tick } = useWorldClock();
  const seen = useRef(tick);
  const { refresh } = remote;
  useEffect(() => {
    if (tick === seen.current) return;
    seen.current = tick;
    refresh();
  }, [tick, refresh]);
  return remote;
}
