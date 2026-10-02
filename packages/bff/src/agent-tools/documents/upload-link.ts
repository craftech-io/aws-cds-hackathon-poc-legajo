// `create_upload_link` (docs/tool-catalog.md, docs/architecture.md §11, FL-009): the importer's upload
// link `Runtime/LINK#<token>` of the turn's operation. 72 real hours, one importer, one operation, and
// only documents the importer can bring: MISSING ones, or ones WITH_OBSERVATION whose open blocking
// observation the importer corrects. A request naming anything else is refused whole, so the link the
// model sends never asks for something nobody expects from the importer. The URL may only leave by
// `send_whatsapp` to the session's importer (the outbound pipeline checks it against this result).
import { DocType, fail, ok } from "@legajo/shared";
import { uploadLinkUrl } from "../../copy/templates";
import { type Document, type Observation, isBlocking } from "../../domain/documents";
import { RUNTIME_TTL_SECONDS } from "../../domain/runtime";
import type { ToolImplementation } from "../common/context";
import type { ToolInput } from "../common/define";
import { textAr } from "../operations/time-text";
import type { DocumentToolPorts } from "./ports";
import type { DOCUMENTS_TOOLS } from "./schema";

type Input = ToolInput<(typeof DOCUMENTS_TOOLS)["create_upload_link"]>;

/** Whether the importer is the one to bring this document now. */
export function importerCanUpload(document: Pick<Document, "status" | "responsibleParty">, observations: readonly Pick<Observation, "docType" | "severity" | "status" | "responsibleParty">[], docType: DocType): boolean {
  if (document.status === "MISSING") return true;
  if (document.status !== "WITH_OBSERVATION") return false;
  const blocking = observations.filter((observation) => observation.docType === docType && isBlocking(observation));
  return blocking.length > 0 ? blocking.some((observation) => observation.responsibleParty === "IMPORTER") : document.responsibleParty === "IMPORTER";
}

export function createUploadLink(ports: DocumentToolPorts): ToolImplementation<Input> {
  return async (ctx) => {
    const { connector, scope, input } = ctx;
    const operation = await connector.operations.getOperation(scope.operationId);
    if (operation.dossierStatus === "APPROVED") return fail("CONFLICT", "the dossier is approved; nothing is uploaded to it");
    const [documents, observations] = await Promise.all([connector.documents.listDocuments(scope.operationId), connector.documents.listObservations(scope.operationId)]);
    const requested = DocType.options.filter((docType) => input.docTypes.includes(docType));
    const refused = requested.filter((docType) => {
      const document = documents.find((candidate) => candidate.docType === docType);
      return document === undefined || !importerCanUpload(document, observations, docType);
    });
    if (refused.length > 0) {
      await ctx.audit({ decision: "DENY", action: "UPLOAD_LINK_CREATED", reason: "NOT_FOR_IMPORTER", detail: { requested, refused } });
      return fail("CONFLICT", `not for the importer to upload now: ${refused.join(", ")}`);
    }
    const now = ctx.wallClock();
    const expires = new Date(now.getTime() + RUNTIME_TTL_SECONDS.link * 1000);
    const link = await connector.runtime.putUploadLink({
      token: ports.newToken(),
      operationId: scope.operationId,
      importerId: scope.importerId,
      firmId: scope.firmId,
      clockId: scope.clockId,
      docTypes: requested,
      createdAtReal: now.toISOString(),
      expiresAtReal: expires.toISOString(),
      ...(ctx.principal.kind === "SESSION" ? { turnId: ctx.principal.turnId } : {}),
    });
    // The token is a bearer secret: the audit keeps what the link is for, never the token itself.
    await ctx.audit({ decision: "ACTION", action: "UPLOAD_LINK_CREATED", detail: { docTypes: requested, expiresAtReal: link.expiresAtReal } });
    return ok({ url: uploadLinkUrl(link.token), token: link.token, expiresAtText: textAr(expires) });
  };
}
