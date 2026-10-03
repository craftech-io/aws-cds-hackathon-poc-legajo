// Readings of a guest's world that the local UI server has no worker, reader or intake to produce
// (`POST /__test/dossier-fixtures`, packages/web/e2e/dossier.spec.ts FL-042..FL-044): written through the
// real connector with the shapes the intake leaves, in the world's own operations.
//
//   op-4474  a packing list read by the reader with a blocking PACKAGES_MISMATCH (245 expected, 243
//            found) that the agent gave to the importer where the matrix says the supplier: flagged
//            for the firm's review (FL-042) and ready to be waived (FL-043)
//   op-4477  a certificate the reader did not recognize, with its UNRECOGNIZED_DOCUMENT escalation
//            open (FL-044)
//
// Nothing here ships in a Lambda.
import type { Connector } from "@legajo/bff/connector/index";
import type { DocType } from "@legajo/shared";

const RECEIVED_AT_SIM = "2026-10-14T09:00:00-03:00";
const READ_AT_SIM = "2026-10-14T09:01:00-03:00";
const READER_VERSION = "reader-mock-1.0.0";

interface VersionSpec {
  readonly operationId: string;
  readonly clockId: string;
  readonly docType: DocType;
  readonly party: "IMPORTER" | "SUPPLIER";
  readonly channel: "WHATSAPP" | "EMAIL";
  readonly state: "READ" | "UNRECOGNIZED";
  readonly reading: Readonly<Record<string, unknown>>;
  readonly sha256: string;
  readonly document?: { readonly status: "WITH_OBSERVATION"; readonly responsibleParty: "IMPORTER" };
}

async function fileVersion(connector: Connector, spec: VersionSpec): Promise<string> {
  const { version } = await connector.documents.addVersion({
    version: {
      operationId: spec.operationId,
      clockId: spec.clockId,
      docType: spec.docType,
      versionNo: 1,
      s3Key: `ops/${spec.operationId}/${spec.docType}/v001-${spec.sha256.slice(0, 8)}.pdf`,
      sha256: spec.sha256,
      sizeBytes: 48_213,
      source: { party: spec.party, channel: spec.channel },
      receivedAtSim: RECEIVED_AT_SIM,
      state: spec.state,
      reading: spec.reading as never,
      readAtSim: READ_AT_SIM,
      readerAttempts: 1,
    },
    ...(spec.document === undefined ? {} : { document: spec.document }),
  });
  return version.docVersionId;
}

/** op-4474: the packing list with the observation the agent assigned against the matrix. */
async function packingListWithObservation(connector: Connector, operationId: string, clockId: string): Promise<void> {
  const docVersionId = await fileVersion(connector, {
    operationId,
    clockId,
    docType: "PACKING_LIST",
    party: "IMPORTER",
    channel: "WHATSAPP",
    state: "READ",
    sha256: "4474".repeat(16),
    reading: {
      readingId: `rdg-fixture-${operationId}-PL-1`,
      status: "RECOGNIZED",
      docType: "PACKING_LIST",
      matchedBy: "SHA256",
      confidence: 0.95,
      pages: 1,
      language: "en",
      fields: { packages: 243 },
      observations: [{ code: "PACKAGES_MISMATCH", severity: "BLOCKING", field: "packages", expected: "245", found: "243", againstDocType: "COMMERCIAL_INVOICE" }],
      readerVersion: READER_VERSION,
    },
    document: { status: "WITH_OBSERVATION", responsibleParty: "IMPORTER" },
  });
  const observation = await connector.documents.createObservation({
    observationId: `obs-${operationId.replace(/^op-/, "")}-PL-PACKAGES_MISMATCH`,
    operationId,
    clockId,
    docType: "PACKING_LIST",
    code: "PACKAGES_MISMATCH",
    severity: "BLOCKING",
    field: "packages",
    expected: "245",
    found: "243",
    againstDocType: "COMMERCIAL_INVOICE",
    status: "OPEN",
    firstDocVersionId: docVersionId,
    lastDocVersionId: docVersionId,
    created: { atSim: READ_AT_SIM, by: "SYSTEM" },
  });
  await connector.documents.updateObservation(operationId, observation.observationId, { responsibleParty: "IMPORTER", matrixDefault: "SUPPLIER", matchesMatrix: false, flaggedForReview: true }, observation.version);
}

/** op-4477: the certificate the reader did not recognize, escalated to the firm. */
async function unrecognizedCertificate(connector: Connector, operationId: string, clockId: string, firmId: string): Promise<void> {
  const docVersionId = await fileVersion(connector, {
    operationId,
    clockId,
    docType: "CERTIFICATE_OF_ORIGIN",
    party: "SUPPLIER",
    channel: "EMAIL",
    state: "UNRECOGNIZED",
    sha256: "4477".repeat(16),
    reading: { readingId: `rdg-fixture-${operationId}-CO-1`, status: "UNRECOGNIZED", pages: 1, readerVersion: READER_VERSION },
  });
  await connector.operations.openEscalation({
    operationId,
    firmId,
    clockId,
    reason: "UNRECOGNIZED_DOCUMENT",
    summary: "El lector no reconoció un documento recibido: lo revisa el estudio.",
    openedAtSim: READ_AT_SIM,
    openedBy: "SYSTEM",
    emailSent: false,
    notifyImporter: false,
    docVersionId,
  });
}

/** Writes both fixtures in the world of `firmId`; its operations carry the world's id tag. */
export async function writeDossierFixtures(connector: Connector, world: { readonly firmId: string; readonly clockId: string }): Promise<void> {
  const operations = await connector.operations.listOperations(world.firmId, { clockId: world.clockId });
  const byNumber = (number: string) => {
    const operation = operations.find((candidate) => candidate.operationNumber === number);
    if (operation === undefined) throw new RangeError(`the world of ${world.firmId} has no operation ${number}`);
    return operation.operationId;
  };
  await packingListWithObservation(connector, byNumber("4474"), world.clockId);
  await unrecognizedCertificate(connector, byNumber("4477"), world.clockId, world.firmId);
}
