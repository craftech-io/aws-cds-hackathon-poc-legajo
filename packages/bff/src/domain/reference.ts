// `Reference` table (docs/architecture.md §5, docs/seed-spec.md §12): read-only catalogs the seed
// writes: holidays, WhatsApp templates, the rate card, the customs-status glossary, the observation
// labels, the evaluation truth of seeded observations and the fictitious-name checks.
import { z } from "zod";
import {
  CalendarDate,
  CustomsChannel,
  DispatchStatus,
  DocType,
  MatrixResponsible,
  ObservationCode,
  ObservationId,
  OperationId,
  WaButtonAction,
  WhatsAppTemplateName,
} from "@legajo/shared";
import { CountryCode, NonEmptyText, defineEntity } from "./common";

export const Holiday = defineEntity({
  country: CountryCode,
  date: CalendarDate,
  name: NonEmptyText,
  /** False until `seed-generator` checks it against the official calendar and records the date. */
  verified: z.boolean(),
  verifiedAt: CalendarDate.optional(),
  source: z.string().url().optional(),
});
export type Holiday = z.output<typeof Holiday>;

export const TemplateButton = z.object({
  type: z.enum(["URL", "QUICK_REPLY"]),
  text: z.string().min(1).max(25),
  action: WaButtonAction.optional(),
  /** URL buttons: the fixed part; the upload token is the dynamic suffix. */
  url: z.string().url().optional(),
});
export type TemplateButton = z.infer<typeof TemplateButton>;

export const TemplateStatus = z.enum(["LOCAL_ONLY", "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"]);
export type TemplateStatus = z.infer<typeof TemplateStatus>;

/** `UTILITY` template in `es_AR` (docs/architecture-integrations.md §4.3). */
export const Template = defineEntity({
  name: WhatsAppTemplateName,
  language: z.literal("es_AR"),
  category: z.literal("UTILITY"),
  body: NonEmptyText,
  paramCount: z.number().int().nonnegative(),
  buttons: z.array(TemplateButton).max(10).default([]),
  status: TemplateStatus,
  metaTemplateId: z.string().optional(),
  /** English gloss shown with "EN" in the phone simulator. */
  gloss: NonEmptyText,
});
export type Template = z.output<typeof Template>;

/** A tariff row; the generator seeds them provisional and `devops` verifies them (WP-41). */
export const RateCard = defineEntity({
  rateId: NonEmptyText,
  price: z.number().nonnegative().nullable(),
  unit: NonEmptyText,
  currency: z.literal("USD").default("USD"),
  source: z.string().url().optional(),
  asOf: CalendarDate.optional(),
  provisional: z.boolean(),
}).refine((rate) => rate.provisional || (rate.price !== null && rate.source !== undefined && rate.asOf !== undefined), "a verified rate has price, source and date");
export type RateCard = z.output<typeof RateCard>;

/** Generic explanation of a customs status for the importer; never advice. */
export const DispatchGlossary = defineEntity({
  status: DispatchStatus.exclude(["NONE"]),
  channel: CustomsChannel.optional(),
  text: NonEmptyText,
  gloss: NonEmptyText,
});
export type DispatchGlossary = z.output<typeof DispatchGlossary>;

export const ObservationCodeLabel = defineEntity({
  code: ObservationCode,
  labelEs: NonEmptyText,
  labelEn: NonEmptyText,
});
export type ObservationCodeLabel = z.output<typeof ObservationCodeLabel>;

/** Expected responsible of a seeded observation (the "right responsible" metric). */
export const EvalTruth = defineEntity({
  operationId: OperationId,
  observationId: ObservationId,
  docType: DocType,
  code: ObservationCode,
  expectedResponsible: MatrixResponsible,
});
export type EvalTruth = z.output<typeof EvalTruth>;

export const NameKind = z.enum(["COMPANY", "VESSEL", "CARRIER", "INSTITUTION"]);

/** A fictitious name with the web search that found no real match (docs/seed-spec.md §12). */
export const NameCheck = defineEntity({
  name: NonEmptyText,
  kind: NameKind,
  query: NonEmptyText,
  checkedAt: CalendarDate,
  result: NonEmptyText,
});
export type NameCheck = z.output<typeof NameCheck>;
