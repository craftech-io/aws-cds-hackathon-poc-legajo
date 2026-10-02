// Every direct-invocation handler of docs/tool-catalog.md this package implements, by its catalog name:
// what `Bff` and the `QaDriver` import for the console procedures (through the real `appRouter`), what
// the worker wires into `EventHandlers` and `TimerActions`, and what `InboundWhatsApp` calls through
// `channelServices`. None of them is deployed behind the Gateway.
import { classifyUnrecognizedHandler } from "../dossier-actions/classify";
import { approveDossierHandler, reopenDossierHandler } from "../dossier-actions/approval";
import { waiveObservationHandler } from "../dossier-actions/waive";
import { authorizeSupplierContactHandler } from "../consent/authorization";
import { recordConsentHandler, revokeConsentHandler } from "../consent/consent";
import { confirmSupplierContactHandler } from "../contacts/confirm";
import { upsertPartyHandler } from "../contacts/upsert-party";
import { verifySenderHandler } from "../contacts/verify-sender";
import { brokerSendHandler } from "../conversation-control/broker-send";
import { releaseConversationHandler, takeConversationHandler } from "../conversation-control/control";
import { deferredSendHandler } from "../conversation-control/deferred-send";
import { applyEmailEventHandler } from "../conversation-control/email-event";
import { createOperationHandler } from "./create-operation";
import type { DirectHandler, DirectHandlerName } from "./handler-kit";
import type { ServiceDeps } from "./ports";
import { recordActivityHandler } from "./record-activity";

export type DirectHandlers = { readonly [N in DirectHandlerName]: DirectHandler };

export function directHandlers(deps: ServiceDeps): DirectHandlers {
  return {
    verify_sender: verifySenderHandler(deps),
    record_consent: recordConsentHandler(deps),
    revoke_consent: revokeConsentHandler(deps),
    authorize_supplier_contact: authorizeSupplierContactHandler(deps),
    confirm_supplier_contact: confirmSupplierContactHandler(deps),
    upsert_party: upsertPartyHandler(deps),
    create_operation: createOperationHandler(deps),
    approve_dossier: approveDossierHandler(deps),
    reopen_dossier: reopenDossierHandler(deps),
    waive_observation: waiveObservationHandler(deps),
    classify_unrecognized: classifyUnrecognizedHandler(deps),
    take_conversation: takeConversationHandler(deps),
    release_conversation: releaseConversationHandler(deps),
    broker_send: brokerSendHandler(deps),
    apply_email_event: applyEmailEventHandler(deps),
    deferred_send: deferredSendHandler(deps),
    record_activity: recordActivityHandler(deps),
  };
}
