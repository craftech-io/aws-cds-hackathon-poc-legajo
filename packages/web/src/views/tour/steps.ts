// The guest's guided tour (docs/design-brief.md §15), single source of three things: the "Recorrido
// guiado" panel of the console (es/en), the "Test instructions" of the README (English, written by
// `npm run tour:check -- --write` between its markers) and the steps of `SC-24` (scripts/scenarios),
// which imports this module. `npm run tour:check` fails when the README or SC-24 drift from it, and
// scripts/tour/timeline.test.ts walks these steps over the `guest` template to prove the expected
// hours below are the real ones.
//
// The tour follows the story of operation 4471 and the video: the request at 15/10 10:00, the email
// deferred to 15/10 22:00 (16/10 09:00 in Qingdao), the supplier's replies at 22:10 and 22:20 and the
// two deferred notices to the importer at 16/10 09:00, the end of its window. The hours of "Qué mirar"
// are placeholders: the panel fills them from the pending timers of 4471 that `clock.get` returns,
// and the README from the expected values declared here. Pure data and pure functions (no DOM): the
// script and the tests import it in Node.
import type { CustomsChannel, MessageKind, TimerKind } from "@legajo/shared";
import { formatTime, wallClockOf } from "../../lib/format";

export const TOUR_OPERATION_NUMBER = "4471";

/** Simulated window of the tour in the `guest` template (docs/seed-spec.md §3, invariant 21). */
export const TOUR_WINDOW = { startSim: "2026-10-14T10:30:00-03:00", endSim: "2026-10-16T09:00:00-03:00" } as const;

export const AR_ZONE = "America/Argentina/Buenos_Aires";
export const QINGDAO_ZONE = "Asia/Shanghai";

export type TourLang = "es" | "en";

export interface Bilingual {
  readonly es: string;
  readonly en: string;
}

/** Views the tour points at (route ids of the console). */
export type TourView = "operations" | "dossier" | "simulator" | "mailbox" | "clock" | "metrics";

export type DispatchEmit = { readonly status: "OFICIALIZADO" | "LIBERADO" } | { readonly status: "CANAL_ASIGNADO"; readonly channel: CustomsChannel };

/** What a button of the tour does; every action calls a procedure the console already has. */
export type TourAction =
  | { readonly kind: "open"; readonly view: TourView }
  | { readonly kind: "advanceTo"; readonly toSim: string }
  | { readonly kind: "advanceToNext" }
  | { readonly kind: "moveEta"; readonly shiftDays: number }
  | { readonly kind: "approve" }
  | ({ readonly kind: "emitDispatchStatus" } & DispatchEmit);

export interface TourMove {
  readonly action: TourAction;
  readonly label: Bilingual;
  /** Simulated hour the world reaches after a clock move, on an event of 4471 of this kind. */
  readonly expect?: { readonly simNow: string; readonly timer: TimerKind };
}

/** A time of "Qué mirar": the next pending timer of 4471 of this kind, shown in `zone`. */
export interface TourTime {
  readonly timer: TimerKind | "WORLD_START";
  readonly expectedSim: string;
  readonly zone: string;
}

export const TOUR_STEP_IDS = ["sign-in", "first-request", "delegate", "email", "reply", "correction", "eta", "approve", "dispatch", "metrics"] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];

export interface TourStep {
  readonly id: TourStepId;
  readonly number: number;
  readonly title: Bilingual;
  readonly moves: readonly TourMove[];
  /** "Qué mirar", with `{name}` placeholders declared in `times`. */
  readonly look: Bilingual;
  readonly times: Readonly<Record<string, TourTime>>;
  readonly wait: Bilingual;
  /** Longest real wait the step may take, for the scenario's timeouts (docs/test-plan.md §4.3). */
  readonly waitSec: number;
  readonly view: TourView;
  /** The Spanish message whose English gloss the panel shows (read from the simulator's thread). */
  readonly glossOf?: MessageKind;
}

const at = (simNow: string, timer: TimerKind) => ({ simNow, timer });
const advanceNext = (simNow: string, timer: TimerKind): TourMove => ({
  action: { kind: "advanceToNext" },
  label: { es: "Avanzar al próximo evento", en: "Advance to the next event" },
  expect: at(simNow, timer),
});
const deferred = (expectedSim: string, zone = AR_ZONE): TourTime => ({ timer: "DEFERRED_SEND", expectedSim, zone });

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "sign-in",
    number: 1,
    title: { es: "Ingresar", en: "Sign in" },
    moves: [{ action: { kind: "open", view: "operations" }, label: { es: "Ver operaciones", en: "Open operations" } }],
    look: {
      es: "Tu mundo propio con el reloj en pausa el {start} y la operación 4471 fijada arriba como Historia principal.",
      en: "Your own world with the clock paused at {start} and operation 4471 pinned at the top as the main story.",
    },
    times: { start: { timer: "WORLD_START", expectedSim: TOUR_WINDOW.startSim, zone: AR_ZONE } },
    wait: { es: "Primer ingreso: ~10 s (se crea el mundo)", en: "First sign-in: ~10 s (your world is created)" },
    waitSec: 30,
    view: "operations",
  },
  {
    id: "first-request",
    number: 2,
    title: { es: "Primer pedido", en: "First request" },
    moves: [
      {
        action: { kind: "advanceTo", toSim: "2026-10-15T10:00:00-03:00" },
        label: { es: "Ir al pedido de la 4471 (15/10 10:00)", en: "Go to the 4471 request (Oct 15 10:00)" },
        expect: at("2026-10-15T10:00:00-03:00", "MILESTONE"),
      },
    ],
    look: {
      es: "Simulador de teléfono: la plantilla de documentos pendientes con 4 botones; el hito ETA − 7 días se disparó por su hora.",
      en: "Phone simulator: the pending-documents template with 4 buttons; the ETA − 7 days milestone fired at its own hour.",
    },
    times: {},
    wait: { es: "~1 min (turno del agente)", en: "~1 min (agent turn)" },
    waitSec: 180,
    view: "simulator",
    glossOf: "DOCS_REQUEST",
  },
  {
    id: "delegate",
    number: 3,
    title: { es: "Delegar al proveedor", en: "Hand over to the supplier" },
    moves: [{ action: { kind: "open", view: "simulator" }, label: { es: "Abrir el simulador", en: "Open the simulator" } }],
    look: {
      es: "Tocá “Los manda el proveedor” y después “Sí, escribile”. En el detalle de la 4471, el email queda diferido por el horario de Qingdao hasta las {deferredSend} ({deferredSendQingdao} en Qingdao).",
      en: "Tap “Los manda el proveedor” (the supplier sends them), then “Sí, escribile” (yes, write to them). In the 4471 dossier the email is deferred by Qingdao business hours until {deferredSend} ({deferredSendQingdao} in Qingdao).",
    },
    times: { deferredSend: deferred("2026-10-15T22:00:00-03:00"), deferredSendQingdao: deferred("2026-10-15T22:00:00-03:00", QINGDAO_ZONE) },
    wait: { es: "~1 min por botón (turno)", en: "~1 min per button (agent turn)" },
    waitSec: 180,
    view: "simulator",
    glossOf: "CONTACT_CONFIRMATION",
  },
  {
    id: "email",
    number: 4,
    title: { es: "Email en inglés", en: "Email in English" },
    moves: [advanceNext("2026-10-15T22:00:00-03:00", "DEFERRED_SEND")],
    look: {
      es: "Buzón de demo: el email en inglés al proveedor, desde la dirección de la operación 4471.",
      en: "Demo mailbox: the email in English to the supplier, from the address of operation 4471.",
    },
    times: {},
    wait: { es: "~1-2 min (turno + email real por SES hasta el buzón simulado)", en: "~1-2 min (turn + real email through SES to the simulated mailbox)" },
    waitSec: 300,
    view: "mailbox",
  },
  {
    id: "reply",
    number: 5,
    title: { es: "Respuesta y observación", en: "Reply and finding" },
    moves: [advanceNext("2026-10-15T22:10:00-03:00", "SIM_REPLY")],
    look: {
      es: "Detalle de la 4471: la respuesta real por SES, la lectura del packing list con el peso bruto que no coincide con la factura, el pedido de corrección en el mismo hilo y el aviso al importador diferido hasta las {deferredSend}.",
      en: "4471 dossier: the real reply through SES, the packing list reading with a gross weight that does not match the invoice, the correction request in the same thread and the notice to the importer deferred until {deferredSend}.",
    },
    times: { deferredSend: deferred("2026-10-16T09:00:00-03:00") },
    wait: { es: "~2-4 min (respuesta por SES, lectura, turno y corrección por SES)", en: "~2-4 min (reply through SES, reading, turn and correction through SES)" },
    waitSec: 300,
    view: "dossier",
  },
  {
    id: "correction",
    number: 6,
    title: { es: "Corrección", en: "Correction" },
    moves: [advanceNext("2026-10-15T22:20:00-03:00", "SIM_REPLY"), advanceNext(TOUR_WINDOW.endSim, "DEFERRED_SEND")],
    look: {
      es: "Esperá entre un avance y el otro. Packing list v2 válido y legajo listo para revisión; a las {deferredSend} salen los dos avisos diferidos al importador (no tiene que hacer nada; llegaron los documentos).",
      en: "Wait between the two moves. Packing list v2 valid and dossier ready for review; at {deferredSend} the two deferred notices reach the importer (nothing to do; the documents arrived).",
    },
    times: { deferredSend: deferred(TOUR_WINDOW.endSim) },
    wait: { es: "~2-3 min cada vez", en: "~2-3 min each time" },
    waitSec: 300,
    view: "dossier",
    glossOf: "NO_ACTION_NEEDED",
  },
  {
    id: "eta",
    number: 7,
    title: { es: "Cambio de ETA", en: "ETA change" },
    moves: [{ action: { kind: "moveEta", shiftDays: -2 }, label: { es: "Mover ETA −2 días", en: "Move ETA −2 days" } }],
    look: { es: "Hitos reprogramados en el detalle de la 4471 y el aviso del nuevo plazo en el simulador.", en: "Milestones rescheduled in the 4471 dossier and the new-deadline notice in the simulator." },
    times: {},
    wait: { es: "~1 min (turno)", en: "~1 min (agent turn)" },
    waitSec: 180,
    view: "dossier",
    glossOf: "ETA_CHANGE",
  },
  {
    id: "approve",
    number: 8,
    title: { es: "Aprobar", en: "Approve" },
    moves: [{ action: { kind: "approve" }, label: { es: "Aprobar legajo", en: "Approve the dossier" } }],
    look: {
      es: "Se pide la contraseña: la aprobación humana exige un ingreso reciente. Después, el aviso de legajo aprobado en el simulador.",
      en: "Your password is asked for: the human approval needs a recent sign-in. Then the dossier-approved notice in the simulator.",
    },
    times: {},
    wait: { es: "~10 s", en: "~10 s" },
    waitSec: 60,
    view: "simulator",
    glossOf: "APPROVAL_NOTICE",
  },
  {
    id: "dispatch",
    number: 9,
    title: { es: "Despacho", en: "Customs dispatch" },
    moves: [
      { action: { kind: "emitDispatchStatus", status: "OFICIALIZADO" }, label: { es: "Emitir: oficializado", en: "Emit: declaration made official" } },
      { action: { kind: "emitDispatchStatus", status: "CANAL_ASIGNADO", channel: "NARANJA" }, label: { es: "Emitir: canal naranja", en: "Emit: orange channel" } },
      { action: { kind: "emitDispatchStatus", status: "LIBERADO" }, label: { es: "Emitir: liberado", en: "Emit: released" } },
    ],
    look: { es: "El canal naranja con su explicación genérica en el simulador y, al final, la liberación.", en: "The orange channel with its generic explanation in the simulator and, at the end, the release." },
    times: {},
    wait: { es: "~10 s por estado", en: "~10 s per status" },
    waitSec: 60,
    view: "simulator",
    glossOf: "DISPATCH_STATUS",
  },
  {
    id: "metrics",
    number: 10,
    title: { es: "Métricas", en: "Metrics" },
    moves: [{ action: { kind: "open", view: "metrics" }, label: { es: "Abrir Métricas", en: "Open Metrics" } }],
    look: { es: "KPIs con N, fuente y rótulo; decisiones de la política por regla junto a las 0 violaciones.", en: "KPIs with N, source and label; policy decisions by rule next to the 0 violations." },
    times: {},
    wait: { es: "—", en: "—" },
    waitSec: 0,
    view: "metrics",
  },
];

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");

/** "15/10 22:00" (es) or "Oct 15 22:00" (en), read in `zone`. */
export function formatTourTime(instant: string, zone: string, lang: TourLang): string {
  const wall = wallClockOf(instant, zone);
  const time = formatTime(instant, zone);
  return lang === "es" ? `${pad(wall.day)}/${pad(wall.month)} ${time}` : `${MONTHS_EN[wall.month - 1] ?? ""} ${wall.day} ${time}`;
}

/** Placeholder names of a text (`{deferredSend}` → `deferredSend`). */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1] ?? "");
}

/**
 * "Qué mirar" in `lang`, each placeholder filled with the instant `resolve` gives for it (the panel:
 * the pending timers of 4471 from `clock.get`) or, without one, with its expected value.
 */
export function lookText(step: TourStep, lang: TourLang, resolve: (name: string, time: TourTime) => string | undefined = () => undefined): string {
  return step.look[lang].replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    const time = step.times[name];
    if (time === undefined) return whole;
    return formatTourTime(resolve(name, time) ?? time.expectedSim, time.zone, lang);
  });
}
