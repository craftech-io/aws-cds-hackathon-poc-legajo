// Texts of the "Recorrido guiado" panel around the steps (the steps themselves live in steps.ts), in
// Spanish and English: the panel reads in the console's language (context/ConsoleLangContext.tsx).
// steps.ts keeps its own bilingual data, shared with scripts/, so these stay keyed by language.
import type { TourLang } from "./steps";

interface PanelTexts {
  readonly intro: string;
  readonly progress: (number: number, total: number) => string;
  readonly steps: string;
  readonly look: string;
  readonly wait: string;
  readonly gloss: string;
  readonly glossMissing: string;
  readonly done: string;
  readonly goTo: (view: string) => string;
  readonly lands: (at: string) => string;
  readonly busy: string;
  readonly restart: string;
  readonly noOperation: string;
  readonly views: Readonly<Record<"operations" | "dossier" | "simulator" | "mailbox" | "clock" | "metrics", string>>;
}

export const TOUR_TEXTS: Readonly<Record<TourLang, PanelTexts>> = {
  es: {
    intro: "La historia de la operación 4471 en 10 pasos. Cada botón usa los mismos controles de la consola; esperá lo que indica cada paso antes de seguir.",
    progress: (number, total) => `Paso ${number} de ${total}`,
    steps: "Pasos del recorrido",
    look: "Qué mirar",
    wait: "Espera esperada",
    gloss: "Glosa en inglés del mensaje",
    glossMissing: "La glosa aparece en el simulador cuando llega el mensaje.",
    done: "Hecho",
    goTo: (view) => `Ver en ${view}`,
    lands: (at) => `El próximo evento es a las ${at}.`,
    busy: "El mundo está ocupado: el botón se habilita cuando termina lo que está en curso.",
    restart: "Empezar el recorrido de nuevo",
    noOperation: "No encontramos la operación 4471 en tu mundo.",
    views: {
      operations: "Operaciones",
      dossier: "el detalle de la 4471",
      simulator: "el simulador de teléfono",
      mailbox: "el buzón de demo",
      clock: "el reloj de demo",
      metrics: "Métricas",
    },
  },
  en: {
    intro: "The story of operation 4471 in 10 steps. Every button uses the console's own controls; wait as long as each step says before moving on.",
    progress: (number, total) => `Step ${number} of ${total}`,
    steps: "Tour steps",
    look: "What to look at",
    wait: "Expected wait",
    gloss: "English gloss of the message",
    glossMissing: "The gloss shows up in the simulator once the message arrives.",
    done: "Done",
    goTo: (view) => `See it in ${view}`,
    lands: (at) => `The next event is at ${at}.`,
    busy: "The world is busy: the button turns on when what is running finishes.",
    restart: "Start the tour again",
    noOperation: "Operation 4471 is not in your world.",
    views: {
      operations: "Operations",
      dossier: "the 4471 dossier",
      simulator: "the phone simulator",
      mailbox: "the demo mailbox",
      clock: "the demo clock",
      metrics: "Metrics",
    },
  },
};
