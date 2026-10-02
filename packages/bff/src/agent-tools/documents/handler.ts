// Implementations of the `documents` tools behind `createToolHandler` (docs/tool-catalog.md, target
// `documents`): the reader's reading of a version and the importer's upload link.
import type { Implementations } from "../common/context";
import type { DocumentToolPorts } from "./ports";
import { readDocument } from "./read-document";
import type { DOCUMENTS_TOOLS } from "./schema";
import { createUploadLink } from "./upload-link";

export function documentsImplementations(ports: DocumentToolPorts): Implementations<typeof DOCUMENTS_TOOLS> {
  return {
    read_document: readDocument(ports),
    create_upload_link: createUploadLink(ports),
  };
}
