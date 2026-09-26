// Firms, people, importers and suppliers of docs/seed-spec.md §4-§6, as data. Every name is
// fictitious and has its registered web search in namecheck.ts. Two supplier names of the spec were
// replaced after that search found a real company (Reference/NAMECHECK records both searches); their
// ids and mailbox codes stay as the spec writes them.
import type { ConsentMedium, SupplierBehaviour } from "@legajo/shared";

export interface FirmSpec {
  readonly firmId: string;
  readonly name: string;
  readonly kind: "DEMO" | "JUDGE" | "QA";
  readonly mailboxAddress: string;
  /** The world of a demo firm; QA firms own many worlds. */
  readonly clockId?: string;
  readonly turnCaps: { readonly perHour: number; readonly perDay: number };
}

export const FIRMS: readonly FirmSpec[] = [
  { firmId: "firm-delta", name: "Estudio Delta", kind: "DEMO", mailboxAddress: "estudio-delta@sim.legajo.demo.craftech.io", clockId: "GLOBAL#firm-delta", turnCaps: { perHour: 200, perDay: 1000 } },
  { firmId: "firm-norte", name: "Estudio Norte", kind: "DEMO", mailboxAddress: "estudio-norte@sim.legajo.demo.craftech.io", clockId: "GLOBAL#firm-norte", turnCaps: { perHour: 200, perDay: 1000 } },
  { firmId: "firm-qa", name: "Estudio QA", kind: "QA", mailboxAddress: "estudio-qa@sim.legajo.demo.craftech.io", turnCaps: { perHour: 120, perDay: 600 } },
  { firmId: "firm-sim", name: "Estudio de lote", kind: "QA", mailboxAddress: "estudio-sim@sim.legajo.demo.craftech.io", turnCaps: { perHour: 120, perDay: 800 } },
];

export interface BrokerSpec {
  readonly brokerId: string;
  readonly firmId: string;
  readonly name: string;
  readonly role: "BROKER" | "ANALYST" | "JUDGE";
}

export const BROKERS: readonly BrokerSpec[] = [
  { brokerId: "brk-delta-diego", firmId: "firm-delta", name: "Diego Ferreyra", role: "BROKER" },
  { brokerId: "brk-delta-martina", firmId: "firm-delta", name: "Martina Sosa", role: "ANALYST" },
  { brokerId: "brk-norte-pablo", firmId: "firm-norte", name: "Pablo Giménez", role: "BROKER" },
  { brokerId: "brk-qa-runner", firmId: "firm-qa", name: "QA runner", role: "BROKER" },
  { brokerId: "brk-qa-analyst", firmId: "firm-qa", name: "QA analyst", role: "ANALYST" },
];

export interface ImporterSpec {
  readonly importerId: string;
  readonly firmId: string;
  readonly name: string;
  readonly contactName: string;
  /** Last two digits of the firm's phone block (`+54 9 11 5550 01xx`, `02xx`). */
  readonly phoneSuffix: string;
  readonly consent?: { readonly grantedAt: string; readonly medium: ConsentMedium };
  readonly authorizes: readonly string[];
  readonly city: string;
  readonly street: string;
}

export const IMPORTERS: readonly ImporterSpec[] = [
  { importerId: "imp-norpampa", firmId: "firm-delta", name: "Norpampa Insumos SRL", contactName: "Lucía Benítez", phoneSuffix: "01", consent: { grantedAt: "2026-09-30T11:00:00-03:00", medium: "SIGNED_FORM" }, authorizes: ["sup-qingdao", "sup-ligurmare", "sup-santosverde"], city: "Pergamino, Buenos Aires", street: "Calle 14 N° 1180" },
  { importerId: "imp-cuyo", firmId: "firm-delta", name: "Vientos de Cuyo SA", contactName: "Andrés Molina", phoneSuffix: "02", consent: { grantedAt: "2026-09-29T11:00:00-03:00", medium: "EMAIL" }, authorizes: ["sup-lotusmere"], city: "Godoy Cruz, Mendoza", street: "Calle Los Álamos 2250" },
  { importerId: "imp-litoral", firmId: "firm-delta", name: "Litoral Hogar SRL", contactName: "Carla Ruiz", phoneSuffix: "03", authorizes: ["sup-shenzhen"], city: "Paraná, Entre Ríos", street: "Calle Los Ceibos 930" },
  { importerId: "imp-patagonia", firmId: "firm-delta", name: "Patagonia Frío SA", contactName: "Tomás Quiroga", phoneSuffix: "04", consent: { grantedAt: "2026-09-29T15:00:00-03:00", medium: "SIGNED_FORM" }, authorizes: ["sup-konkan", "sup-saigon", "sup-maasvlakte"], city: "Neuquén, Neuquén", street: "Calle Los Pehuenes 415" },
  { importerId: "imp-sierras", firmId: "firm-delta", name: "Sierras Textil SRL", contactName: "Valeria Paz", phoneSuffix: "05", consent: { grantedAt: "2026-10-01T11:00:00-03:00", medium: "IN_PERSON" }, authorizes: ["sup-bosphorus", "sup-levante", "sup-qingdao"], city: "Villa Carlos Paz, Córdoba", street: "Calle Las Moras 77" },
  { importerId: "imp-riberas", firmId: "firm-delta", name: "Riberas Ferretería SA", contactName: "Nicolás Ibarra", phoneSuffix: "06", consent: { grantedAt: "2026-09-28T11:00:00-03:00", medium: "EMAIL" }, authorizes: ["sup-busan", "sup-ningbo", "sup-shenzhen"], city: "San Nicolás, Buenos Aires", street: "Calle Ribera Norte 1320" },
  { importerId: "imp-altiplano", firmId: "firm-norte", name: "Altiplano Maquinarias SRL", contactName: "Rocío Vera", phoneSuffix: "01", consent: { grantedAt: "2026-10-02T11:00:00-03:00", medium: "SIGNED_FORM" }, authorizes: ["sup-n-elbhafen", "sup-n-saigon"], city: "San Salvador de Jujuy, Jujuy", street: "Calle Los Cardones 560" },
  { importerId: "imp-quebrada", firmId: "firm-norte", name: "Quebrada Alimentos SA", contactName: "Julián Ortiz", phoneSuffix: "02", consent: { grantedAt: "2026-10-02T15:00:00-03:00", medium: "EMAIL" }, authorizes: ["sup-n-shenzhen", "sup-n-qingdao"], city: "Salta, Salta", street: "Calle Los Molles 1905" },
];

/** What the supplier ships: the lines of its invoices and how they are packed. */
export type GoodsKind = "TEXTILES" | "ELECTRONICS" | "FURNITURE" | "TOOLS" | "VALVES" | "CHEMICALS" | "KITCHENWARE" | "AUTOPARTS" | "FOOD" | "LAMPS" | "CERAMICS" | "PUMPS" | "PLASTICS";

export interface SupplierSpec {
  readonly supplierId: string;
  /** Code of the id and of the mailbox (`supplier-<code>@sim…`). */
  readonly code: string;
  readonly firmId: string;
  readonly name: string;
  readonly country: string;
  readonly countryName: string;
  readonly timezone: string;
  /** Registered contact: our simulated mailbox, or the SES mailbox simulator for bounces and complaints. */
  readonly contactEmail: string;
  readonly behaviour: SupplierBehaviour;
  readonly params?: { readonly delayHours?: number; readonly realReplyAfterHours?: number; readonly promiseHours?: number };
  /** Address the importer knows but nobody registered (`altContacts`, FL-014). */
  readonly altContact?: string;
  readonly port: string;
  readonly address: string;
  readonly goods: GoodsKind;
}

const SIM = "sim.legajo.demo.craftech.io";
const mailbox = (code: string): string => `supplier-${code}@${SIM}`;

type SupplierBase = Omit<SupplierSpec, "supplierId" | "firmId" | "contactEmail" | "code">;

const BASES: Readonly<Record<string, SupplierBase & { readonly contactEmail?: string }>> = {
  qingdao: { name: "Qingdao Bluewave Textiles Co., Ltd.", country: "CN", countryName: "China", timezone: "Asia/Shanghai", behaviour: "SEEDED_ERROR", port: "Qingdao", address: "Building 3, 118 East Harbour Road, Qingdao, Shandong", goods: "TEXTILES" },
  shenzhen: { name: "Shenzhen Brightpath Electronics Co.", country: "CN", countryName: "China", timezone: "Asia/Shanghai", behaviour: "PROMPT", port: "Shenzhen", address: "Unit 12, 45 Keyuan Industrial Lane, Shenzhen, Guangdong", goods: "ELECTRONICS" },
  saigon: { name: "Saigon Riverline Furniture JSC", country: "VN", countryName: "Vietnam", timezone: "Asia/Ho_Chi_Minh", behaviour: "LATE", params: { delayHours: 30 }, port: "Ho Chi Minh City", address: "Lot 7, Riverside Industrial Park, Thu Duc, Ho Chi Minh City", goods: "FURNITURE" },
  elbhafen: { name: "Elbhafen Tools GmbH", country: "DE", countryName: "Germany", timezone: "Europe/Berlin", behaviour: "PROMPT", port: "Hamburg", address: "Kaiweg 24, 21079 Hamburg", goods: "TOOLS" },
  ligurmare: { name: "Ligurmare Valve Works S.r.l.", country: "IT", countryName: "Italy", timezone: "Europe/Rome", behaviour: "NEVER", port: "Genoa", address: "Via delle Darsene 31, 16126 Genova", goods: "VALVES" },
  konkan: { name: "Konkanshore Specialty Chemicals Pvt Ltd", country: "IN", countryName: "India", timezone: "Asia/Kolkata", behaviour: "BOUNCE", contactEmail: "bounce@simulator.amazonses.com", altContact: `supplier-konkan-ops@${SIM}`, port: "Nhava Sheva", address: "Plot 58, Coastal Industrial Estate, Ratnagiri, Maharashtra", goods: "CHEMICALS" },
  bosphorus: { name: "Bosphorus Kitchenware A.S.", country: "TR", countryName: "Türkiye", timezone: "Europe/Istanbul", behaviour: "WRONG_DOC", port: "Istanbul", address: "Organize Sanayi Bolgesi 9. Cadde No 14, Istanbul", goods: "KITCHENWARE" },
  busan: { name: "Busan Coastal Parts Co.", country: "KR", countryName: "Republic of Korea", timezone: "Asia/Seoul", behaviour: "UNKNOWN_DOC", port: "Busan", address: "33 Harbour Industrial Road, Gangseo-gu, Busan", goods: "AUTOPARTS" },
  santosverde: { name: "Santos Verde Alimentos Ltda", country: "BR", countryName: "Brazil", timezone: "America/Sao_Paulo", behaviour: "INJECTION", port: "Santos", address: "Rua do Cais 210, Santos, Sao Paulo", goods: "FOOD" },
  ningbo: { name: "Ningbo Harborlight Lamps Co.", country: "CN", countryName: "China", timezone: "Asia/Shanghai", behaviour: "AUTO_REPLY", params: { realReplyAfterHours: 2 }, port: "Ningbo", address: "No. 6 Lighthouse Industrial Road, Beilun, Ningbo, Zhejiang", goods: "LAMPS" },
  levante: { name: "Levante Ceramics S.L.", country: "ES", countryName: "Spain", timezone: "Europe/Madrid", behaviour: "PROMISE", params: { promiseHours: 24 }, port: "Valencia", address: "Camino del Azulejo 12, 12200 Onda, Castellon", goods: "CERAMICS" },
  maasvlakte: { name: "Maasvlakte Pumps B.V.", country: "NL", countryName: "Netherlands", timezone: "Europe/Amsterdam", behaviour: "COMPLAINT", contactEmail: "complaint@simulator.amazonses.com", port: "Rotterdam", address: "Havenweg 88, 3199 Rotterdam", goods: "PUMPS" },
  lotusmere: { name: "Guangzhou Lotusmere Plastics Co.", country: "CN", countryName: "China", timezone: "Asia/Shanghai", behaviour: "SEEDED_ERROR_TWICE", port: "Guangzhou", address: "No. 19 Lotus Pond Industrial Street, Panyu, Guangzhou, Guangdong", goods: "PLASTICS" },
};

function supplier(code: string, firmId: string, prefix = ""): SupplierSpec {
  const base = BASES[code];
  if (base === undefined) throw new RangeError(`unknown supplier code ${code}`);
  const own = `${prefix}${code}`;
  return { ...base, supplierId: `sup-${own}`, code: own, firmId, contactEmail: base.contactEmail ?? mailbox(own) };
}

/** Delta's 13 suppliers, then Norte's own records of four of them (`sup-n-<code>`, §6). */
export const SUPPLIERS: readonly SupplierSpec[] = [
  ...["qingdao", "shenzhen", "saigon", "elbhafen", "ligurmare", "konkan", "bosphorus", "busan", "santosverde", "ningbo", "levante", "maasvlakte", "lotusmere"].map((code) => supplier(code, "firm-delta")),
  ...["elbhafen", "shenzhen", "saigon", "qingdao"].map((code) => supplier(code, "firm-norte", "n-")),
];

export function supplierSpec(supplierId: string): SupplierSpec {
  const found = SUPPLIERS.find((candidate) => candidate.supplierId === supplierId);
  if (found === undefined) throw new RangeError(`unknown supplier ${supplierId}`);
  return found;
}

export function importerSpec(importerId: string): ImporterSpec {
  const found = IMPORTERS.find((candidate) => candidate.importerId === importerId);
  if (found === undefined) throw new RangeError(`unknown importer ${importerId}`);
  return found;
}

/** `+54 9 11 5550 01xx` (Delta), `02xx` (Norte): the only phone blocks of the demo seed (§2). */
export function demoPhone(firmId: string, suffix: string): string {
  const block = firmId === "firm-norte" ? "02" : "01";
  return `+5491155500${block}${suffix}`;
}
