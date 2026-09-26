// The reader client and the source-URL signer of a Lambda, wired from what SST links into it
// (through lib/resource.ts, never `process.env`):
//
//   ReaderMock   `url`: the reader's Function URL (the functions with capability `MOCK_READER`)
//   Documents    the bucket whose objects the reader downloads through pre-signed GETs
//
// One instance per container, reused across invocations.
import { z } from "zod";
import { bucketName, readLinked } from "../lib/resource";
import { createReaderClient, type ReaderClient } from "./client";
import { sigV4Signer } from "./signer";
import { createSourceUrlSigner, type SourceUrlSigner } from "./source-url";

const ReaderLink = z.object({ url: z.url() });

let client: ReaderClient | undefined;
let sourceUrlSigner: SourceUrlSigner | undefined;

export function linkedReaderClient(): ReaderClient {
  client ??= createReaderClient({ endpoint: readLinked("ReaderMock", ReaderLink).url, sign: sigV4Signer() });
  return client;
}

export function linkedSourceUrlSigner(): SourceUrlSigner {
  sourceUrlSigner ??= createSourceUrlSigner({ bucket: bucketName("Documents") });
  return sourceUrlSigner;
}
