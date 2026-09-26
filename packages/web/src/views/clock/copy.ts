// Texts of the demo-clock view (docs/design-brief.md §6, "Reloj de demo"). Rioplatense Spanish; the
// shell's own clock texts (the bar, "Avanzar igual") stay in copy/console.ts and are reused from there.
import type { CustomsChannel, MilestoneName, TimerKind } from "@legajo/shared";

export const clockCopy = {
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
    onlyApprovers: "Solo un despachante o un jurado puede reiniciar la demo.",
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

export const MILESTONE_LABELS: Readonly<Record<MilestoneName, string>> = {
  DOCS_REQUEST: "Primer pedido (ETA − 7 días)",
  FOLLOWUP: "Seguimiento (ETA − 5 días)",
  FOLLOWUP_FINAL: "Último seguimiento (ETA − 3 días)",
  ESCALATION: "Escalamiento (ETA − 48 h)",
  ARRIVAL: "Arribo (ETA)",
};

export const TIMER_LABELS: Readonly<Record<TimerKind, string>> = {
  MILESTONE: "Hito",
  DEFERRED_SEND: "Envío diferido",
  FOLLOWUP_DUE: "Seguimiento agendado por el agente",
  SIM_REPLY: "Respuesta del proveedor simulado",
  READER_RETRY: "Reintento del lector documental",
  CONTACT_CHECK: "Control de contacto después de un rebote",
  BOUNCE_RETRY: "Reintento de un rebote transitorio",
};

/** Statuses the console can emit, as the customs platform would publish them. */
export type EmittableDispatch = "OFICIALIZADO" | `CANAL_ASIGNADO#${CustomsChannel}` | "LIBERADO";

export const DISPATCH_LABELS: Readonly<Record<EmittableDispatch, string>> = {
  OFICIALIZADO: "Oficializado",
  "CANAL_ASIGNADO#VERDE": "Canal asignado: verde",
  "CANAL_ASIGNADO#NARANJA": "Canal asignado: naranja",
  "CANAL_ASIGNADO#ROJO": "Canal asignado: rojo",
  LIBERADO: "Liberado",
};
