// What each synthetic operation ships: invoice lines, packages and weights (docs/seed-spec.md §8).
// Drawn from the seed's PRNG per operation, so the numbers are stable across generations and the
// three documents of an operation agree with each other (except where the seed plants an error).
import type { GoodsKind } from "./catalog-parties";
import { rngFor } from "./rng";

interface GoodsLineSpec {
  readonly description: string;
  readonly unit: string;
  /** Units per package. */
  readonly perPackage: readonly [number, number];
  /** USD cents per unit. */
  readonly priceCents: readonly [number, number];
}

interface GoodsKindSpec {
  readonly packageType: string;
  /** Net kilograms per package and tare of the package. */
  readonly netPerPackage: readonly [number, number];
  readonly tare: number;
  readonly lines: readonly GoodsLineSpec[];
}

const KINDS: Readonly<Record<GoodsKind, GoodsKindSpec>> = {
  TEXTILES: { packageType: "rolls", netPerPackage: [45, 60], tare: 3, lines: [
    { description: "Cotton twill fabric, dyed, 150 cm width", unit: "m", perPackage: [50, 50], priceCents: [210, 340] },
    { description: "Polyester lining fabric, 145 cm width", unit: "m", perPackage: [60, 60], priceCents: [95, 160] },
    { description: "Denim fabric, 12 oz, 155 cm width", unit: "m", perPackage: [45, 45], priceCents: [290, 420] },
  ] },
  ELECTRONICS: { packageType: "cartons", netPerPackage: [8, 18], tare: 1, lines: [
    { description: "LED driver modules, 40 W", unit: "pcs", perPackage: [40, 60], priceCents: [310, 520] },
    { description: "Smart plug sockets, 10 A", unit: "pcs", perPackage: [50, 80], priceCents: [240, 390] },
    { description: "USB charging hubs, 4 ports", unit: "pcs", perPackage: [60, 100], priceCents: [180, 310] },
  ] },
  FURNITURE: { packageType: "crates", netPerPackage: [35, 70], tare: 6, lines: [
    { description: "Solid wood dining chairs, knocked down", unit: "pcs", perPackage: [4, 6], priceCents: [2800, 4600] },
    { description: "Rattan side tables", unit: "pcs", perPackage: [3, 5], priceCents: [3500, 5800] },
  ] },
  TOOLS: { packageType: "cartons", netPerPackage: [12, 25], tare: 1, lines: [
    { description: "Combination wrench sets, 12 pieces", unit: "sets", perPackage: [10, 20], priceCents: [1450, 2300] },
    { description: "Hex key sets, metric", unit: "sets", perPackage: [40, 60], priceCents: [320, 540] },
    { description: "Adjustable spanners, 250 mm", unit: "pcs", perPackage: [20, 30], priceCents: [690, 980] },
  ] },
  VALVES: { packageType: "crates", netPerPackage: [60, 120], tare: 8, lines: [
    { description: "Brass ball valves, DN25", unit: "pcs", perPackage: [60, 90], priceCents: [940, 1380] },
    { description: "Cast iron gate valves, DN80", unit: "pcs", perPackage: [4, 8], priceCents: [8600, 12400] },
  ] },
  CHEMICALS: { packageType: "drums", netPerPackage: [180, 220], tare: 12, lines: [
    { description: "Food-grade citric acid, anhydrous", unit: "kg", perPackage: [200, 200], priceCents: [110, 170] },
    { description: "Sodium bicarbonate, technical grade", unit: "kg", perPackage: [200, 200], priceCents: [45, 80] },
  ] },
  KITCHENWARE: { packageType: "cartons", netPerPackage: [10, 22], tare: 1, lines: [
    { description: "Stainless steel saucepans, 18 cm", unit: "pcs", perPackage: [12, 24], priceCents: [720, 1150] },
    { description: "Non-stick frying pans, 28 cm", unit: "pcs", perPackage: [10, 16], priceCents: [860, 1320] },
  ] },
  AUTOPARTS: { packageType: "cartons", netPerPackage: [15, 30], tare: 2, lines: [
    { description: "Brake pad sets, front axle", unit: "sets", perPackage: [10, 20], priceCents: [1480, 2250] },
    { description: "Oil filters, spin-on", unit: "pcs", perPackage: [40, 60], priceCents: [260, 410] },
  ] },
  FOOD: { packageType: "cartons", netPerPackage: [10, 16], tare: 1, lines: [
    { description: "Canned hearts of palm, 400 g", unit: "cans", perPackage: [24, 24], priceCents: [110, 160] },
    { description: "Guava paste, 600 g", unit: "units", perPackage: [20, 20], priceCents: [140, 210] },
  ] },
  LAMPS: { packageType: "cartons", netPerPackage: [6, 12], tare: 1, lines: [
    { description: "LED bulbs, E27, 9 W", unit: "pcs", perPackage: [100, 100], priceCents: [55, 90] },
    { description: "Desk lamps, adjustable arm", unit: "pcs", perPackage: [8, 12], priceCents: [940, 1480] },
  ] },
  CERAMICS: { packageType: "pallets", netPerPackage: [900, 1200], tare: 25, lines: [
    { description: "Glazed porcelain floor tiles, 60 x 60 cm", unit: "m2", perPackage: [40, 50], priceCents: [880, 1350] },
    { description: "Ceramic wall tiles, 30 x 60 cm", unit: "m2", perPackage: [60, 70], priceCents: [540, 820] },
  ] },
  PUMPS: { packageType: "crates", netPerPackage: [80, 160], tare: 10, lines: [
    { description: "Centrifugal water pumps, 2.2 kW", unit: "pcs", perPackage: [2, 4], priceCents: [38000, 52000] },
    { description: "Submersible drainage pumps, 0.75 kW", unit: "pcs", perPackage: [6, 10], priceCents: [9800, 14500] },
  ] },
  PLASTICS: { packageType: "cartons", netPerPackage: [12, 20], tare: 1, lines: [
    { description: "Polypropylene storage boxes, 30 l", unit: "pcs", perPackage: [10, 16], priceCents: [260, 420] },
    { description: "HDPE food containers, 1 l", unit: "pcs", perPackage: [80, 120], priceCents: [35, 60] },
  ] },
};

export interface GoodsLine {
  readonly description: string;
  readonly unit: string;
  readonly packages: number;
  readonly perPackage: number;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly totalCents: number;
  readonly netKg: number;
  readonly grossKg: number;
}

export interface Goods {
  readonly packageType: string;
  readonly lines: readonly GoodsLine[];
  readonly packages: number;
  readonly netKg: number;
  readonly grossKg: number;
  readonly netPerPackage: number;
  readonly grossPerPackage: number;
  readonly totalCents: number;
}

/** Package count and weight per package fixed by the story (op-4471: 214 rolls, 12,840 kg gross). */
export interface GoodsOverride {
  readonly packages: number;
  readonly netPerPackage: number;
  readonly grossPerPackage: number;
}

export function goodsFor(operationNumber: string, kind: GoodsKind, override?: GoodsOverride): Goods {
  const rng = rngFor(`goods:${operationNumber}`);
  const spec = KINDS[kind];
  const lineSpecs = rng.shuffle(spec.lines).slice(0, rng.int(1, Math.min(2, spec.lines.length)));
  const packages = override?.packages ?? rng.int(kind === "CERAMICS" ? 18 : 40, kind === "CERAMICS" ? 26 : 260);
  const netPerPackage = override?.netPerPackage ?? rng.int(spec.netPerPackage[0], spec.netPerPackage[1]);
  const grossPerPackage = override?.grossPerPackage ?? netPerPackage + spec.tare;
  const split = lineSpecs.length === 1 ? [packages] : [Math.floor(packages / 2) + rng.int(0, Math.floor(packages / 6)), 0];
  if (split.length === 2) split[1] = packages - (split[0] ?? 0);
  const lines = lineSpecs.map((line, index): GoodsLine => {
    const linePackages = split[index] ?? 0;
    const perPackage = rng.int(line.perPackage[0], line.perPackage[1]);
    const unitPriceCents = rng.int(line.priceCents[0], line.priceCents[1]);
    const quantity = linePackages * perPackage;
    return {
      description: line.description,
      unit: line.unit,
      packages: linePackages,
      perPackage,
      quantity,
      unitPriceCents,
      totalCents: quantity * unitPriceCents,
      netKg: linePackages * netPerPackage,
      grossKg: linePackages * grossPerPackage,
    };
  });
  return {
    packageType: spec.packageType,
    lines,
    packages,
    netKg: packages * netPerPackage,
    grossKg: packages * grossPerPackage,
    netPerPackage,
    grossPerPackage,
    totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0),
  };
}

// ---- Hand-written number formatters (no Intl) ----------------------------------------------------

/** `12,840`: English thousands separators, as the exporter's documents print them. */
export function enInt(value: number): string {
  if (!Number.isInteger(value)) throw new RangeError(`expected an integer, got ${value}`);
  const digits = String(Math.abs(value));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return `${value < 0 ? "-" : ""}${groups.join(",")}`;
}

/** `48,210.00` from cents. */
export function enMoney(cents: number): string {
  return `${enInt(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, "0")}`;
}

export function kg(value: number): string {
  return `${enInt(value)} kg`;
}
