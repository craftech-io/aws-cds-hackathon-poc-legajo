// Keys of `Documents` for the intake (docs/architecture.md §6): always built by code, never from a
// file name, under the prefix of the operation's world so destroying or resetting it removes them:
// `qa/<runId>/` in a QA run, `guest/<pub|res>/<firmId>/e<epoch>/` in a guest world, nothing elsewhere.
import { type DocType, type GuestKind, documentsKeys, parseClockId, worldKey } from "@legajo/shared";
import { guestWorldPrefix } from "@legajo/shared/document-keys";
import type { Operation } from "../domain/operations";

type WorldOfOperation = Pick<Operation, "clockId" | "firmId" | "worldEpoch" | "runId">;

/** Prefix of every `Documents` key of the operation's world. */
export function documentsPrefixOf(operation: WorldOfOperation, guestKind: GuestKind | undefined): string {
  const scope = parseClockId(operation.clockId)?.scope;
  if (scope === "GUEST") return guestWorldPrefix({ guestKind: guestKind ?? "RESERVED", firmId: operation.firmId, epoch: operation.worldEpoch });
  if (scope === "QA" && operation.runId !== undefined) return worldKey("", operation.runId);
  return "";
}

export const intakeKeys = {
  /** `ops/<operationId>/<docType>/v<nnn>-<sha8>.pdf`: where a version lives while and after it is read. */
  version: (prefix: string, operationId: string, docType: DocType, versionNo: number, sha256: string): string => `${prefix}${documentsKeys.version(operationId, docType, versionNo, sha256)}`,
  /** `unrecognized/<operationId>/<docVersionId>.pdf`: a version waiting for the firm to classify or discard it. */
  unrecognized: (prefix: string, operationId: string, docVersionId: string): string => `${prefix}${documentsKeys.unrecognized(operationId, docVersionId)}`,
} as const;
