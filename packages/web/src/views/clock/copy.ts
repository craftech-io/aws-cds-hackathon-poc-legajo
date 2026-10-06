// Texts of the demo-clock view (docs/design-brief.md §6, "Reloj de demo"). Rioplatense Spanish; the
// shell's own clock texts (the bar, "Avanzar igual") stay in copy/console.ts and are reused from there.
// Spanish and English with the same shape; the console's language picks one at render time
// (copy/localized.ts).
import type { CustomsChannel, MilestoneName, TimerKind } from "@legajo/shared";
import { localized, type Widen } from "../../copy/localized";

const es = {
  now: {
    title: "Hora del mundo",
    description: "El reloj de demo está en pausa por defecto: la hora simulada solo se mueve con estos controles.",
    simNow: "Hora simulada",
    mode: "Modo",
    paused: "En pausa",
    running: (until: string | undefined) => (until === undefined ? "En vivo" : `En vivo hasta las ${until}`),
    start: "Inicio del mundo",
    epoch: "Época",
    epochHint: "Sube con cada reinicio y nunca vuelve atrás.",
  },
  move: {
    title: "Mover el tiempo",
    description: "Cada movimiento dispara en orden los temporizadores vencidos: hitos, envíos diferidos, respuestas del proveedor simulado y reintentos.",
    advanceTo: "Avanzar hasta",
    advanceToHint: "Hora de Argentina. El reloj nunca retrocede y avanza como mucho 14 días por vez.",
    advanceToSubmit: "Avanzar hasta esa hora",
    live: "Reloj en vivo (30 min)",
    liveHint: "Corre en tiempo real durante 30 minutos y vuelve solo a la pausa.",
    pause: "Pausar el reloj",
    invalidTarget: "Elegí una hora posterior a la hora simulada, dentro de los próximos 14 días.",
  },
  events: {
    title: "Próximos eventos",
    description: "Lo próximo que tiene que pasar en este mundo, de cualquier tipo.",
    empty: "No hay eventos programados en este mundo.",
    at: "Hora simulada",
    operation: "Operación",
    kind: "Qué pasa",
    reason: "Motivo",
    action: "Acción",
    goThere: "Avanzar hasta ahí",
    goThereLabel: (operationNumber: string, when: string) => `Avanzar hasta el evento de la operación ${operationNumber} de las ${when}`,
  },
  operation: {
    title: "Eventos de una operación",
    description: "Lo que en la realidad llega de afuera: el transportista mueve la ETA, la aduana informa el estado del despacho, o un hito se dispara antes de su hora.",
    select: "Operación",
    none: "El mundo no tiene operaciones.",
    optionLabel: (operationNumber: string, importer: string) => `${operationNumber} · ${importer}`,
    currentEta: (eta: string) => `ETA vigente: ${eta}`,
    etaTitle: "Mover la ETA (evento del transportista)",
    etaInput: "Nueva ETA",
    etaHint: "Hora de Argentina. Los hitos pendientes se reprograman desde la nueva ETA.",
    etaEarlier: "Adelantar 2 días",
    etaLater: "Atrasar 4 días",
    etaSubmit: "Mover la ETA",
    etaInvalid: "Elegí una ETA válida.",
    milestoneTitle: "Disparar un hito ahora",
    milestone: "Hito",
    milestoneSubmit: "Disparar ahora",
    dispatchTitle: "Emitir un estado de despacho (evento de la aduana)",
    dispatch: "Estado",
    dispatchSubmit: "Emitir estado",
    dispatchHint: "La plataforma lo publica al bus de eventos; el importador recibe la explicación genérica solo si el legajo está aprobado.",
  },
  reset: {
    title: "Reiniciar la demo de este mundo",
    description: "Vuelve el mundo a su plantilla: reloj en pausa al inicio, ETA de la plataforma restaurada, direcciones de operación nuevas y memoria del agente borrada. Ningún otro mundo cambia.",
    open: "Reiniciar demo",
    confirmTitle: "¿Reiniciar la demo de este mundo?",
    confirmLead: "Se pierde todo lo que pasó en este mundo desde su inicio. Se puede reiniciar una vez cada 10 minutos.",
    confirm: "Sí, reiniciar",
    cancel: "Cancelar",
    done: "Listo: el mundo volvió a su inicio.",
    onlyApprovers: "Solo un despachante o un invitado puede reiniciar la demo.",
    wait: (at: string) => `Ya se reinició hace poco: se puede volver a reiniciar a las ${at}.`,
  },
  gate: {
    busy: "Los controles se habilitan cuando termina lo que está en curso.",
    force: "El mundo sigue ocupado hace más de 5 minutos: estos controles avanzan igual, y la historia puede quedar desordenada.",
  },
  done: {
    moved: "Listo: el reloj se movió.",
    event: "Listo: el evento se emitió. El mundo queda ocupado hasta que termine de procesarse.",
    running: "Listo: el reloj corre en vivo.",
    paused: "Listo: el reloj quedó en pausa.",
  },
} as const;

export type ClockCopy = Widen<typeof es>;

const en = {
  now: {
    title: "World time",
    description: "The demo clock is paused by default: simulated time only moves with these controls.",
    simNow: "Simulated time",
    mode: "Mode",
    paused: "Paused",
    running: (until: string | undefined) => (until === undefined ? "Live" : `Live until ${until}`),
    start: "World start",
    epoch: "Epoch",
    epochHint: "Goes up with every reset and never goes back.",
  },
  move: {
    title: "Move time",
    description: "Every move fires the due timers in order: milestones, deferred sends, simulated supplier replies and retries.",
    advanceTo: "Advance to",
    advanceToHint: "Argentina time. The clock never goes back and advances at most 14 days at a time.",
    advanceToSubmit: "Advance to that time",
    live: "Live clock (30 min)",
    liveHint: "Runs in real time for 30 minutes and goes back to paused on its own.",
    pause: "Pause the clock",
    invalidTarget: "Pick a time after the simulated time, within the next 14 days.",
  },
  events: {
    title: "Next events",
    description: "What has to happen next in this world, of any kind.",
    empty: "There are no events scheduled in this world.",
    at: "Simulated time",
    operation: "Operation",
    kind: "What happens",
    reason: "Reason",
    action: "Action",
    goThere: "Advance to it",
    goThereLabel: (operationNumber: string, when: string) => `Advance to the event of operation ${operationNumber} at ${when}`,
  },
  operation: {
    title: "Events of an operation",
    description: "What in real life comes from outside: the carrier moves the ETA, customs reports the clearance status, or a milestone fires before its time.",
    select: "Operation",
    none: "The world has no operations.",
    optionLabel: (operationNumber: string, importer: string) => `${operationNumber} · ${importer}`,
    currentEta: (eta: string) => `Current ETA: ${eta}`,
    etaTitle: "Move the ETA (carrier event)",
    etaInput: "New ETA",
    etaHint: "Argentina time. Pending milestones are rescheduled from the new ETA.",
    etaEarlier: "Bring forward 2 days",
    etaLater: "Delay 4 days",
    etaSubmit: "Move the ETA",
    etaInvalid: "Pick a valid ETA.",
    milestoneTitle: "Fire a milestone now",
    milestone: "Milestone",
    milestoneSubmit: "Fire now",
    dispatchTitle: "Emit a clearance status (customs event)",
    dispatch: "Status",
    dispatchSubmit: "Emit status",
    dispatchHint: "The platform publishes it to the event bus; the importer gets the generic explanation only if the dossier is approved.",
  },
  reset: {
    title: "Reset this world's demo",
    description: "Takes the world back to its template: clock paused at the start, the platform's ETA restored, new operation addresses and the agent's memory cleared. No other world changes.",
    open: "Reset demo",
    confirmTitle: "Reset this world's demo?",
    confirmLead: "Everything that happened in this world since its start is lost. You can reset once every 10 minutes.",
    confirm: "Yes, reset",
    cancel: "Cancel",
    done: "Done: the world is back at its start.",
    onlyApprovers: "Only a broker or a guest can reset the demo.",
    wait: (at: string) => `It was reset recently: you can reset it again at ${at}.`,
  },
  gate: {
    busy: "The controls turn on when what is in progress finishes.",
    force: "The world has been busy for more than 5 minutes: these controls advance anyway, and the story may end up out of order.",
  },
  done: {
    moved: "Done: the clock moved.",
    event: "Done: the event was emitted. The world stays busy until it finishes processing.",
    running: "Done: the clock is running live.",
    paused: "Done: the clock is paused.",
  },
} satisfies ClockCopy;

export const clockCopy: ClockCopy = localized({ es, en });

const milestoneEs = {
  DOCS_REQUEST: "Primer pedido (ETA − 7 días)",
  FOLLOWUP: "Seguimiento (ETA − 5 días)",
  FOLLOWUP_FINAL: "Último seguimiento (ETA − 3 días)",
  ESCALATION: "Escalamiento (ETA − 48 h)",
  ARRIVAL: "Arribo (ETA)",
} satisfies Record<MilestoneName, string>;

export const MILESTONE_LABELS: Readonly<Record<MilestoneName, string>> = localized({
  es: milestoneEs,
  en: {
    DOCS_REQUEST: "First request (ETA − 7 days)",
    FOLLOWUP: "Follow-up (ETA − 5 days)",
    FOLLOWUP_FINAL: "Last follow-up (ETA − 3 days)",
    ESCALATION: "Escalation (ETA − 48 h)",
    ARRIVAL: "Arrival (ETA)",
  } satisfies Widen<typeof milestoneEs>,
});

const timerEs = {
  MILESTONE: "Hito",
  DEFERRED_SEND: "Envío diferido",
  FOLLOWUP_DUE: "Seguimiento agendado por el agente",
  SIM_REPLY: "Respuesta del proveedor simulado",
  READER_RETRY: "Reintento del lector documental",
  CONTACT_CHECK: "Control de contacto después de un rebote",
  BOUNCE_RETRY: "Reintento de un rebote transitorio",
} satisfies Record<TimerKind, string>;

export const TIMER_LABELS: Readonly<Record<TimerKind, string>> = localized({
  es: timerEs,
  en: {
    MILESTONE: "Milestone",
    DEFERRED_SEND: "Deferred send",
    FOLLOWUP_DUE: "Follow-up scheduled by the agent",
    SIM_REPLY: "Simulated supplier reply",
    READER_RETRY: "Document reader retry",
    CONTACT_CHECK: "Contact check after a bounce",
    BOUNCE_RETRY: "Retry after a transient bounce",
  } satisfies Widen<typeof timerEs>,
});

/** Statuses the console can emit, as the customs platform would publish them. */
export type EmittableDispatch = "OFICIALIZADO" | `CANAL_ASIGNADO#${CustomsChannel}` | "LIBERADO";

const dispatchEs = {
  OFICIALIZADO: "Oficializado",
  "CANAL_ASIGNADO#VERDE": "Canal asignado: verde",
  "CANAL_ASIGNADO#NARANJA": "Canal asignado: naranja",
  "CANAL_ASIGNADO#ROJO": "Canal asignado: rojo",
  LIBERADO: "Liberado",
} satisfies Record<EmittableDispatch, string>;

export const DISPATCH_LABELS: Readonly<Record<EmittableDispatch, string>> = localized({
  es: dispatchEs,
  en: {
    OFICIALIZADO: "Officialized",
    "CANAL_ASIGNADO#VERDE": "Channel assigned: green",
    "CANAL_ASIGNADO#NARANJA": "Channel assigned: orange",
    "CANAL_ASIGNADO#ROJO": "Channel assigned: red",
    LIBERADO: "Released",
  } satisfies Widen<typeof dispatchEs>,
});
