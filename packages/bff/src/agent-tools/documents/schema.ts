// Target `documents` (`ToolDocuments`, docs/tool-catalog.md): the reading of a document version by the
// external reader (ADR-0003: the model never sees a PDF, its name or its metadata) and the importer's
// upload link. The zod here is the only source of the Gateway schema of these two tools.
import { z } from "zod";
import { DocType, DocVersionId } from "@legajo/shared";
import { CONSOLE_CALLERS, defineTool } from "../common/define";

export const DOCUMENTS_TOOLS = {
  read_document: defineTool({
    name: "read_document",
    description:
      "Returns the reading of one document version by the external document reader: its type, the source (party and channel), the reading status (RECOGNIZED, UNRECOGNIZED or ERROR), the fields read and the observations. Never reinterpret a document: use this reading. What the reader did not recognize goes to the firm.",
    fields: {
      docVersionId: DocVersionId.describe("Id of a document version of this operation (dv-…), from the turn envelope or get_dossier."),
    },
    callers: ["WORKER", ...CONSOLE_CALLERS],
  }),

  create_upload_link: defineTool({
    name: "create_upload_link",
    description:
      "Creates the upload link of this operation for its importer (valid 72 real hours), only for documents that are MISSING or have an observation the importer must correct. The link may only be sent to the importer, with send_whatsapp, in this same turn.",
    fields: {
      docTypes: z.array(DocType).min(1).max(3).describe("Documents the importer is asked to upload."),
    },
    callers: ["WORKER", ...CONSOLE_CALLERS],
  }),
} as const;
