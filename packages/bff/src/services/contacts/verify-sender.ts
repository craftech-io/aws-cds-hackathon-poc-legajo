// `verify_sender` (docs/tool-catalog.md; docs/architecture.md §13; FL-035, FL-093): who wrote, decided
// outside the model and without writing anything but the refusal's audit row.
//
//   WHATSAPP  the keyed hash of the phone → the one importer that holds it (`Parties GSI1`, unique by
//             `ADDR#`); none is `UNKNOWN_SENDER`, two are an audited error (`IDENTITY_AMBIGUOUS`), never
//             an identity.
//   EMAIL     the operation's thread address (its HMAC tag verified, the world not tombstoned) + an
//             `ACTIVE` contact of that operation's supplier with exactly that address + `dmarcVerdict
//             PASS`; never a branch by DKIM nor a `d=` read from the headers. A thread that does not
//             resolve is `UNKNOWN_SENDER`; anything else is `UNTRUSTED_SENDER` (`DENY` in the
//             operation's firm, with the contact's status and the verdict, never the address).
import { z } from "zod";
import { E164Phone } from "@legajo/shared";
import { parseReceivedAddress } from "../../channels/email/address";
import { resolveThread } from "../../channels/email/thread";
import { createDirectHandler } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";

const Verdict = z.enum(["PASS", "FAIL", "GRAY", "PROCESSING_FAILED"]);

export const VerifySenderInput = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("WHATSAPP"), phoneE164: E164Phone }).strict(),
  z
    .object({
      channel: z.literal("EMAIL"),
      /** The one recipient of the mail: an operation's thread address. */
      to: z.string().min(3).max(320),
      /** The single author SES and the MIME agree on; absent when there is none. */
      from: z.string().min(3).max(320).optional(),
      dmarcVerdict: Verdict,
    })
    .strict(),
]);

export type SenderIdentity =
  | { readonly identity: "IMPORTER"; readonly importerId: string; readonly firmId: string; readonly clockId: string }
  | { readonly identity: "SUPPLIER"; readonly operationId: string; readonly supplierId: string; readonly contactId: string; readonly firmId: string; readonly clockId: string }
  | { readonly identity: "NONE"; readonly reason: "UNKNOWN_SENDER" | "UNTRUSTED_SENDER" | "IDENTITY_AMBIGUOUS"; readonly operationId?: string };

export function verifySenderHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "verify_sender",
      input: VerifySenderInput,
      callers: ["CHANNEL"],
      async run(ctx): Promise<SenderIdentity> {
        const { input } = ctx;
        const { parties, operations, world } = ctx.connector;
        if (input.channel === "WHATSAPP") {
          const found = await parties.findImporterByPhoneHash(deps.keys.phoneHash(input.phoneE164));
          if (found.status === "UNIQUE") return { identity: "IMPORTER", importerId: found.value.importerId, firmId: found.value.firmId, clockId: found.value.clockId };
          if (found.status === "NONE") return { identity: "NONE", reason: "UNKNOWN_SENDER" };
          for (const importerId of found.ids) {
            const importer = await parties.findImporter(importerId);
            if (importer !== undefined) await ctx.audit({ firmId: importer.firmId, decision: "DENY", action: "IDENTITY_AMBIGUOUS", clockId: importer.clockId, refs: { importerId } });
          }
          return { identity: "NONE", reason: "IDENTITY_AMBIGUOUS" };
        }

        const to = parseReceivedAddress(input.to);
        const resolution = to.ok ? await resolveThread({ operations, world, threadKey: deps.keys.threadKey(), now: deps.wallClock }, to.value.address) : { status: "NOT_THREAD" as const };
        if (resolution.status !== "RESOLVED") return { identity: "NONE", reason: "UNKNOWN_SENDER" };
        const { operation } = resolution;
        const from = input.from === undefined ? undefined : parseReceivedAddress(input.from);
        const author = from?.ok === true ? from.value.address : undefined;
        const contact = author === undefined ? undefined : (await parties.listContacts(operation.supplierId)).find((candidate) => candidate.email === author);
        const dmarcPass = input.dmarcVerdict === "PASS";
        if (dmarcPass && contact?.status === "ACTIVE") {
          return { identity: "SUPPLIER", operationId: operation.operationId, supplierId: operation.supplierId, contactId: contact.contactId, firmId: operation.firmId, clockId: operation.clockId };
        }
        const { atSim } = await ctx.world(operation.clockId);
        await ctx.audit({
          firmId: operation.firmId,
          decision: "DENY",
          action: "UNTRUSTED_SENDER",
          clockId: operation.clockId,
          operationId: operation.operationId,
          atSim,
          reason: author === undefined ? "the mail names no single author" : dmarcPass ? "the sender is not an ACTIVE contact of the operation's supplier" : "dmarcVerdict is not PASS",
          refs: contact === undefined ? {} : { contactId: contact.contactId },
          detail: { dmarcVerdict: input.dmarcVerdict, contactStatus: contact?.status ?? "NONE" },
        });
        return { identity: "NONE", reason: "UNTRUSTED_SENDER", operationId: operation.operationId };
      },
    },
    deps,
  );
}
