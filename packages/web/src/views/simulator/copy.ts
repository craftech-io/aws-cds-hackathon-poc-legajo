// Texts of the phone simulator (`/app/simulator`, docs/design-brief.md §6, FL-083): the importer's
// phone while WhatsApp runs in simulated mode. The messages themselves (templates, fixed texts and
// their English gloss) come from the BFF's copy through `simulator.threads`; only the frame is here.
// Spanish and English with the same shape; the console's language picks one at render time
// (copy/localized.ts).
import { localized, type Widen } from "../../copy/localized";

const es = {
  frameLabel: "simulador · WhatsApp en modo simulado",
  lead: "Hacés de importador: lo que escribís o tocás entra por el mismo camino que un evento real de WhatsApp, y lo que manda el estudio se ve como lo vería el importador.",
  threads: {
    title: "Hilos de los importadores",
    empty: "El estudio no tiene importadores con WhatsApp en este mundo.",
    operations: (numbers: readonly string[]) => (numbers.length === 1 ? `Operación ${numbers[0]}` : `Operaciones ${numbers.join(", ")}`),
    unread: (count: number) => (count === 1 ? "1 mensaje sin leer" : `${count} mensajes sin leer`),
    open: (name: string) => `Abrir el hilo de ${name}`,
  },
  phone: {
    title: (name: string) => `Teléfono de ${name}`,
    chatWith: "Chat con el estudio",
    empty: "Todavía no hay mensajes en este hilo.",
    typing: "El agente está escribiendo…",
    template: "Plantilla",
    gloss: "EN",
    glossShow: "Mostrar la glosa en inglés",
    glossLabel: "English gloss",
    tapLabel: (title: string) => `Tocar el botón ${title}`,
    openLink: (title: string) => `${title} (abre el link de carga)`,
    attachment: "Documento PDF",
    attachmentRejected: "Adjunto rechazado",
    markRead: "Marcar leído",
  },
  status: {
    SENT: "Enviado",
    DELIVERED: "Entregado",
    READ: "Leído",
    FAILED: "No se entregó",
  } as Readonly<Record<string, string>>,
  composer: {
    label: "Mensaje del importador",
    placeholder: "Escribí como el importador…",
    send: "Enviar",
    attach: "Adjuntar PDF",
    closeAttach: "Cerrar adjuntar",
  },
  attach: {
    title: "Adjuntar un PDF",
    synthetic: "PDF sintético de una operación",
    operation: "Operación",
    docType: "Documento",
    sendSynthetic: "Adjuntar PDF sintético",
    own: "O subí un PDF propio (hasta 10 MB)",
    sendOwn: "Subir y adjuntar",
    notPdf: "Solo se aceptan archivos PDF.",
    tooLarge: "El PDF pasa los 10 MB.",
    scanning: "El PDF se sube y pasa por el escaneo de malware antes de leerse (~1 min).",
  },
  docTypes: {
    COMMERCIAL_INVOICE: "Factura comercial",
    PACKING_LIST: "Packing list",
    CERTIFICATE_OF_ORIGIN: "Certificado de origen",
  },
  done: {
    sent: "Mensaje enviado.",
    tapped: "Botón tocado.",
    attached: "PDF adjuntado.",
    read: "Hilo marcado como leído.",
  },
  liveMode: "WhatsApp corre en modo vivo: el simulador de teléfono está apagado.",
} as const;

export type SimulatorCopy = Widen<typeof es>;

const en = {
  frameLabel: "simulator · WhatsApp in simulated mode",
  lead: "You play the importer: what you type or tap takes the same path as a real WhatsApp event, and what the firm sends looks the way the importer would see it.",
  threads: {
    title: "Importer threads",
    empty: "The firm has no importers on WhatsApp in this world.",
    operations: (numbers: readonly string[]) => (numbers.length === 1 ? `Operation ${numbers[0]}` : `Operations ${numbers.join(", ")}`),
    unread: (count: number) => (count === 1 ? "1 unread message" : `${count} unread messages`),
    open: (name: string) => `Open the thread of ${name}`,
  },
  phone: {
    title: (name: string) => `${name}'s phone`,
    chatWith: "Chat with the firm",
    empty: "There are no messages in this thread yet.",
    typing: "The agent is typing…",
    template: "Template",
    gloss: "EN",
    glossShow: "Show the English gloss",
    glossLabel: "English gloss",
    tapLabel: (title: string) => `Tap the ${title} button`,
    openLink: (title: string) => `${title} (opens the upload link)`,
    attachment: "PDF document",
    attachmentRejected: "Attachment rejected",
    markRead: "Mark as read",
  },
  status: {
    SENT: "Sent",
    DELIVERED: "Delivered",
    READ: "Read",
    FAILED: "Not delivered",
  },
  composer: {
    label: "Importer's message",
    placeholder: "Write as the importer…",
    send: "Send",
    attach: "Attach PDF",
    closeAttach: "Close attach panel",
  },
  attach: {
    title: "Attach a PDF",
    synthetic: "Synthetic PDF of an operation",
    operation: "Operation",
    docType: "Document",
    sendSynthetic: "Attach synthetic PDF",
    own: "Or upload your own PDF (up to 10 MB)",
    sendOwn: "Upload and attach",
    notPdf: "Only PDF files are accepted.",
    tooLarge: "The PDF is over 10 MB.",
    scanning: "The PDF is uploaded and goes through the malware scan before it is read (~1 min).",
  },
  docTypes: {
    COMMERCIAL_INVOICE: "Commercial invoice",
    PACKING_LIST: "Packing list",
    CERTIFICATE_OF_ORIGIN: "Certificate of origin",
  },
  done: {
    sent: "Message sent.",
    tapped: "Button tapped.",
    attached: "PDF attached.",
    read: "Thread marked as read.",
  },
  liveMode: "WhatsApp runs in live mode: the phone simulator is off.",
} satisfies SimulatorCopy;

export const simulatorCopy: SimulatorCopy = localized({ es, en });
