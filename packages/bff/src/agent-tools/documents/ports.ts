// What the `documents` tools need besides the connector: the one reader client and the pre-signed GET
// it downloads a version with (`ToolDocuments` reads `Documents` and invokes `ReaderMock`,
// docs/architecture.md §14), and the source of upload-link tokens. Production ports are resolved on
// the first call that needs them, so building the target never reads `Resource`.
import { newPublicToken } from "../../lib/crypto";
import type { ReaderClient } from "../../reader/client";
import { linkedReaderClient, linkedSourceUrlSigner } from "../../reader/linked";

export interface DocumentToolPorts {
  readonly reader: () => Pick<ReaderClient, "createReading">;
  /** 5-minute GET of a `Documents` key for the reader (reader/source-url.ts). */
  readonly sourceUrl: (key: string) => Promise<string>;
  /** A fresh 32-byte base64url token (docs/architecture.md §11). */
  readonly newToken: () => string;
}

export function productionDocumentPorts(): DocumentToolPorts {
  return {
    reader: linkedReaderClient,
    sourceUrl: (key) => linkedSourceUrlSigner()(key),
    newToken: () => newPublicToken(),
  };
}
