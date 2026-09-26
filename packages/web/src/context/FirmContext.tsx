// Firm-level state shared by every view: the firm comes from the JWT (`firmId`) and the ETA range
// that filters the operations list. The firm's name and settings arrive with the BFF routers
// (WP-33); views read them through `useFirm`.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface EtaRange {
  readonly from?: string;
  readonly to?: string;
}

export interface FirmValue {
  readonly firmId: string;
  readonly etaRange: EtaRange;
  setEtaRange(range: EtaRange): void;
}

const FirmContext = createContext<FirmValue | undefined>(undefined);

interface FirmProviderProps {
  readonly firmId: string;
  readonly children: ReactNode;
}

export function FirmProvider({ firmId, children }: FirmProviderProps) {
  const [etaRange, setEtaRange] = useState<EtaRange>({});
  const value = useMemo<FirmValue>(() => ({ firmId, etaRange, setEtaRange }), [firmId, etaRange]);
  return <FirmContext.Provider value={value}>{children}</FirmContext.Provider>;
}

export function useFirm(): FirmValue {
  const value = useContext(FirmContext);
  if (!value) throw new Error("useFirm must be used inside FirmProvider");
  return value;
}
