// Firm-level state shared by every view: the firm comes from the JWT (`firmId`, never from input),
// its name and the guest's other-session notice from `account.session` (asked once per sign-in; for
// a guest the first one also creates its world, ~10 s), and the ETA range that filters the
// operations. Views read it through `useFirm`.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { type AccountSession, fetchAccountSession } from "../lib/console-api";
import { type RemoteState, useRemote } from "../lib/use-remote";
import { useSession } from "./SessionContext";

/** Calendar dates (`YYYY-MM-DD`) of the ETA filter; an open end is unbounded. */
export interface EtaRange {
  readonly from?: string;
  readonly to?: string;
}

export interface FirmValue {
  readonly firmId: string;
  /** The firm's name once `account.session` answered ("Estudio Delta"). */
  readonly firmName: string | undefined;
  readonly account: RemoteState<AccountSession>;
  reloadAccount(): void;
  readonly etaRange: EtaRange;
  setEtaRange(range: EtaRange): void;
}

const FirmContext = createContext<FirmValue | undefined>(undefined);

interface FirmProviderProps {
  readonly firmId: string;
  readonly children: ReactNode;
}

export function FirmProvider({ firmId, children }: FirmProviderProps) {
  const { trpc, state } = useSession();
  // One ask per sign-in: a new token set of another person (or a step-up) is a new key.
  const sub = state.status === "authenticated" ? state.principal.sub : "";
  const { state: account, reload: reloadAccount } = useRemote(`account.session:${firmId}:${sub}`, (signal) => fetchAccountSession(trpc, signal));
  const [etaRange, setEtaRange] = useState<EtaRange>({});
  const firmName = account.status === "ready" ? (account.data.firm?.name ?? undefined) : undefined;
  const value = useMemo<FirmValue>(
    () => ({ firmId, firmName, account, reloadAccount, etaRange, setEtaRange }),
    [firmId, firmName, account, reloadAccount, etaRange],
  );
  return <FirmContext.Provider value={value}>{children}</FirmContext.Provider>;
}

export function useFirm(): FirmValue {
  const value = useContext(FirmContext);
  if (!value) throw new Error("useFirm must be used inside FirmProvider");
  return value;
}
