// Spanish (Argentina) texts of the public landing (docs/design-brief.md §7 and §10). The English ones
// (copy-en.ts) implement the same type, so a key missing in either language does not compile. The
// words for documents, statuses and parties come from packages/bff/src/copy (one source per word).
import { labelsEsAR } from "@legajo/bff/copy/es-AR";
import { OBSERVATION_LABELS } from "@legajo/bff/copy/observation-labels";
import type { ObservationCode } from "@legajo/shared";
import { formatNumber } from "../../lib/format";
import type { MediaId } from "./manifest";
import type { DecisionRule, EtaMilestoneId, SceneId } from "./scenes";

interface Card {
  readonly title: string;
  readonly text: string;
}

interface SceneText extends Card {
  readonly channel: string;
}

interface ArchitectureNode {
  readonly name: string;
  readonly note: string;
  readonly tag?: "simulated" | "mock" | "live";
}

interface ArchitectureLane {
  readonly title: string;
  readonly nodes: readonly ArchitectureNode[];
}

/** Types a list of the copy by its element, so both languages share one shape. */
function list<T>(items: readonly T[]): readonly T[] {
  return items;
}

export const es = {
  lang: { code: "es-AR", switchTo: "English", switchLabel: "Ver la página en inglés" },
  nav: {
    label: "Secciones de la página",
    problem: "El problema",
    story: "La historia",
    real: "Real y simulado",
    how: "Cómo decide",
    console: "La consola",
    architecture: "Arquitectura",
  },
  hero: {
    eyebrow: "Agente de coordinación para estudios de despachantes de aduana",
    title: "Cada legajo, completo antes de que llegue el buque.",
    lead: "Legajo listo persigue la factura comercial, el packing list y el certificado de origen de cada importación: al importador por WhatsApp y al proveedor extranjero por email. Cada PDF pasa por un lector documental externo; el agente decide quién corrige cada observación, recalcula los plazos cuando se mueve la ETA y deja el legajo listo para que el despachante lo apruebe.",
    note: "Datos 100 % sintéticos: no hay empresas, personas ni operaciones reales.",
    story: "Ver la historia",
  },
  cta: { signIn: "Ingresar", goToConsole: "Ir a la consola" },
  problem: {
    title: "Tres documentos, dos idiomas y un buque que no espera",
    lead: "Antes del arribo, el despachante necesita el legajo completo de cada importación. Los documentos los tiene el importador o, casi siempre, un proveedor extranjero que contesta en inglés, desde otra zona horaria y por email.",
    items: list<Card>([
      { title: "Persecución manual", text: "El despachante le escribe al importador por su WhatsApp personal y el importador reenvía emails al proveedor. Nadie sabe qué se pidió, a quién ni cuándo." },
      { title: "Correcciones tardías", text: "Un peso que no coincide o un certificado mal emitido aparece cuando el buque ya llegó." },
      { title: "Nadie sabe quién corrige", text: "El importador recibe un problema que no es suyo y no sabe qué hacer con él." },
      {
        title: "La ETA se mueve",
        text: "El transportista cambia el arribo y los plazos quedan viejos. Cada día de demora cuesta: la consola lo estima con supuestos rotulados (≈ 5 días libres en puerto y ≈ USD 160-180 por día, supuesto), nunca como un hecho.",
      },
    ]),
  },
  story: {
    eyebrow: "La historia",
    title: "Operación 4471: del primer pedido a la liberación",
    lead: "Norpampa Insumos SRL importa desde Qingdao Bluewave Textiles en el buque Austral Aurora, con arribo estimado el 22/10. La factura comercial ya es válida; faltan el packing list y el certificado de origen. Todos los nombres son ficticios. El reloj de la demo está en pausa: la hora simulada solo avanza con un botón.",
    tabsLabel: "Escenas de la historia",
    sceneLabel: (at: number, of: number): string => `Escena ${at} de ${of}`,
    previous: "Anterior",
    next: "Siguiente",
    play: "Reproducir",
    pause: "Pausar",
    simTime: "Hora simulada",
    scenes: {
      request: {
        channel: "WhatsApp · plantilla",
        title: "El primer pedido, siete días antes del arribo",
        text: "El hito ETA − 7 dispara un turno del agente. Al importador le llega la plantilla aprobada con lo que falta y cuatro botones: subir documentos, que los mande el proveedor, hacer una pregunta o dejar de recibir avisos.",
      },
      delegate: {
        channel: "WhatsApp · política de contacto",
        title: "«Los manda el proveedor»",
        text: "El importador delega con un botón y confirma el contacto registrado. En Qingdao son las 21:00: la política de contacto difiere el email hasta las 09:00 de allá y el agente se lo avisa al importador.",
      },
      supplier: {
        channel: "Email · Amazon SES",
        title: "El proveedor responde por email de verdad",
        text: "El pedido sale en inglés desde la dirección de la operación. El proveedor simulado responde por SES con los PDFs, el lector documental marca el peso bruto del packing list (12.480 kg contra 12.840 kg de la factura) y el agente pide la corrección en el mismo hilo.",
      },
      noAction: {
        channel: "WhatsApp · 09:00",
        title: "«No tenés que hacer nada»",
        text: "Al importador le dice solo lo que le toca: la corrección es del proveedor. El aviso sale a las 09:00, cuando el horario de Argentina lo permite. Con la versión 2 del packing list, el legajo queda listo para revisión.",
      },
      question: {
        channel: "WhatsApp · guardrails",
        title: "Una duda con respuesta y un límite",
        text: "«¿El certificado tiene que estar firmado?» se responde con el checklist del estudio. «¿Qué posición arancelaria va?» es asesoramiento aduanero: el guardrail lo bloquea antes del modelo, sale la respuesta fija y el caso pasa al despachante.",
      },
      eta: {
        channel: "Transportista · hitos",
        title: "La ETA se adelanta dos días",
        text: "El transportista informa un arribo nuevo. El código reprograma los hitos pendientes sin pasar por el modelo; el agente solo comunica el nuevo plazo.",
      },
      approval: {
        channel: "Consola · WhatsApp",
        title: "Aprobación humana y estado del despacho",
        text: "Con los tres documentos válidos, el despachante revisa lecturas y observaciones y aprueba con un ingreso reciente: ninguna herramienta del agente puede aprobar. Después llegan el canal naranja, con una explicación genérica, y la liberación.",
      },
      policy: {
        channel: "Bitácora",
        title: "Cada decisión, con su regla",
        text: "La política de contacto vive en el código y deja cada decisión en la bitácora. Una auditoría vuelve a evaluar cada mensaje enviado con los datos de ese momento: la meta es cero violaciones.",
      },
    } satisfies Readonly<Record<SceneId, SceneText>>,
    deferrals: {
      supplierHours: "Pendiente: diferido por el horario del proveedor hasta el 16/10 09:00 en Qingdao (15/10 22:00 en Buenos Aires).",
      importerHours: "Pendiente: el aviso de las 22:10 quedó diferido hasta las 09:00 por el horario de Argentina.",
    },
    decisionsTitle: "Decisiones de la política de contacto y de Cedar",
    outcomes: { deferred: "Diferido", denied: "Denegado" },
    decisions: {
      "CP-HOURS-SUPPLIER": { attempt: "Email al proveedor a las 21:00 de Qingdao", outcome: "Sale a las 09:00 de allá" },
      "CP-HOURS-AR": { attempt: "Aviso al importador a las 22:10", outcome: "Sale a las 09:00" },
      "CP-ONE-PER-DAY": { attempt: "Un segundo recordatorio el mismo día", outcome: "No sale" },
      "CP-OPTIN": { attempt: "WhatsApp a un importador sin opt-in", outcome: "No sale y el caso pasa al estudio" },
      "CP-NO-FOREIGN-LINKS": { attempt: "Un texto con un link que no es el de carga", outcome: "No sale" },
      "CED-NO-APPROVE": { attempt: "El modelo intenta aprobar el legajo", outcome: "Aprobar es siempre de una persona" },
    } satisfies Readonly<Record<DecisionRule, { readonly attempt: string; readonly outcome: string }>>,
    eta: {
      event: "El transportista informa un arribo estimado nuevo: 22/10 → 20/10.",
      tableLabel: "Hitos reprogramados por el código",
      milestone: "Hito",
      before: "Antes",
      after: "Ahora",
      milestones: {
        followupFinal: "Último recordatorio (ETA − 3 días)",
        escalation: "Escalamiento si falta algo (ETA − 48 h)",
        arrival: "Arribo",
      } satisfies Readonly<Record<EtaMilestoneId, string>>,
    },
    reader: {
      title: "Lectura del lector documental",
      version: (version: number): string => `versión ${version}`,
      responsible: "Responsable",
      found: "en el packing list",
      expected: "en la factura",
    },
    labels: labelsEsAR,
    observation: (code: ObservationCode): string => OBSERVATION_LABELS[code].es,
    kg: (value: number): string => `${formatNumber(value)} kg`,
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
  how: {
    eyebrow: "Cómo decide",
    title: "Lo que no depende del modelo",
    lead: "El modelo decide qué hacer en cada turno. Lo que no se negocia está en el código, en las políticas de Cedar y en los guardrails.",
    items: list<Card>([
      { title: "La aprobación es siempre humana", text: "No existe una herramienta del agente que apruebe: Cedar lo deniega y la consola le pide al despachante un ingreso de hace menos de 15 minutos." },
      { title: "La política vive en el código", text: "Opt-in, ventana de 24 h, horario de cada parte, un recordatorio por día y cerco de destinatarios: reglas que deciden antes de cada envío, nunca el prompt." },
      { title: "El agente habla solo por herramientas", text: "Todo WhatsApp y todo email pasan por el mismo pipeline de salida; el texto final de cada turno es una nota interna que no se envía." },
      { title: "La lectura de documentos no es nuestra", text: "Cada PDF va a un lector documental externo por su contrato OpenAPI. Lo que el lector no reconoce lo resuelve el despachante." },
      { title: "La identidad no la decide el modelo", text: "El importador se reconoce por su teléfono registrado y el proveedor por la dirección de la operación, su contacto confirmado y DMARC. Ningún id que escriba el modelo se usa." },
      { title: "Todo lo entrante es hostil", text: "CUIT, DNI, CBU, tarjetas e IBAN se enmascaran antes de guardarse; el texto viaja escapado dentro de un delimitador aleatorio y pasa por un guardrail antes del modelo." },
    ]),
  },
  console: {
    eyebrow: "La consola del estudio",
    title: "Todo lo que pasó, con su motivo",
    lead: "Operaciones con su próximo evento, el detalle de cada legajo con lecturas, observaciones y pendientes, el reloj de la demo, el simulador de teléfono, el buzón de demo, las métricas con su N y su rótulo, y la bitácora de decisiones.",
    pending: "Las capturas de la consola se toman en el stage desplegado, con la cuenta sintética de prueba, después de una corrida real.",
    uploadTitle: "La página de carga del importador, sin login",
  },
  media: {
    placeholderTitle: "Captura pendiente de la corrida en el stage",
    placeholderNote: "captura pendiente",
    localTitle: "Captura del servidor local de pruebas: el agente está reemplazado por un plan fijo",
    localNote: "entorno local, agente guionado",
    items: {
      "console-operations": { alt: "Vista de operaciones de la consola con la operación 4471 fijada arriba", caption: "Operaciones: la 4471 fijada como historia principal, con su próximo evento." },
      "console-dossier": { alt: "Detalle del legajo de la operación 4471", caption: "Detalle del legajo: documentos, lecturas, observaciones y pendientes con su motivo." },
      "console-simulator": { alt: "Simulador de teléfono con el hilo de WhatsApp del importador", caption: "Simulador de teléfono: WhatsApp en modo simulado, con la glosa en inglés." },
      "console-mailbox": { alt: "Buzón de demo con los emails del hilo de la operación", caption: "Buzón de demo: los emails reales por SES, en texto plano." },
      "console-clock": { alt: "Reloj de demo con la hora simulada y los próximos eventos", caption: "Reloj de demo: el mundo en pausa y lo próximo que va a pasar." },
      "console-metrics": { alt: "Métricas con el N, la fuente y el rótulo de cada número", caption: "Métricas con N, fuente y rótulo: medido, agente guionado o supuesto." },
      "console-audit": { alt: "Bitácora de decisiones con la regla de cada una", caption: "Bitácora: cada decisión con su regla y cero violaciones de política." },
      "upload-page": { alt: "Página de carga de documentos de la operación 4471 en un teléfono", caption: "Link de carga: el importador ve el número de operación y lo que falta, nada más." },
      "upload-done": { alt: "Confirmación de la carga de documentos en un teléfono", caption: "Después de «Listo»: lo recibido y lo que todavía falta." },
    } satisfies Readonly<Record<MediaId, { readonly alt: string; readonly caption: string }>>,
  },
  architecture: {
    eyebrow: "Arquitectura",
    title: "Serverless en AWS, de punta a punta",
    lead: "Todo servicio de AWS es real en el stage; los sistemas de terceros son mocks nuestros detrás de sus contratos.",
    tags: { simulated: "modo simulado", mock: "mock", live: "en vivo" },
    lanes: list<ArchitectureLane>([
      {
        title: "Las partes",
        nodes: [
          { name: "Importador", note: "WhatsApp por AWS End User Messaging Social, con el simulador de teléfono de la consola", tag: "simulated" },
          { name: "Proveedor extranjero", note: "Email por Amazon SES de punta a punta; sus buzones son simulados", tag: "live" },
          { name: "Estudio", note: "Consola en CloudFront, login propio en Cognito y un BFF tRPC en Lambda" },
        ],
      },
      {
        title: "Entrada y orquestación",
        nodes: [
          { name: "Canales de entrada", note: "SNS para WhatsApp, reglas de recepción de SES con S3 para el email, y el link de carga con POST prefirmado a S3 y escaneo de malware" },
          { name: "SQS FIFO por operación", note: "Los turnos de una operación corren de a uno y en orden; un evento repetido se procesa una vez" },
          { name: "EventBridge Scheduler y bus", note: "Hitos relativos a la ETA y eventos del transportista y de la aduana" },
        ],
      },
      {
        title: "El agente",
        nodes: [
          { name: "Bedrock AgentCore Harness", note: "Un turno por evento, con memoria de corto y largo plazo en AgentCore Memory" },
          { name: "Gateway MCP y Policy (Cedar)", note: "15 herramientas en 5 targets Lambda; toda identidad sale de la sesión, nunca del modelo" },
          { name: "Bedrock Guardrails", note: "Uno antes del modelo (temas denegados, inyección, tarjetas) y otro sobre cada texto que sale (grounding)" },
        ],
      },
      {
        title: "Salida y datos",
        nodes: [
          { name: "Pipeline de salida", note: "Política de contacto, verificación de cifras, fechas y enlaces, y cerco de destinatarios" },
          { name: "Lector documental", note: "Producto externo detrás de un contrato OpenAPI; en la demo, un mock nuestro", tag: "mock" },
          { name: "DynamoDB y S3", note: "Una tabla por agregado, bitácora de decisiones y documentos versionados" },
        ],
      },
    ]),
  },
  video: { title: "El video de la demo" },
  footer: {
    made: "Legajo listo · Powered by Craftech.",
    synthetic: "Datos 100 % sintéticos: todo nombre es ficticio.",
    legal: "Legales",
    privacy: "Privacidad",
    terms: "Términos",
  },
  phone: {
    simulator: "Simulador · WhatsApp en modo simulado",
    fictitious: "estudio ficticio",
    glossToggle: "Mostrar la glosa en inglés",
    sources: { template: "Plantilla", fixed: "Texto fijo", agent: "Ejemplo de texto del agente", importer: "" },
    caption: "Ilustración con los textos reales de las plantillas y del código; las respuestas libres del agente son de ejemplo.",
    conversation: (day: string): string => `Conversación de WhatsApp del ${day}`,
  },
  email: {
    threadLabel: "Hilo de email con el proveedor",
    from: "De",
    to: "Para",
    subject: "Asunto",
    attachments: "Adjuntos",
    agent: "Cuerpo de ejemplo: lo escribe el agente",
    simulator: "Texto real del proveedor simulado",
    when: (ar: string, supplier: string): string => `${ar} en Buenos Aires · ${supplier} en Qingdao`,
  },
  zoom: { open: "Ampliar imagen", close: "Cerrar", previous: "Imagen anterior", next: "Imagen siguiente", counter: (at: number, of: number): string => `${at} de ${of}` },
};

export type LandingCopy = typeof es;
