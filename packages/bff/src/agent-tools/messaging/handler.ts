// Implementations of the `messaging` tools behind `createToolHandler` (docs/tool-catalog.md, target
// `messaging`): the only ways the agent speaks (ADR-0011). Every one goes through the outbound pipeline
// (outbound/); the ports come from the Lambda entry (index.ts) or from the tests.
import type { Implementations } from "../common/context";
import { proposeSupplierContact } from "./propose-contact";
import { routeToOperation } from "./route-operation";
import type { MESSAGING_TOOLS } from "./schema";
import { type MessagingPorts, sendEmail, sendWhatsApp } from "./send";

export type { MessagingPorts } from "./send";

export function messagingImplementations(ports: MessagingPorts): Implementations<typeof MESSAGING_TOOLS> {
  return {
    send_whatsapp: sendWhatsApp(ports),
    send_email: sendEmail(ports),
    propose_supplier_contact: proposeSupplierContact(ports),
    route_to_operation: routeToOperation(),
  };
}
