// The stage's side of the SC-26 actions (signup-actions.ts): the raw MIME of the `sim` route of the mail
// bucket (`Resource.InboundMailSim`: bucket name and prefix, `s3:ListBucket` and `s3:GetObject` on that
// prefix only, infra/leads.ts `qaSignupMail`), and the stores of the sign-up and of `npm run
// leads:delete` over the connector's table client, the pool (`Resource.Auth`), `WorldJanitor` (linked)
// and the `lead-email` subkey. Clients are built on first use; every call has its deadline.
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { authConfig } from "../auth/config";
import { MAIL_STORE_TIMEOUTS, MAX_RAW_MAIL_BYTES, SES_REGION } from "../channels/email/config";
import { PrefixedBucket } from "../channels/email/store";
import { tableClient } from "../connector/index";
import { awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { subkey } from "../lib/secrets";
import { createLeadStore } from "../leads/store";
import { INBOUND_MAIL_SIM_LINK } from "../sim-mail/config";
import { createSignupCognito } from "../signup/cognito";
import { lambdaAsyncInvoker } from "../signup/invoke";
import { createSignupStore } from "../signup/store";
import type { AccountMailReader, SignupActionDeps } from "./signup-actions";

/** Objects a single `signup.readCode` poll looks at, at most (the route's lifecycle keeps it small). */
export const MAX_LISTED_OBJECTS = 5_000;

export interface S3AccountMailOptions {
  readonly bucket?: () => PrefixedBucket;
  readonly client?: Pick<S3Client, "send">;
}

export function s3AccountMail(options: S3AccountMailOptions = {}): AccountMailReader {
  const bucket = options.bucket ?? (() => readLinked(INBOUND_MAIL_SIM_LINK, PrefixedBucket));
  let client = options.client;
  const s3 = (): Pick<S3Client, "send"> => (client ??= new S3Client({ region: SES_REGION, ...awsClientConfig(MAIL_STORE_TIMEOUTS) }));
  return {
    async listSince(since) {
      const { name, prefix } = bucket();
      const found: Array<{ key: string; at: Date }> = [];
      let token: string | undefined;
      let listed = 0;
      do {
        const page = await s3().send(new ListObjectsV2Command({ Bucket: name, Prefix: prefix, ...(token === undefined ? {} : { ContinuationToken: token }) }));
        for (const object of page.Contents ?? []) {
          listed += 1;
          if (object.Key !== undefined && object.LastModified !== undefined && object.LastModified.getTime() >= since.getTime()) found.push({ key: object.Key, at: object.LastModified });
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined && listed < MAX_LISTED_OBJECTS);
      return found.sort((a, b) => a.at.getTime() - b.at.getTime());
    },
    async read(key) {
      const { name, prefix } = bucket();
      if (!key.startsWith(prefix)) throw new RangeError("only the sim route of the mail bucket");
      const object = await s3().send(new GetObjectCommand({ Bucket: name, Key: key }));
      if (object.ContentLength !== undefined && object.ContentLength > MAX_RAW_MAIL_BYTES) throw new RangeError("the mail is larger than any account email");
      const bytes = await object.Body?.transformToByteArray();
      if (bytes === undefined) throw new RangeError("the mail has no body");
      return bytes;
    },
  };
}

/** The SC-26 actions' ports of the stage, built on first use. */
export function stageSignupActionDeps(): () => SignupActionDeps {
  let deps: SignupActionDeps | undefined;
  return () => {
    if (deps !== undefined) return deps;
    const client = tableClient();
    deps = {
      mail: s3AccountMail(),
      client,
      leads: createLeadStore(client),
      signups: createSignupStore(client),
      cognito: createSignupCognito(authConfig()),
      invoker: lambdaAsyncInvoker(),
      leadEmailKey: subkey("lead-email"),
    };
    return deps;
  };
}
