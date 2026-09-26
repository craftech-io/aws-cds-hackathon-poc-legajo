// Every synthetic PDF of the seed (docs/seed-spec.md §8): v1 of the three documents of the 30
// operations, the versions the seeded errors need, and the three documents the reader does not know.
// Paths are the local ones of `scripts/seed/pdfs/`; the loader uploads them to `Seed/pdfs/…`.
import { createHash } from "node:crypto";
import { writePdf } from "../lib/pdf";
import { OPERATIONS } from "./catalog-operations";
import { operationVersions, type DocVersion } from "./documents";
import { unknownPdfs, versionPdf } from "./pdf-content";

export interface PdfArtifact {
  /** Relative to `scripts/seed/pdfs/`: `op-4471/PACKING_LIST-v1.pdf`, `unknown/unknown-1.pdf`. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** The version it is (absent for the unknown documents). */
  readonly version?: DocVersion;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function buildPdfs(): PdfArtifact[] {
  const known = OPERATIONS.flatMap(operationVersions).map((version): PdfArtifact => {
    const bytes = writePdf(versionPdf(version));
    return { path: `${version.truth.operationId}/${version.docType}-v${version.versionNo}.pdf`, bytes, sha256: sha256(bytes), version };
  });
  const unknown = unknownPdfs().map((spec, index): PdfArtifact => {
    const bytes = writePdf(spec);
    return { path: `unknown/unknown-${index + 1}.pdf`, bytes, sha256: sha256(bytes) };
  });
  return [...known, ...unknown];
}
