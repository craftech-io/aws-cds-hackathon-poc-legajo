// Texts of the public landing, in Spanish (Argentina) and English with a switch
// (docs/design-brief.md §7 and §10). Both languages carry the same keys (landing.test.ts), and the
// "what is real and what is simulated" block is the one of docs/design-brief.md §7.2. WP-36 writes
// the story, the scenes and the gallery captions.

const es = {
  lang: { label: "Idioma", switchTo: "English" },
  hero: {
    eyebrow: "Agente de coordinación para estudios de despachantes de aduana",
    title: "Cada legajo, completo antes de que llegue el buque.",
    lead: "Legajo listo persigue la factura comercial, el packing list y el certificado de origen de cada importación: al importador por WhatsApp y al proveedor extranjero por email. Cada PDF pasa por un lector documental externo; el agente decide quién corrige cada observación, recalcula los plazos cuando se mueve la ETA y deja el legajo listo para que el despachante lo apruebe.",
    note: "Demo para la AWS CDS Agentic AI Partner Hackathon. Datos 100 % sintéticos: no hay empresas, personas ni operaciones reales.",
  },
  real: {
    title: "Qué es real y qué es simulado",
    columns: {
      real: { title: "Real en esta demo", text: "Todo servicio de AWS: SES de punta a punta (envío y recepción), AgentCore Harness, Gateway, Policy y Memory, Bedrock Guardrails, EventBridge Scheduler y bus, SQS, DynamoDB, S3, Cognito y CloudFront." },
      simulated: { title: "Implementado, en modo simulado", text: "El adaptador de WhatsApp de AWS End User Messaging Social: probado con fixtures, corre con un simulador de teléfono hasta que se conecte la cuenta de WhatsApp Business." },
      mocks: { title: "Sistemas simulados", text: "Lector documental (contrato OpenAPI; en la realidad es un producto externo), plataforma de gestión aduanera, transportista, aduana y proveedores." },
      data: { title: "Datos", text: "100 % sintéticos, generados con semilla fija. Todo nombre es ficticio." },
    },
  },
  cta: {
    signIn: "Jurado: ingresar",
    goToConsole: "Ir a la consola",
  },
  footer: {
    made: "Legajo listo · Powered by Craftech. Hecho para la AWS CDS Agentic AI Partner Hackathon.",
    privacy: "Privacidad",
    terms: "Términos",
  },
  media: { placeholderTitle: "Captura pendiente de la corrida en el stage", placeholderNote: "captura pendiente" },
  email: { from: "De", subject: "Asunto" },
  zoom: { open: "Ampliar imagen", close: "Cerrar", previous: "Imagen anterior", next: "Imagen siguiente", counter: (at: number, of: number) => `${at} de ${of}` },
};

export type LandingCopy = typeof es;

const en: LandingCopy = {
  lang: { label: "Language", switchTo: "Español" },
  hero: {
    eyebrow: "A coordination agent for customs brokerage firms in Latin America",
    title: "Every import file complete before the vessel arrives.",
    lead: "Legajo listo chases the commercial invoice, the packing list and the certificate of origin of every import: the importer on WhatsApp and the foreign supplier by email. Every PDF goes through an external document reader; the agent decides who must correct each finding, reschedules the deadlines when the ETA moves and leaves the file ready for the customs broker to approve.",
    note: "Demo for the AWS CDS Agentic AI Partner Hackathon. 100% synthetic data: no real companies, people or shipments.",
  },
  real: {
    title: "What is real and what is simulated",
    columns: {
      real: { title: "Real in this demo", text: "Every AWS service: SES end to end (sending and receiving), AgentCore Harness, Gateway, Policy and Memory, Bedrock Guardrails, EventBridge Scheduler and bus, SQS, DynamoDB, S3, Cognito and CloudFront." },
      simulated: { title: "Implemented, running in simulated mode", text: "The WhatsApp adapter for AWS End User Messaging Social: tested with fixtures, it runs with a phone simulator until the WhatsApp Business Account is connected." },
      mocks: { title: "Simulated systems", text: "Document reader (OpenAPI contract; an external product in real life), customs management platform, carrier, customs and suppliers." },
      data: { title: "Data", text: "100% synthetic, generated with a fixed seed. Every name is fictitious." },
    },
  },
  cta: {
    signIn: "Judges: sign in",
    goToConsole: "Go to the console",
  },
  footer: {
    made: "Legajo listo · Powered by Craftech. Built for the AWS CDS Agentic AI Partner Hackathon.",
    privacy: "Privacy",
    terms: "Terms",
  },
  media: { placeholderTitle: "Capture pending from the stage run", placeholderNote: "capture pending" },
  email: { from: "From", subject: "Subject" },
  zoom: { open: "Enlarge image", close: "Close", previous: "Previous image", next: "Next image", counter: (at: number, of: number) => `${at} of ${of}` },
};

export const LANDING_COPY = { es, en } as const;

export type LandingLang = keyof typeof LANDING_COPY;
