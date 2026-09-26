// Writes packages/web/src/views/landing/supplier-replies.json: the two replies of the simulated
// supplier in the landing's story (the PDFs, then the corrected packing list), made by the real texts
// of packages/bff/src/copy/en-supplier-sim.ts. The landing reads this file instead of importing that
// module, which also carries the hostile bodies of the injection behaviour (FL-038): those must never
// ship in the public page. landing.test.ts fails when the file drifts from the module.
//
//   npx tsx scripts/landing/supplier-replies.ts
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supplierSimEn } from "@legajo/bff/copy/en-supplier-sim";
import { CORRECTED, CORRECTION_SUBJECT, REQUESTED, REQUEST_SUBJECT, STORY, type SupplierReplies } from "../../packages/web/src/views/landing/conversations";
import { WEB_DIR } from "./manifest-file";

export const SUPPLIER_REPLIES_PATH = join(WEB_DIR, "src/views/landing/supplier-replies.json");

/** The replies of the story, as the simulator writes them. */
export function supplierReplies(): SupplierReplies {
  const common = { invoiceNumber: STORY.invoiceNumber, supplierName: STORY.supplierName };
  return {
    generatedBy: "scripts/landing/supplier-replies.ts",
    reply: supplierSimEn.documentsAttached({ ...common, subject: REQUEST_SUBJECT, docTypes: REQUESTED }),
    corrected: supplierSimEn.correctedAttached({ ...common, subject: CORRECTION_SUBJECT, docTypes: CORRECTED }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(SUPPLIER_REPLIES_PATH, `${JSON.stringify(supplierReplies(), null, 2)}\n`);
  process.stdout.write(`${SUPPLIER_REPLIES_PATH}\n`);
}
