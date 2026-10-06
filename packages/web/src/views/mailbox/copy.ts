// Texts of the demo mailbox (`/app/mailbox`, docs/design-brief.md §6, FL-084): what the simulated
// mailboxes of the firm and of its suppliers received, read only, bodies as plain text. Spanish and
// English with the same shape; the console's language picks one at render time (copy/localized.ts).
import { localized, type Widen } from "../../copy/localized";

const es = {
  lead: "Los buzones son simulados, pero cada email viajó de verdad por Amazon SES. Solo lectura; los cuerpos se muestran como texto plano.",
  filter: "Buzón",
  all: "Todos los buzones",
  firmMailbox: "Buzón del estudio",
  supplierMailbox: (name: string) => `Proveedor: ${name}`,
  unknownSupplier: "Proveedor",
  list: {
    title: "Emails recibidos",
    empty: "Todavía no llegó ningún email a estos buzones.",
    emptyLead: "Cuando el agente le escribe a un proveedor o escala al estudio, el email aparece acá.",
    noSubject: "(sin asunto)",
  },
  reader: {
    title: "Email",
    none: "Elegí un email de la lista para leerlo.",
    from: "De",
    to: "Para",
    subject: "Asunto",
    receivedSim: "Recibido (hora simulada)",
    receivedReal: "Recibido (hora real)",
    thread: "Hilo",
    threadOf: (operationNumber: string) => `Operación ${operationNumber}`,
    mailbox: "Buzón",
    body: "Cuerpo del email (texto plano)",
  },
  threadAddress: (operationNumber: string) => `dirección de la operación ${operationNumber}`,
} as const;

export type MailboxCopy = Widen<typeof es>;

const en = {
  lead: "The mailboxes are simulated, but every email really traveled through Amazon SES. Read only; bodies are shown as plain text.",
  filter: "Mailbox",
  all: "All mailboxes",
  firmMailbox: "Firm mailbox",
  supplierMailbox: (name: string) => `Supplier: ${name}`,
  unknownSupplier: "Supplier",
  list: {
    title: "Received emails",
    empty: "No email has reached these mailboxes yet.",
    emptyLead: "When the agent writes to a supplier or escalates to the firm, the email shows up here.",
    noSubject: "(no subject)",
  },
  reader: {
    title: "Email",
    none: "Pick an email from the list to read it.",
    from: "From",
    to: "To",
    subject: "Subject",
    receivedSim: "Received (simulated time)",
    receivedReal: "Received (real time)",
    thread: "Thread",
    threadOf: (operationNumber: string) => `Operation ${operationNumber}`,
    mailbox: "Mailbox",
    body: "Email body (plain text)",
  },
  threadAddress: (operationNumber: string) => `address of operation ${operationNumber}`,
} satisfies MailboxCopy;

export const mailboxCopy: MailboxCopy = localized({ es, en });
