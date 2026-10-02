// The handlers `InboundWhatsApp` calls with principal `channel` (channels/whatsapp/ports.ts
// `ChannelServices`): an opt-out by button or keyword (`revoke_consent`) and the importer's decision on
// a proposed contact (`confirm_supplier_contact`). Both go through the direct-handler kit with
// `caller CHANNEL`, so they validate, fence and audit exactly as from the console; a refusal is thrown
// back to the channel, which fails its event and lets it be delivered again.
import type { ChannelServices } from "../../channels/whatsapp/ports";
import { revokeConsentHandler } from "../consent/consent";
import { unwrapDirect } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";
import { confirmSupplierContactHandler } from "./confirm";

export function channelServices(deps: ServiceDeps): ChannelServices {
  const revoke = revokeConsentHandler(deps);
  const confirm = confirmSupplierContactHandler(deps);
  // The firm the channel resolved: every record the handler reaches is fenced to it as well.
  const caller = (firmId: string) => ({ kind: "CHANNEL" as const, firmId });
  return {
    async revokeConsent(input) {
      unwrapDirect(
        await revoke({
          caller: caller(input.firmId),
          importerId: input.importerId,
          clockId: input.clockId,
          channel: { operationIds: [...input.operationIds], messageId: input.messageId, wamid: input.wamid, atSim: input.atSim, via: input.via },
        }),
      );
    },
    async confirmContact(input) {
      unwrapDirect(
        await confirm({
          caller: caller(input.firmId),
          contactId: input.contactId,
          clockId: input.clockId,
          channel: { operationId: input.operationId, importerId: input.importerId, supplierId: input.supplierId, decision: input.decision, messageId: input.messageId, wamid: input.wamid, atSim: input.atSim },
        }),
      );
    },
  };
}
