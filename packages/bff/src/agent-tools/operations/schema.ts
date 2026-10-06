// Target `operations` (`ToolOperations`, docs/tool-catalog.md): what the agent reads about the operation,
// its dossier, its parties, the firm's checklist and the dispatch, plus the one write of the target
// (`assign_responsible`). The zod here is the only source of the Gateway schema of these six tools.
import { DocType, ObservationId, Party } from "@legajo/shared";
import { CONSOLE_CALLERS, boundedText, defineTool } from "../common/define";

/** Who can be asked about: the two outside parties. */
const Counterpart = Party.extract(["IMPORTER", "SUPPLIER"]);

export const OPERATIONS_TOOLS = {
  get_operation: defineTool({
    name: "get_operation",
    description:
      "Reads the operation of this turn: number, the firm's name, importer and supplier, vessel, carrier, regime, port of loading, ETA (etaText), invoice number, incoterm, dossier status, who is in control (AGENT or BROKER), the dispatch status, the simulated now (nowSimText) and otherOperations, the importer's other recent operations (up to ten: the open ones, then the last closed). Read it at the start of every turn and copy dates and numbers from it; never compute them.",
    fields: {},
    callers: ["WORKER", ...CONSOLE_CALLERS],
  }),

  get_dossier: defineTool({
    name: "get_dossier",
    description:
      "Reads the dossier of this operation: which of the three documents are missing, received, with observations or valid, who is responsible for each and who was asked last, every observation with its attempts, the importer's and the supplier's deadlines (text already formatted, the supplier's in its time zone), the next milestone and the open escalations.",
    fields: {},
    callers: ["WORKER", ...CONSOLE_CALLERS],
  }),

  assign_responsible: defineTool({
    name: "assign_responsible",
    description:
      "Decides who corrects an observation of this operation (SUPPLIER, IMPORTER or BROKER) and records why. The firm's responsibility matrix is the reference: a different choice, and every BROKER choice, is flagged for the firm's review.",
    fields: {
      observationId: ObservationId.describe("Id of an observation of this operation, as get_dossier or read_document returned it."),
      responsibleParty: Party.describe("Who corrects it."),
      rationale: boundedText(300, "Why, in one or two sentences, without personal data."),
    },
    callers: [...CONSOLE_CALLERS],
  }),

  get_counterpart_profile: defineTool({
    name: "get_counterpart_profile",
    description:
      "Reads what the firm knows about one party of this operation. IMPORTER: first name, WhatsApp opt-in, whether the 24-hour window is open and until when, whether the agent may write to the supplier, other open operations. SUPPLIER: language, time zone, local time, whether it is within business hours, contacts with masked addresses and their status, and the measured reply profile.",
    fields: {
      party: Counterpart.describe("The party to read."),
    },
    callers: [...CONSOLE_CALLERS],
  }),

  get_checklist: defineTool({
    name: "get_checklist",
    description:
      "Reads the firm's document checklist, the only source to answer the importer's questions about the documents. Whatever its items do not cover is not answered: escalate it with escalate_to_broker (OUT_OF_CHECKLIST).",
    fields: {
      docType: DocType.optional().describe("Only the items of this document; all of them when left out."),
    },
    callers: [...CONSOLE_CALLERS],
  }),

  get_dispatch_status: defineTool({
    name: "get_dispatch_status",
    description:
      "Reads the customs dispatch status of this operation (NONE, OFICIALIZADO, CANAL_ASIGNADO or LIBERADO, with the channel when assigned), when it happened and the firm's generic explanation of it. Never add a prediction of what customs will do.",
    fields: {},
    callers: [...CONSOLE_CALLERS],
  }),
} as const;
