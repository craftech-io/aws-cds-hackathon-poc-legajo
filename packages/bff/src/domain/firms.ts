// `Firms` table (docs/architecture.md §5): the firm (tenant), its settings with every assumption
// labelled "supuesto" (docs/seed-spec.md §4, invariant 13), its brokers (the console principals), the
// versioned checklist the agent answers from (ADR-0013) and the versioned responsibility matrix.
import { z } from "zod";
import { BrokerId, ClockId, ConsoleRole, DocType, FirmId, FirmKind, GuestKind, MatrixResponsible, ObservationCode, Party, Weekday } from "@legajo/shared";
import { EmailAddress, IanaZone, NonEmptyText, TimeOfDay, UsdRange, defineEntity } from "./common";

export const BusinessHours = z.object({
  timezone: IanaZone,
  from: TimeOfDay,
  to: TimeOfDay,
  weekdays: z.array(Weekday).min(1),
});
export type BusinessHours = z.infer<typeof BusinessHours>;

export const Firm = defineEntity({
  firmId: FirmId,
  name: NonEmptyText,
  kind: FirmKind,
  /** Reserved account or public slot; only on `GUEST` firms (docs/architecture.md §5). */
  guestKind: GuestKind.optional(),
  /** Demo mailbox of the firm (`estudio-<slug>@sim…`): escalations land here. */
  mailboxAddress: EmailAddress,
  businessHours: BusinessHours,
  /** The world of a demo or guest firm; QA firms own many worlds and leave it out. */
  clockId: ClockId.optional(),
  active: z.boolean().default(true),
});
export type Firm = z.output<typeof Firm>;

/** Every number that is not a verified fact carries this label in data and in every view. */
export const AssumptionLabel = z.literal("supuesto");

/** Human actions the console counts for the human-minutes metric (docs/seed-spec.md §4). */
export const HumanAction = z.enum(["TAKE", "SEND", "WAIVE", "CLASSIFY", "APPROVE", "REOPEN"]);
export type HumanAction = z.infer<typeof HumanAction>;

export const ManualBaselineItem = z.object({
  action: NonEmptyText,
  count: z.number().int().min(1).default(1),
  minutes: z.number().nonnegative(),
  label: AssumptionLabel,
});

export const FirmSettings = defineEntity({
  firmId: FirmId,
  /** Declared manual baseline as a breakdown (contacts × minutes + review + assembly). */
  manualBaseline: z.object({ items: z.array(ManualBaselineItem).min(1), source: NonEmptyText, label: AssumptionLabel }),
  /** Minutes per human action on an operation. */
  humanActionMinutes: z.object({
    items: z.array(z.object({ action: HumanAction, minutes: z.number().nonnegative(), label: AssumptionLabel })).min(1),
    source: NonEmptyText,
    label: AssumptionLabel,
  }),
  /** Delay-risk assumptions (free days at port, container demurrage per day). */
  assumptions: z.object({
    freeDaysAtPort: z.number().int().nonnegative(),
    demurrageUsdPerDay: UsdRange,
    source: NonEmptyText,
    label: AssumptionLabel,
  }),
  costBudgetUsdPerDossier: z.number().positive(),
  /** Turn caps per firm in real time (`TURNCAP#`, docs/architecture.md §13). */
  turnCaps: z.object({ perHour: z.number().int().positive(), perDay: z.number().int().positive() }),
  /** Emails to the firm's mailbox for `UNTRUSTED_SENDER` per real day; the rest stay in the console. */
  untrustedSenderEmailsPerDay: z.number().int().nonnegative().default(3),
});
export type FirmSettings = z.output<typeof FirmSettings>;

export const Broker = defineEntity({
  brokerId: BrokerId,
  firmId: FirmId,
  name: NonEmptyText,
  role: ConsoleRole,
  email: EmailAddress.optional(),
  /** Seeded empty; `console:invite` fills it and a seed reload keeps it (docs/seed-spec.md §4). */
  cognitoSub: z.string().max(128).default(""),
  active: z.boolean().default(true),
});
export type Broker = z.output<typeof Broker>;

export const ChecklistItem = z.object({
  itemId: z.string().regex(/^(?:CI|PL|CO)-\d{2}$/, "expected CI-01, PL-01 or CO-01"),
  docType: DocType,
  text: NonEmptyText,
  required: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

/** One version of the checklist of a document type (`CHECKLIST#<docType>#v<nnn>`). */
export const Checklist = defineEntity({
  firmId: FirmId,
  docType: DocType,
  checklistVersion: z.number().int().min(1),
  items: z.array(ChecklistItem).min(1),
}).refine((checklist) => checklist.items.every((item) => item.docType === checklist.docType), "every item belongs to the checklist's document type");
export type Checklist = z.output<typeof Checklist>;

export const MatrixRule = z.object({
  /** `ANY` applies to every document type (`LOW_CONFIDENCE`). */
  docType: z.union([DocType, z.literal("ANY")]),
  code: ObservationCode,
  responsible: MatrixResponsible,
  /** Who follows once the first responsible did their part (`BUYER_DATA_MISMATCH`: importer, then supplier). */
  then: MatrixResponsible.optional(),
});
export type MatrixRule = z.infer<typeof MatrixRule>;

/** One version of the responsibility matrix (`RESP_MATRIX#v<nnn>`, docs/seed-spec.md §11). */
export const ResponsibilityMatrix = defineEntity({
  firmId: FirmId,
  matrixVersion: z.number().int().min(1),
  rules: z.array(MatrixRule).min(1),
  /** "Otro": anything the rules do not name. */
  fallback: Party.default("BROKER"),
});
export type ResponsibilityMatrix = z.output<typeof ResponsibilityMatrix>;

export interface MatrixDefault {
  readonly responsible: MatrixResponsible;
  readonly then?: MatrixResponsible;
}

/** Default responsible for an observation: the exact document rule, then an `ANY` rule, then the fallback. */
export function matrixDefault(matrix: Pick<ResponsibilityMatrix, "rules" | "fallback">, docType: DocType, code: ObservationCode): MatrixDefault {
  const rule = matrix.rules.find((candidate) => candidate.docType === docType && candidate.code === code) ?? matrix.rules.find((candidate) => candidate.docType === "ANY" && candidate.code === code);
  if (!rule) return { responsible: matrix.fallback };
  return rule.then === undefined ? { responsible: rule.responsible } : { responsible: rule.responsible, then: rule.then };
}
