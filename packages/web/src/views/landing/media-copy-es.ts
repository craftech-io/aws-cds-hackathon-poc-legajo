// Alt text and caption of every picture of the landing, in Spanish (docs/landing-spec.md §7.3). The
// manifest says what a file is; these say what it shows. The console is in Spanish in both languages,
// so the English page keeps the same captures and explains them in English (media-copy-en.ts).
import type { MediaId } from "./manifest";

export interface MediaText {
  readonly alt: string;
  readonly caption: string;
}

export const MEDIA_ES = {
  loading: "Cargando capturas…",
  unavailable: "Las capturas no se pudieron cargar. El resto de la página funciona igual.",
  items: {
    "console-operations": { alt: "Vista de operaciones con la operación 4471 fijada arriba y su próximo evento", caption: "Operaciones: cada importación con su ETA, el estado del legajo y el próximo evento." },
    "console-simulator": { alt: "El hilo de WhatsApp del importador de la operación 4471", caption: "El hilo de WhatsApp del importador, con glosa en inglés." },
    "console-mailbox": { alt: "Buzón del estudio con el hilo de emails en inglés entre la operación 4471 y el proveedor", caption: "Buzón del estudio: emails por Amazon SES, en el mismo hilo." },
    "console-dossier-reading": {
      alt: "Detalle del legajo 4471 con la lectura del packing list que marca una diferencia de peso bruto y el proveedor como responsable",
      caption: "Lo que encontró el lector y quién tiene que corregirlo.",
    },
    "console-dossier": { alt: "Detalle del legajo 4471 con los tres documentos válidos y la línea de tiempo", caption: "El legajo completo, con cada paso y su motivo." },
    "console-clock": { alt: "Reloj de la operación con los hitos reprogramados después del cambio de ETA", caption: "El reloj de la operación: los hitos se reprograman solos cuando cambia la ETA." },
    "console-escalations": { alt: "Vista de escalamientos con el caso de la operación 4471 y su motivo", caption: "Lo que el agente pasó al estudio, por motivo." },
    "console-mailbox-firm": { alt: "Email de escalamiento recibido por el estudio con el estado del legajo y los intentos", caption: "El aviso que recibe el despachante, con el contexto." },
    "console-dossier-approval": { alt: "Legajo 4471 aprobado por el despachante, con la aprobación en la línea de tiempo", caption: "Aprobar es siempre de una persona." },
    "console-metrics": { alt: "Métricas con el N, la fuente y el rótulo de cada número", caption: "Métricas con N, fuente y rótulo: medido, agente guionado o supuesto." },
    "console-audit": { alt: "Bitácora de decisiones con la regla de cada una y cero violaciones", caption: "Cada decisión, con la regla que la tomó." },
    "console-tour": { alt: "Consola del invitado con el panel de recorrido guiado abierto en el primer paso", caption: "Tu primer ingreso: el mundo en pausa y el recorrido guiado." },
    "upload-page": { alt: "Página de carga de documentos de la operación 4471 en un teléfono", caption: "Link de carga: el importador ve el número de operación y lo que falta, nada más." },
    "upload-done": { alt: "Confirmación de la carga de documentos en un teléfono", caption: "Después de «Listo»: lo recibido y lo que todavía falta." },
    "og-card": { alt: "Legajo listo: cada legajo completo antes de que llegue el buque", caption: "La portada de Legajo listo." },
    "hero-conversation": { alt: "Conversación de WhatsApp con el pedido de documentos, la delegación al proveedor y el aviso del diferimiento", caption: "El canal de WhatsApp, con los textos reales de las plantillas." },
    "tour-request": { alt: "Conversación de WhatsApp con la plantilla de pedido de documentos y sus cuatro botones", caption: "El primer pedido al importador, con la plantilla aprobada." },
    "tour-delegate": { alt: "Conversación de WhatsApp con la delegación al proveedor y el email diferido por su horario", caption: "La delegación al proveedor y la regla de horario que difiere el email." },
    "tour-supplier": { alt: "Hilo de email en inglés entre la dirección de la operación 4471 y el proveedor, con los PDFs adjuntos", caption: "Lo que recibe el proveedor y lo que contesta, en el mismo hilo." },
    "tour-reader": { alt: "Lectura del lector documental: certificado válido y packing list con una diferencia de peso bruto", caption: "La lectura de cada PDF, por el contrato del lector." },
    "tour-owner": { alt: "Pedido de corrección al proveedor y aviso al importador de que no tiene que hacer nada", caption: "La corrección va a quien la tiene que hacer." },
    "tour-eta": { alt: "Tabla de hitos antes y después del cambio de ETA y el aviso del nuevo plazo al importador", caption: "Los hitos que reprograma el código cuando se mueve la ETA." },
    "tour-escalation": { alt: "Pregunta fuera de alcance detenida por el guardrail, respuesta fija al importador y aviso de escalamiento al estudio", caption: "Lo que no le toca al agente, al despachante." },
    "tour-approval": { alt: "Control de aprobación del legajo que pasa a aprobado por una persona y aviso al importador", caption: "La aprobación, siempre de una persona." },
  } satisfies Readonly<Record<MediaId, MediaText>>,
};
