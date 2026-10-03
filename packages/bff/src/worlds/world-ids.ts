// Names of the worlds the factory writes (docs/seed-spec.md §2, §3 and §14, ADR-0015 §4):
//
//   guest slot nn      firm `firm-guest-<nn>`, clock `GUEST#firm-guest-<nn>`, broker `brk-guest-<nn>`,
//                      tag `g<nn>` on every id of the template (`op-4471-g03`, `imp-norpampa-g03`), phones
//                      `+54 9 11 5551 <nn>xx`, mailboxes `g<nn>-<code>@sim…` and `estudio-g<nn>@sim…`
//   guest-test         firm `firm-guest-test`, tag `gtest`, the template's own `00` block of phones and
//                      mailboxes (no slot uses 00), items stamped `world: qa` (docs/seed-spec.md §14)
//   QA run             clock `qa-<runId>-<scenario>`; per operation key: importer `imp-qa-<runId>-<scenario>-<key>`,
//                      supplier `sup-qa-…-<key>`, mailbox `qa-<runId>-<scenario>-<key>-<code>@sim…`
//
// The `guest` template keeps the `00` markers its `placeholders` declare; everything here derives
// from the firm id, so a slot's world is the same whoever leases it (only its epoch changes).
import { GUEST_SLOTS } from "@legajo/shared/guest-limits";
import { type GuestKind, guestClockId } from "@legajo/shared";
import { slotOfFirm } from "./guest-slots";
import type { Renames } from "./instantiate";
import type { WorldTemplate } from "./template";

export const GUEST_TEST_FIRM = "firm-guest-test";
/** The template's marker: firm, clock, broker, phones and mailboxes of slot `00`. */
export const TEMPLATE_SLOT = "00";
/** Importers of `GLOBAL#firm-qa` (`qa-min`): `imp-qa-firmqa-min-<key>`. */
export const QA_MIN_IMPORTER_PREFIX = "imp-qa-firmqa-min-";

const pad = (nn: number): string => String(nn).padStart(2, "0");

/** The two digits of a guest firm's slot, or `undefined` (`firm-guest-test`, any other firm). */
export const guestSlotOf = slotOfFirm;

/** Tag of a guest world's ids: `g03` for slot 03, `gtest` for the synthetic account's world. */
export function guestTagOf(firmId: string): string {
  const nn = guestSlotOf(firmId);
  if (nn !== undefined) return `g${pad(nn)}`;
  if (firmId === GUEST_TEST_FIRM) return "gtest";
  throw new RangeError(`${firmId} is not a guest firm`);
}

export interface GuestIdentity {
  readonly firmId: string;
  readonly clockId: string;
  readonly nn?: number;
  readonly tag: string;
  readonly brokerId: string;
  readonly guestKind: GuestKind;
  /** `qa` for `guest-test` (its world is restored, never expires), `guest` otherwise. */
  readonly world: "qa" | "guest";
  /** Two digits of the phone block and of the mailboxes (`00` for `guest-test`). */
  readonly block: string;
}

export function guestIdentity(firmId: string): GuestIdentity {
  const nn = guestSlotOf(firmId);
  if (nn === undefined && firmId !== GUEST_TEST_FIRM) throw new RangeError(`${firmId} is not a guest firm`);
  const isPublic = nn !== undefined && nn >= GUEST_SLOTS.public.first && nn <= GUEST_SLOTS.public.last;
  if (nn !== undefined && !isPublic && (nn < GUEST_SLOTS.reserved.first || nn > GUEST_SLOTS.reserved.last)) throw new RangeError(`slot ${pad(nn)} is not a guest slot`);
  return {
    firmId,
    clockId: guestClockId(firmId),
    ...(nn === undefined ? {} : { nn }),
    tag: guestTagOf(firmId),
    brokerId: nn === undefined ? "brk-guest-test" : `brk-guest-${pad(nn)}`,
    guestKind: isPublic ? "PUBLIC" : "RESERVED",
    world: nn === undefined ? "qa" : "guest",
    block: nn === undefined ? TEMPLATE_SLOT : pad(nn),
  };
}

/** Every id of a template's entities, by the field that names it. */
function templateIds(template: WorldTemplate): { operations: string[]; importers: string[]; suppliers: string[]; contacts: string[]; messages: string[] } {
  const all = Object.values(template.items).flat();
  const of = (entity: string, field: string): string[] => [...new Set(all.filter((item) => item.entity === entity).map((item) => String(item[field])))];
  return {
    operations: of("Operation", "operationId"),
    importers: of("Importer", "importerId"),
    suppliers: of("Supplier", "supplierId"),
    contacts: of("SupplierContact", "contactId"),
    messages: of("Message", "messageId"),
  };
}

/** Exact renames that append `tag` to every id of the template (`op-4471` → `op-4471-g03`). */
export function taggedIds(template: WorldTemplate, tag: string): Map<string, string> {
  const ids = templateIds(template);
  const exact = new Map<string, string>();
  for (const id of [...ids.operations, ...ids.importers, ...ids.suppliers, ...ids.contacts]) exact.set(id, `${id}-${tag}`);
  // Message ids are `msg-<alphanumerics>`: the tag joins without a hyphen.
  for (const id of ids.messages) exact.set(id, `${id}${tag}`);
  return exact;
}

/** Composite ids that embed an operation number take the tag after it (`dv-4471-CI-1` → `dv-4471-g03-CI-1`). */
export function taggedPatterns(tag: string): Array<readonly [RegExp, string]> {
  return [
    [/^dv-(\d{4})-(CI|PL|CO)-/, `dv-$1-${tag}-$2-`],
    [/^obs-(\d{4})-(CI|PL|CO)-/, `obs-$1-${tag}-$2-`],
  ];
}

/** The renames of the `guest` template for one guest firm. */
export function guestRenames(template: WorldTemplate, identity: GuestIdentity): Renames {
  const markers = template.placeholders ?? {};
  const templateFirm = markers.firmId ?? `firm-guest-${TEMPLATE_SLOT}`;
  const templateBroker = markers.brokerId ?? `brk-guest-${TEMPLATE_SLOT}`;
  const mailboxTag = markers.mailboxTag ?? `g${TEMPLATE_SLOT}`;
  const phonePrefix = markers.phonePrefix ?? `+549115551${TEMPLATE_SLOT}`;
  const substrings: Array<readonly [string, string]> = [
    [templateFirm, identity.firmId],
    [templateBroker, identity.brokerId],
    [phonePrefix, `${phonePrefix.slice(0, -TEMPLATE_SLOT.length)}${identity.block}`],
  ];
  return {
    exact: taggedIds(template, identity.tag),
    substrings,
    // Mailboxes: `g00-<code>@`, `estudio-g00@`, `bounce+g00@`: the marker between a separator and `-` or `@`.
    patterns: [...taggedPatterns(identity.tag), [new RegExp(`(^|[-+])${mailboxTag}(?=[-@])`, "g"), `$1g${identity.block}`]],
  };
}
