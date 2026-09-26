// Texts of the demo mailbox (`/app/mailbox`, docs/design-brief.md §6, FL-084): what the simulated
// mailboxes of the firm and of its suppliers received, read only, bodies as plain text.
export const mailboxCopy = {
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
