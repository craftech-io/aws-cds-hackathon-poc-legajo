// Generic explanation of each customs dispatch status (`Reference/DISPATCH_GLOSSARY`, docs/seed-spec.md
// §12). It fills `{{2}}` and `{{3}}` of `despacho_estado` and is what `get_dispatch_status` returns as
// `genericExplanation`: it says what a status means, never what to do (no advice, docs/design-brief.md §11).
import type { CustomsChannel, DispatchStatus } from "@legajo/shared";

export const DISPATCH_GLOSSARY_KEYS = [
  "OFICIALIZADO",
  "CANAL_ASIGNADO#VERDE",
  "CANAL_ASIGNADO#NARANJA",
  "CANAL_ASIGNADO#ROJO",
  "LIBERADO",
] as const;
export type DispatchGlossaryKey = (typeof DISPATCH_GLOSSARY_KEYS)[number];

export interface DispatchGlossaryEntry {
  /** `{{2}}` of `despacho_estado`, without a final period. */
  readonly statusText: string;
  /** `{{3}}`: one generic sentence, closed with a period. */
  readonly explanation: string;
}

export const DISPATCH_GLOSSARY: Readonly<Record<DispatchGlossaryKey, DispatchGlossaryEntry>> = {
  OFICIALIZADO: {
    statusText: "el despacho quedó oficializado",
    explanation: "Significa que la aduana registró la declaración y el trámite empezó a correr.",
  },
  "CANAL_ASIGNADO#VERDE": {
    statusText: "la aduana asignó canal verde",
    explanation: "Significa que la aduana no va a revisar la documentación ni la mercadería antes de liberarla.",
  },
  "CANAL_ASIGNADO#NARANJA": {
    statusText: "la aduana asignó canal naranja",
    explanation: "Significa que la aduana va a revisar la documentación antes de liberar la mercadería.",
  },
  "CANAL_ASIGNADO#ROJO": {
    statusText: "la aduana asignó canal rojo",
    explanation: "Significa que la aduana va a revisar la documentación y la mercadería antes de liberarla.",
  },
  LIBERADO: {
    statusText: "la mercadería quedó liberada",
    explanation: "Significa que la aduana terminó el trámite de esta operación.",
  },
};

/** Key of a customs event; `CANAL_ASIGNADO` without a channel, or `NONE`, has no entry. */
export function dispatchGlossaryKey(status: DispatchStatus, channel?: CustomsChannel): DispatchGlossaryKey | undefined {
  if (status === "CANAL_ASIGNADO") return channel ? `CANAL_ASIGNADO#${channel}` : undefined;
  return status === "NONE" ? undefined : status;
}
