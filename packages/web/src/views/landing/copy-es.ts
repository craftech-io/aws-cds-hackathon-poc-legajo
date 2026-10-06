// Spanish (Argentina) texts of the public landing, the copy deck of docs/landing-spec.md §2. The English
// ones (copy-en.ts) implement the same type, so a key missing in either language does not compile.
// The words for documents, statuses and parties come from packages/bff/src/copy (one source per word);
// what WhatsApp and the emails say comes from the real templates (conversations.ts). Voseo; numbers
// with a decimal comma and a dot for thousands (lib/format).
import { labelsEsAR } from "@legajo/bff/copy/es-AR";
import { OBSERVATION_LABELS } from "@legajo/bff/copy/observation-labels";
import type { ObservationCode } from "@legajo/shared";
import { formatNumber } from "../../lib/format";
import type { ArchitectureLayerId, ArchitectureNodeId } from "./architecture";
import type { ImpactTileId } from "./goals";
import { MEDIA_ES } from "./media-copy-es";
import type { EtaMilestoneId } from "./scenes";
import type { TourStepId } from "./tour-steps";

interface StepText {
  readonly channel: string;
  readonly title: string;
  readonly text: string;
}

interface Actor {
  readonly title: string;
  readonly lead: string;
  readonly items: readonly string[];
}

interface Question {
  readonly q: string;
  readonly a: string;
}

/** Types a list of the copy by its element, so both languages share one shape. */
function list<T>(items: readonly T[]): readonly T[] {
  return items;
}

export const es = {
  meta: {
    code: "es-AR",
    title: "SIDOM Legajo listo · Agente de coordinación para despachantes de aduana",
    description: "Cada legajo completo antes de que llegue el buque: un agente que persigue la factura comercial, el packing list y el certificado de origen de cada importación.",
  },
  lang: { label: "Idioma" },
  nav: { label: "Secciones de la página", tour: "Cómo funciona", guarantees: "Garantías", integrations: "Integración", architecture: "Arquitectura", faq: "Preguntas", menu: "Menú", skip: "Saltar al contenido" },
  cta: {
    try: "Probar Legajo listo",
    tryShort: "Probar",
    signIn: "Ingresar",
    talk: "Hablemos",
    toConsole: "Ir a mi consola",
    talkHint: "Se abre el contacto de Craftech en una pestaña nueva",
    newTab: "(se abre en una pestaña nueva)",
  },
  motion: { paused: "Pausar animaciones", resume: "Reanudar animaciones" },
  session: { signedIn: "Tenés una sesión abierta." },
  hero: {
    eyebrow: "SIDOM · Para estudios de despachantes de aduana",
    title: "Cada legajo completo antes de que llegue el buque.",
    lead: "Legajo listo persigue la factura comercial, el packing list y el certificado de origen de cada importación: al importador por WhatsApp, al proveedor extranjero por email y en inglés. Decide quién corrige cada observación, recalcula los plazos cuando se mueve la ETA y te deja el legajo listo para aprobar.",
    primary: "Probar Legajo listo",
    secondary: "Ingresar",
    tertiary: "Ver cómo funciona",
    trust: list<string>(["La aprobación es siempre tuya", "Política de contacto en código", "Serverless en AWS"]),
    note: "Se conecta con tu sistema de gestión y con tu lector documental.",
    phoneCaption: "Así le llega al importador: plantillas aprobadas y botones de respuesta.",
    replay: "Repetir la conversación",
    phoneLabel: "Conversación de ejemplo por WhatsApp entre Estudio Delta y un importador",
  },
  problem: {
    eyebrow: "El problema",
    title: "Tres documentos, dos idiomas y un buque que no espera",
    lead: "Antes del arribo, el despachante necesita el legajo completo. Los documentos los tiene el importador o, casi siempre, un proveedor extranjero que contesta en inglés, desde otra zona horaria y por email.",
    items: list<{ readonly title: string; readonly text: string }>([
      { title: "Persecución manual", text: "Mensajes desde el WhatsApp personal, emails reenviados y nadie sabe qué se pidió, a quién ni cuándo." },
      { title: "Correcciones tardías y sin dueño", text: "Un peso que no coincide aparece con el buque en puerto, y el importador recibe un problema que no es suyo." },
      { title: "La ETA se mueve", text: "El arribo cambia, los plazos quedan viejos y el riesgo de almacenaje y demora no se ve hasta que cuesta." },
    ]),
    timeline: { label: "Días hasta el arribo", marks: list<string>(["ETA − 7", "ETA − 3", "ETA − 48 h", "Arribo"]) },
  },
  tour: {
    eyebrow: "Cómo funciona",
    title: "Operación 4471, de punta a punta",
    lead: "Un importador trae textiles en el buque Austral Aurora, con arribo el 22/10. La factura ya es válida; faltan el packing list y el certificado de origen. Así lo resuelve Legajo listo.",
    stepLabel: (at: number, of: number): string => `Paso ${at} de ${of}`,
    previous: "Paso anterior",
    next: "Paso siguiente",
    stepsLabel: "Pasos del recorrido",
    carousel: "carrusel",
    simTime: "Hora",
    agentSample: "Mensaje del agente",
    template: "Plantilla aprobada",
    fixed: "Texto fijo",
    renderBadge: "Vista del producto",
    enlarge: "Ampliar",
    steps: {
      request: { channel: "WhatsApp · plantilla", title: "El primer pedido, siete días antes del arribo", text: "Al importador le llega lo que falta con cuatro botones: subir los documentos, que los mande el proveedor, hacer una pregunta o dejar de recibir avisos." },
      delegate: { channel: "WhatsApp · política de contacto", title: "«Los manda el proveedor»", text: "El importador delega con un toque y confirma el contacto registrado. Del otro lado son las 21:00: el email espera hasta las 09:00 del proveedor, y el agente se lo avisa al importador." },
      supplier: { channel: "Email · en inglés", title: "Lo que recibe el proveedor", text: "Un pedido claro, en inglés, desde la dirección de la operación. El proveedor contesta en el mismo hilo con los PDFs adjuntos." },
      reader: { channel: "Lector documental", title: "Lo que encuentra el lector", text: "Cada PDF va al lector documental por su contrato. El certificado es válido; el packing list declara 12.480 kg de peso bruto y la factura, 12.840 kg." },
      owner: { channel: "Email · WhatsApp", title: "Quién corrige", text: "La corrección es del proveedor: el agente se la pide en el mismo hilo. Al importador le dice solo lo que le toca: «no tenés que hacer nada»." },
      eta: { channel: "Transportista · hitos", title: "La ETA se adelanta dos días", text: "El transportista informa un arribo nuevo. El código reprograma los hitos pendientes, sin pasar por el modelo, y el agente comunica el nuevo plazo." },
      escalation: { channel: "Guardrail · escalamiento", title: "Lo que no le toca al agente, va al despachante", text: "«¿Qué posición arancelaria va?» es asesoramiento aduanero. Un guardrail lo detiene antes del modelo, el importador recibe una respuesta fija y el despachante, un aviso de escalamiento con el contexto." },
      approval: { channel: "Consola del estudio", title: "La aprobación es siempre humana", text: "Llega la versión 2 del packing list y el legajo queda listo para revisión. Con los tres documentos válidos, el despachante revisa lecturas y observaciones y aprueba con un ingreso reciente. Ninguna herramienta del agente puede aprobar." },
    } satisfies Readonly<Record<TourStepId, StepText>>,
    eta: {
      before: "Antes",
      after: "Ahora",
      milestone: "Hito",
      event: "El transportista informa un arribo estimado nuevo: 22/10 → 20/10.",
      tableLabel: "Hitos reprogramados por el código",
      milestones: { followupFinal: "Último recordatorio (ETA − 3 días)", escalation: "Escalamiento si falta algo (ETA − 48 h)", arrival: "Arribo" } satisfies Readonly<Record<EtaMilestoneId, string>>,
    },
    reader: { title: "Lectura del lector documental", found: "en el packing list", expected: "en la factura", owner: "Responsable", pending: "—", version: (version: number): string => `versión ${version}` },
    deferral: { supplier: "Diferido por el horario del proveedor hasta las 09:00 de allá", importer: "Diferido por el horario de Argentina hasta las 09:00" },
    escalation: { guardrail: "Guardrail antes del modelo", model: "Modelo", blocked: "Detenido", mailbox: "Buzón del estudio" },
    approval: { approved: "Aprobado por una persona", recentSignIn: "Pide un ingreso de los últimos 15 minutos" },
  },
  capabilities: {
    eyebrow: "Qué hace",
    title: "Cada parte, por su canal y en su idioma",
    importer: { title: "Importador", lead: "Sabe qué le toca y qué no.", items: list<string>(["Pedido por WhatsApp con botones", "Link de carga sin usuario ni contraseña", "Delegar al proveedor con un toque", "Dudas respondidas con el checklist del estudio", "Baja de avisos cuando quiera"]) } satisfies Actor,
    supplier: { title: "Proveedor extranjero", lead: "Un pedido claro, en inglés y en su horario.", items: list<string>(["Email en inglés desde la dirección de la operación", "Correcciones concretas en el mismo hilo", "Nunca fuera de su horario laboral"]) } satisfies Actor,
    firm: {
      title: "Estudio",
      lead: "Legajos completos antes del arribo, con el motivo de cada paso.",
      items: list<string>(["Operaciones con su próximo evento", "Detalle del legajo con lecturas, observaciones y responsables", "Escalamientos por motivo", "Tomar la conversación cuando quieras", "Aprobar, siempre una persona", "Métricas con su N y bitácora de decisiones"]),
    } satisfies Actor,
  },
  guarantees: {
    eyebrow: "Garantías",
    title: "Lo que no depende del modelo",
    lead: "El modelo decide qué hacer en cada turno. Lo que no se negocia está en el código, en las políticas del agente y en los guardrails.",
    ruleLabel: "Regla",
    items: list<{ readonly title: string; readonly text: string }>([
      { title: "La aprobación es siempre humana.", text: "No existe una herramienta del agente que apruebe, y la consola pide un ingreso reciente." },
      { title: "La política de contacto vive en el código.", text: "Opt-in, ventana de 24 horas, horario de cada parte y un recordatorio por día, antes de cada envío." },
      { title: "Nadie recibe un dato ajeno.", text: "Cada envío pasa por un cerco de destinatarios y ningún mensaje lleva enlaces ni contactos ajenos." },
      { title: "La lectura de documentos es de tu lector.", text: "Cada PDF va al lector documental por su contrato; lo que no reconoce lo resuelve el despachante." },
      { title: "La identidad no la decide el modelo.", text: "Teléfono registrado del importador; dirección de la operación, contacto confirmado y DMARC del proveedor." },
      { title: "Todo lo que entra es hostil.", text: "Datos sensibles enmascarados antes de guardarse y un guardrail antes del modelo." },
    ]),
    rules: {
      "CED-NO-APPROVE": "El agente no aprueba",
      "CP-OPTIN": "Opt-in de WhatsApp",
      "CP-HOURS-AR": "Horario de Argentina",
      "CP-HOURS-SUPPLIER": "Horario del proveedor",
      "CP-ONE-PER-DAY": "Un recordatorio por día",
      "CP-NO-FOREIGN-LINKS": "Sin enlaces ni contactos ajenos",
    },
  },
  impact: {
    eyebrow: "Impacto",
    title: "Lo que buscamos para tu estudio",
    lead: "Las metas con las que trabaja Legajo listo en cada estudio. La consola mide cada una, con su N.",
    labels: { goal: "Meta", guarantee: "Garantía en código", assumption: "Supuesto" },
    tiles: {
      complete72h: { value: (count: number): string => `${count} h`, title: "Legajo completo antes del arribo", note: "Los tres documentos válidos al menos 72 horas antes de la ETA vigente." },
      sameDay: { value: (): string => "El mismo día", title: "Cada corrección, pedida a su responsable", note: "Cuando llega el PDF, la observación va a quien la tiene que corregir, ese mismo día." },
      oneStory: { value: (count: number): string => `${count} %`, title: "Una sola historia por operación", note: "Cada pedido, respuesta, lectura y decisión en una línea de tiempo, con su motivo." },
      humanApproval: { value: (count: number): string => `${count} %`, title: "Aprobaciones hechas por una persona", note: "Ninguna herramienta del agente puede aprobar." },
    } satisfies Readonly<Record<ImpactTileId, { readonly value: (count: number) => string; readonly title: string; readonly note: string }>>,
    footnote: "Cada número se mide en la consola, con su N, su fuente y su rótulo.",
    assumptions: "El riesgo de demora se estima con supuestos editables por estudio (días libres en puerto, USD por día y por contenedor).",
  },
  integrations: {
    eyebrow: "Cómo se integra",
    title: "Serverless en AWS, conectado a tus sistemas por contrato",
    lead: "Canales de AWS para hablar con cada parte, un agente con reglas en el código y conectores por contrato a tu lector documental y a tu sistema de gestión.",
    lanes: { channels: "Canales", agent: "Agente", time: "Tiempo y eventos", systems: "Tus sistemas" },
    nodes: {
      whatsapp: "WhatsApp por AWS End User Messaging Social · plantillas aprobadas, botones y documentos",
      email: "Amazon SES · envío y recepción, DMARC y un hilo por operación",
      upload: "Link de carga · sin usuario, con escaneo de malware",
      agentcore: "Agente de coordinación · turnos, herramientas, políticas y memoria de cada conversación",
      guardrails: "Guardrails · antes del modelo y sobre cada texto que sale",
      scheduler: "Amazon EventBridge Scheduler · hitos relativos a la ETA que se reprograman solos",
      reader: "Lector documental · el que elija tu estudio, detrás de un contrato OpenAPI",
      platform: "Tu sistema de gestión · conector por contrato, adaptado a tu estudio",
    },
    points: list<string>(["Sin servidores que administrar", "Conectores por contrato", "Todo por infraestructura como código"]),
    platforms: {
      title: "Para plataformas de comercio exterior",
      lead: "¿Tenés un software para despachantes o importadores? Legajo listo se suma como módulo, sin reemplazar lo que ya hacés.",
      items: list<string>([
        "El lector documental se conecta por un contrato OpenAPI publicado",
        "La plataforma de gestión, por una API versionada con su esquema",
        "Estados y novedades entran como eventos",
        "Canales, política de contacto y reglas viven en código, sobre AWS serverless",
      ]),
      cta: "Hablemos de integrarlo",
    },
    diagramAlt:
      "Diagrama: el importador por WhatsApp y el proveedor por email llegan a una cola por operación; el agente decide con herramientas y políticas; los envíos salen por un pipeline con la política de contacto; el lector documental y el sistema de gestión se conectan por contrato.",
  },
  video: {
    eyebrow: "En dos minutos",
    title: "Legajo listo, funcionando",
    lead: "El importador conversa por WhatsApp y recibe respuestas en segundos, el proveedor recibe el pedido en inglés, el lector encuentra una diferencia y el despachante aprueba.",
    note: "Narrado en inglés, con subtítulos. La conversación es con un teléfono real; las esperas entre mensajes están aceleradas y rotuladas.",
    fallback: "Descargar el video",
  },
  architecture: {
    eyebrow: "Arquitectura",
    title: "Cómo funciona por dentro",
    lead: "Todo corre serverless en AWS. Cada parte entra por su canal, una cola por operación ordena los eventos, el agente decide con herramientas y reglas escritas en código, y tus sistemas se conectan por contrato.",
    alt: "Diagrama de arquitectura en AWS: el importador, el proveedor y el despachante entran por AWS End User Messaging Social, Amazon SES y Amazon CloudFront con Amazon Cognito; una cola de Amazon SQS por operación alimenta a AWS Lambda; Amazon EventBridge Scheduler programa los hitos; el agente de coordinación usa herramientas en AWS Lambda; los datos viven en Amazon DynamoDB y Amazon S3, con escaneo de Amazon GuardDuty; el lector documental y el sistema de gestión se conectan por contrato.",
    diagram: {
      title: "El diagrama completo, con sus conexiones",
      caption: "Cada flecha es una conexión real entre servicios; los números siguen un mensaje de punta a punta.",
      open: "Abrir en tamaño completo",
      scrollHint: "Deslizá para recorrer el diagrama",
      alt: "Diagrama de arquitectura de Legajo listo en AWS con sus conexiones. El importador (WhatsApp) y el proveedor (email) hablan con AWS End User Messaging Social y Amazon SES, que envían los eventos a las Lambdas de entrada. Estas verifican la identidad y encolan en Amazon SQS FIFO, con un grupo por operación; EventBridge Scheduler agrega los temporizadores. El worker de la operación invoca el Harness del agente, que usa Memoria, Guardrails y Gateway con políticas Cedar. Cada mensaje de salida pasa por un pipeline de cinco pasos, de la política de contacto al envío y la auditoría, y vuelve por los mismos canales. Abajo, los datos (DynamoDB, S3, GuardDuty, CloudWatch) y los sistemas del estudio: lector documental y sistema de gestión.",
      layersTitle: "El mismo recorrido, por capas",
    },
    layers: { parties: "Las partes", edge: "Canales y acceso", flow: "Orquestación", agent: "Agente", data: "Datos", systems: "Tus sistemas" } satisfies Readonly<Record<ArchitectureLayerId, string>>,
    nodes: {
      importer: { name: "Importador", role: "WhatsApp, en español" },
      supplier: { name: "Proveedor extranjero", role: "Email, en inglés" },
      broker: { name: "Despachante", role: "Consola web del estudio" },
      eumSocial: { name: "AWS End User Messaging Social", role: "WhatsApp: plantillas, botones y documentos" },
      ses: { name: "Amazon SES", role: "Envío y recepción, un hilo por operación" },
      edge: { name: "Amazon CloudFront y AWS WAF", role: "Consola y link de carga, protegidos" },
      cognito: { name: "Amazon Cognito", role: "Ingreso del estudio" },
      sqs: { name: "Amazon SQS", role: "Una cola FIFO por operación" },
      worker: { name: "AWS Lambda", role: "Procesa cada evento, en orden" },
      scheduler: { name: "Amazon EventBridge Scheduler", role: "Hitos relativos a la ETA" },
      agent: { name: "Agente de coordinación", role: "Turnos, memoria de cada chat, políticas y guardrails" },
      tools: { name: "Herramientas en AWS Lambda", role: "Leer el legajo, escribir, programar, escalar" },
      dynamodb: { name: "Amazon DynamoDB", role: "Operaciones, conversaciones y auditoría" },
      s3: { name: "Amazon S3", role: "Documentos y adjuntos" },
      guardduty: { name: "Amazon GuardDuty", role: "Escaneo de malware de cada archivo" },
      reader: { name: "Lector documental", role: "El tuyo, por contrato OpenAPI" },
      platform: { name: "Sistema de gestión", role: "Operaciones y estados, por API" },
    } satisfies Readonly<Record<ArchitectureNodeId, { readonly name: string; readonly role: string }>>,
    steps: list<{ readonly title: string; readonly text: string }>([
      { title: "Entra un mensaje", text: "Un WhatsApp, un email o un PDF por el link de carga llega a la cola de su operación, en orden." },
      { title: "El agente decide", text: "El código ya le trae la operación, el legajo y las últimas operaciones del importador; el agente recuerda la conversación de cada importador aunque hable de varias, y responde en un solo paso. Lo que no se negocia está en el código." },
      { title: "Sale por la política de contacto", text: "Cada envío pasa por opt-in, horarios, ventana de 24 horas y cerco de destinatarios antes de salir." },
      { title: "El tiempo trabaja solo", text: "Los hitos se reprograman cuando se mueve la ETA, y el despachante aprueba desde la consola." },
    ]),
  },
  faq: {
    eyebrow: "Preguntas",
    title: "Preguntas frecuentes",
    data: { q: "¿Dónde quedan los documentos de mis importadores y quién los ve?", a: "En AWS, región us-east-1 (Estados Unidos). Antes de guardarse, los datos sensibles (CUIT, DNI, CBU, tarjetas, IBAN) se enmascaran. Ve cada operación solo tu estudio; cada parte recibe únicamente lo que le toca, y el agente trabaja sobre el texto enmascarado." } satisfies Question,
    reader: { q: "¿Y si mi estudio no usa un lector documental?", a: "Legajo listo no lee documentos por su cuenta: cada PDF va a un lector documental a través de un contrato OpenAPI. Si todavía no usás ninguno, lo elegimos juntos y Craftech lo adapta a ese contrato durante el piloto. Lo que el lector no reconoce lo resuelve el despachante." } satisfies Question,
    platform: { q: "¿Cómo se conecta con mi sistema de gestión?", a: "Con un conector por contrato que se adapta a cada estudio: lee los datos de la operación y recibe los cambios de estado como eventos." } satisfies Question,
    whatsapp: { q: "¿Qué necesito para usar WhatsApp?", a: "Un número de empresa propio de tu estudio, plantillas de mensaje aprobadas por el operador del canal y el consentimiento (opt-in) de cada importador. Los mensajes salen por AWS End User Messaging Social y se cobran por uso." } satisfies Question,
    cost: { q: "¿Cuánto cuesta?", a: "Depende del volumen de operaciones de tu estudio y del uso de AWS (turnos del agente, emails y mensajes). Contanos cómo trabajan hoy y armamos el piloto juntos.", cta: "Hablemos" },
    approval: { q: "¿Quién aprueba el legajo?", a: "Siempre una persona: el despachante, desde la consola y con un ingreso reciente. Ninguna herramienta del agente puede aprobar." } satisfies Question,
  },
  gallery: {
    eyebrow: "La consola",
    title: "Todo lo que pasó, con su motivo",
    lead: "Capturas de la consola de Legajo listo.",
    renderNote: "Vista del producto",
    localNote: "Vista del producto",
    placeholderNote: "Imagen provisoria",
  },
  zoom: {
    open: (alt: string): string => `Ampliar imagen: ${alt}`,
    close: "Cerrar",
    previous: "Imagen anterior",
    next: "Imagen siguiente",
    counter: (at: number, of: number): string => `${at} de ${of}`,
    actualSize: "Tamaño real",
  },
  media: MEDIA_ES,
  closing: {
    title: "Tu estudio en Legajo listo, en un minuto",
    lead: "Creá tu cuenta y recorré la operación 4471 de punta a punta, a tu ritmo, con el reloj en tus manos.",
    try: "Probar Legajo listo",
    talkAlt: "o escribinos a sales@craftech.io",
    signIn: "Ya tengo cuenta: ingresar",
    talkTitle: "¿Querés llevarlo a tu estudio?",
    talkLead: "Contanos cómo trabajan hoy y lo vemos juntos.",
    talk: "Hablemos",
  },
  footer: { product: "Legajo listo, de SIDOM · Powered by Craftech", synthetic: "Coordinación de legajos para estudios de despachantes de aduana.", legal: "Legales", privacy: "Privacidad", terms: "Términos", contact: "Contacto", rights: "© 2026 Craftech" },
  phone: {
    simulator: "WhatsApp",
    fictitious: "despachante de aduana",
    glossToggle: "Mostrar la glosa en inglés",
    glossButton: "Glosa en inglés",
    typing: "escribiendo…",
    conversation: (day: string): string => `Conversación de WhatsApp del ${day}`,
    transcript: "Conversación completa",
  },
  email: {
    threadLabel: "Hilo de email con el proveedor",
    from: "De",
    to: "Para",
    subject: "Asunto",
    agent: "Lo escribe el agente",
    simulator: "Respuesta del proveedor",
    when: (ar: string, supplier: string): string => `${ar} en Buenos Aires · ${supplier} en Qingdao`,
  },
  labels: labelsEsAR,
  observation: (code: ObservationCode): string => OBSERVATION_LABELS[code].es,
  kg: (value: number): string => `${formatNumber(value)} kg`,
};

export type LandingCopy = typeof es;
