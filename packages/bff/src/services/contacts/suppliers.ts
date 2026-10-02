// The supplier side of `upsert_party` (docs/tool-catalog.md, FL-004): a new supplier of the caller's
// world (time zone, English, `PROMPT` until the firm picks a simulated behaviour) with the contacts the
// firm registers, an edit of one of the firm's suppliers, or one more contact of a supplier. A contact
// the firm registers is `ACTIVE` with `confirmedBy BROKER`, its address claimed in the same transaction
// (`ADDR#<emailHash>`). Every address of the request is checked first (shape, world rules, the SES
// client's `SYSTEM` fence, a claim held by anyone else): one refusal and nothing is written.
import { type ContactUpsertInput, ToolError, type SupplierUpsertInput, maskEmail } from "@legajo/shared";
import type { z } from "zod";
import type { SupplierPatch } from "../../connector/ports";
import type { Supplier, SupplierContact } from "../../domain/parties";
import { isValidTimeZone } from "../business-hours";
import type { DirectContext } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";
import { registryWorld } from "../operations-admin/world-scope";
import { checkPartyEmail, fenceContact } from "./address-rules";

type SupplierData = z.output<typeof SupplierUpsertInput>;
type ContactData = z.output<typeof ContactUpsertInput>;

/** A refusal of the recipient fence: the rule the audit cites with it. */
export class FenceRefusal extends ToolError {
  constructor(readonly fenceReason: string) {
    super("RECIPIENT_NOT_ALLOWED", "that address is outside the recipient fence of the demo", "RECIPIENT_NOT_ALLOWED");
  }
}

export function contactView(contact: SupplierContact) {
  return {
    contactId: contact.contactId,
    supplierId: contact.supplierId,
    emailMasked: maskEmail(contact.email),
    status: contact.status,
    ...(contact.confirmedBy === undefined ? {} : { confirmedBy: contact.confirmedBy }),
  };
}

export function supplierView(supplier: Supplier) {
  return { supplierId: supplier.supplierId, clockId: supplier.clockId, name: supplier.name, country: supplier.country, timezone: supplier.timezone, language: supplier.language, behaviour: supplier.behaviour };
}

function checkTimezone(timezone: string): void {
  if (!isValidTimeZone(timezone)) throw new ToolError("INVALID", "unknown IANA time zone", "TIMEZONE_INVALID");
}

interface CheckedContact {
  readonly email: string;
  readonly emailHash: string;
}

/** Every new address of a supplier, checked whole before anything is written. */
async function checkContacts(deps: ServiceDeps, emails: readonly string[], clockId: string): Promise<CheckedContact[]> {
  const checked: CheckedContact[] = [];
  for (const raw of new Set(emails)) {
    const { address } = checkPartyEmail(raw, clockId);
    const fence = await fenceContact(deps, address, clockId);
    if (!fence.allowed) throw new FenceRefusal(fence.reason);
    const emailHash = deps.keys.emailHash(address);
    if ((await deps.connector.parties.getAddressClaim(emailHash)) !== undefined) throw new ToolError("CONFLICT", "that email already belongs to another contact or firm", "CONFLICT");
    checked.push({ email: address, emailHash });
  }
  return checked;
}

async function registerContacts(ctx: DirectContext<unknown>, deps: ServiceDeps, supplier: Supplier, contacts: readonly CheckedContact[], atSim: string): Promise<SupplierContact[]> {
  const created: SupplierContact[] = [];
  for (const contact of contacts) {
    created.push(
      await ctx.connector.parties.createContact({
        contactId: `ctc-${deps.newId().toLowerCase()}`,
        supplierId: supplier.supplierId,
        firmId: supplier.firmId,
        clockId: supplier.clockId,
        email: contact.email,
        emailHash: contact.emailHash,
        status: "ACTIVE",
        confirmedBy: "BROKER",
        confirmedAt: atSim,
        created: { atSim, atReal: ctx.now().toISOString(), by: ctx.actor },
      }),
    );
  }
  return created;
}

async function ownSupplier(ctx: DirectContext<unknown>, supplierId: string, clockId: string | undefined): Promise<Supplier> {
  const supplier = await ctx.connector.parties.getSupplier(supplierId);
  await ctx.fence(supplier.firmId, { kind: "supplier", id: supplier.supplierId });
  if (clockId !== undefined && clockId !== supplier.clockId) throw new ToolError("INVALID", "the supplier is not of the world named", "WORLD_MISMATCH");
  return supplier;
}

export interface SupplierUpsert {
  readonly supplier: Supplier;
  readonly created: boolean;
  /** The contacts this call registered. */
  readonly contacts: readonly SupplierContact[];
  /** The contact the supplier already had with that address (`upsertContact` only). */
  readonly existing?: SupplierContact;
}

export async function upsertSupplier(ctx: DirectContext<unknown>, deps: ServiceDeps, firmId: string, data: SupplierData): Promise<SupplierUpsert> {
  const { parties } = ctx.connector;
  checkTimezone(data.timezone);
  if (data.supplierId === undefined) {
    const clockId = await registryWorld(ctx, firmId, data.clockId);
    const contacts = await checkContacts(deps, data.contacts ?? [], clockId);
    const world = await ctx.world(clockId);
    const supplier = await parties.createSupplier({
      supplierId: `sup-${deps.newId().toLowerCase()}`,
      firmId,
      clockId,
      name: data.name,
      country: data.country,
      timezone: data.timezone,
      language: data.language,
      behaviour: "PROMPT",
      behaviourParams: {},
    });
    return { supplier, created: true, contacts: await registerContacts(ctx, deps, supplier, contacts, world.atSim) };
  }
  const current = await ownSupplier(ctx, data.supplierId, data.clockId);
  const known = new Set((await parties.listContacts(current.supplierId)).map((contact) => contact.email));
  const contacts = await checkContacts(deps, (data.contacts ?? []).filter((email) => !known.has(email)), current.clockId);
  const patch: SupplierPatch = { name: data.name, country: data.country, timezone: data.timezone, language: data.language };
  const supplier = await parties.updateSupplier(current.supplierId, patch, current.version);
  const world = await ctx.world(supplier.clockId);
  return { supplier, created: false, contacts: await registerContacts(ctx, deps, supplier, contacts, world.atSim) };
}

/** One more contact of a supplier; registering an address the supplier already has changes nothing. */
export async function upsertContact(ctx: DirectContext<unknown>, deps: ServiceDeps, data: ContactData): Promise<SupplierUpsert> {
  const supplier = await ownSupplier(ctx, data.supplierId, data.clockId);
  const existing = (await ctx.connector.parties.listContacts(supplier.supplierId)).find((contact) => contact.email === data.email);
  if (existing !== undefined) return { supplier, created: false, contacts: [], existing };
  const contacts = await checkContacts(deps, [data.email], supplier.clockId);
  const world = await ctx.world(supplier.clockId);
  return { supplier, created: false, contacts: await registerContacts(ctx, deps, supplier, contacts, world.atSim) };
}
