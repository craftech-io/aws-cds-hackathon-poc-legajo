// `Reference/NAMECHECK` (docs/seed-spec.md §12, invariant 11): every company, vessel, carrier and
// institution name of the seed with the web search that was run for it, the date and what it found.
// A name whose search found a real company is not in the seed: the two names of the spec that did
// (the chemicals supplier of op-4474 and the plastics supplier of op-4479) were replaced by the
// invented names below, and their searches are recorded with the replacement.

export type NameKind = "COMPANY" | "VESSEL" | "CARRIER" | "INSTITUTION";

export interface NameCheckRecord {
  readonly name: string;
  readonly kind: NameKind;
  readonly query: string;
  readonly result: string;
}

const NONE = "Sin coincidencia real: ninguna empresa con ese nombre en los resultados.";
const check = (name: string, kind: NameKind, query: string, result: string = NONE): NameCheckRecord => ({ name, kind, query, result });

export const NAME_CHECKS: readonly NameCheckRecord[] = [
  check("Estudio Delta", "COMPANY", '"Estudio Delta" despachantes de aduana', "Sin coincidencia real: ningún estudio de despachantes con ese nombre."),
  check("Estudio Norte", "COMPANY", '"Estudio Norte" despachantes de aduana', "Sin coincidencia real: ningún estudio de despachantes con ese nombre."),
  check("Estudio QA", "COMPANY", '"Estudio QA" OR "Estudio de lote" despachante de aduana', "Sin coincidencia real; nombre interno de un estudio de pruebas que no se muestra en la landing."),
  check("Estudio de lote", "COMPANY", '"Estudio QA" OR "Estudio de lote" despachante de aduana', "Sin coincidencia real; nombre interno del estudio del lote de métricas."),
  check("Norpampa Insumos SRL", "COMPANY", '"Norpampa Insumos"', "Sin coincidencia real: \"Norpampa\" aparece solo como nombre de una región en un instituto educativo."),
  check("Vientos de Cuyo SA", "COMPANY", '"Vientos de Cuyo SA"'),
  check("Litoral Hogar SRL", "COMPANY", '"Litoral Hogar SRL"', "Sin coincidencia real: hay otras empresas con \"Litoral\" en el nombre, ninguna con este."),
  check("Patagonia Frío SA", "COMPANY", '"Patagonia Frío SA"', "Sin coincidencia de empresa; aparece un producto de té con un nombre parecido, no una razón social."),
  check("Sierras Textil SRL", "COMPANY", '"Sierras Textil SRL"', "Sin coincidencia real: hay una textil con otro nombre (\"Sierra Textiles\")."),
  check("Riberas Ferretería SA", "COMPANY", '"Riberas Ferretería"', "Sin coincidencia real: hay ferreterías con otro nombre (\"La Ribera\")."),
  check("Altiplano Maquinarias SRL", "COMPANY", '"Altiplano Maquinarias"', "Sin coincidencia real: hay empresas de maquinaria con otros nombres que contienen \"Altiplano\"."),
  check("Quebrada Alimentos SA", "COMPANY", '"Quebrada Alimentos SA"'),
  check("Qingdao Bluewave Textiles Co., Ltd.", "COMPANY", '"Qingdao Bluewave Textiles"'),
  check("Shenzhen Brightpath Electronics Co.", "COMPANY", '"Shenzhen Brightpath Electronics"'),
  check("Saigon Riverline Furniture JSC", "COMPANY", '"Saigon Riverline Furniture"', "Sin coincidencia real: hay mueblerías de Saigón con otros nombres."),
  check("Elbhafen Tools GmbH", "COMPANY", '"Elbhafen Tools GmbH"', "Sin coincidencia real: existe una empresa de herramientas con otro nombre (\"elbe-tools\")."),
  check("Ligurmare Valve Works S.r.l.", "COMPANY", '"Ligurmare Valve Works"'),
  check("Konkanshore Specialty Chemicals Pvt Ltd", "COMPANY", '"Konkanshore Specialty Chemicals"', "Sin coincidencia real. Reemplaza al nombre de la especificación, cuya búsqueda encontró una empresa real con ese nombre."),
  check("Bosphorus Kitchenware A.S.", "COMPANY", '"Bosphorus Kitchenware"', "Sin coincidencia real: hay comercios con \"Bosphorus\" en el nombre, ninguno con este."),
  check("Busan Coastal Parts Co.", "COMPANY", '"Busan Coastal Parts"'),
  check("Santos Verde Alimentos Ltda", "COMPANY", '"Santos Verde Alimentos"', "Sin coincidencia real: hay comercios de Santos con otros nombres."),
  check("Ningbo Harborlight Lamps Co.", "COMPANY", '"Ningbo Harborlight Lamps"'),
  check("Levante Ceramics S.L.", "COMPANY", '"Levante Ceramics S.L."', "Sin coincidencia exacta: existe una cerámica italiana con un nombre parecido en otro idioma; a revisar."),
  check("Maasvlakte Pumps B.V.", "COMPANY", '"Maasvlakte Pumps"', "Sin coincidencia real: \"Maasvlakte\" es una zona portuaria, no una empresa."),
  check("Guangzhou Lotusmere Plastics Co.", "COMPANY", '"Guangzhou Lotusmere Plastics"', "Sin coincidencia real. Reemplaza al nombre de la especificación, cuya búsqueda encontró una empresa real de plásticos de Guangzhou con esa marca."),
  check("Austral Line", "CARRIER", '"Austral Line" shipping', "Sin coincidencia exacta: existe una naviera con otro nombre que contiene \"Austral\"; a revisar."),
  check("Pacifica Container Lines", "CARRIER", '"Pacifica Container Lines"', "Sin coincidencia exacta: hay navieras con \"Pacific\" en el nombre, ninguna con este."),
  check("Río Sur Shipping", "CARRIER", '"Río Sur Shipping"', "Sin coincidencia exacta: existe una empresa fluvial con \"Río Sur\" en el nombre; a revisar."),
  check("Austral Aurora", "VESSEL", '"Austral Aurora" vessel', "Sin coincidencia: hay un buque con las mismas palabras en otro orden y otro idioma."),
  check("Austral Meridian", "VESSEL", '"Austral Meridian" vessel'),
  check("Pacifica Horizon", "VESSEL", '"Pacifica Horizon" vessel ship', "Sin coincidencia: hay buques llamados \"Pacific Horizon\", no \"Pacifica Horizon\"."),
  check("Pacifica Dawn", "VESSEL", '"Pacifica Dawn" ship', "Sin coincidencia: hay buques llamados \"Pacific Dawn\", no \"Pacifica Dawn\"."),
  check("Río Sur Tern", "VESSEL", '"Río Sur Tern" OR "Rio Sur Tern" ship'),
  check("Río Sur Petrel", "VESSEL", '"Río Sur Petrel" OR "Rio Sur Petrel" vessel'),
  check("Synthetic Chamber of Commerce (fictitious)", "INSTITUTION", '"Synthetic Chamber of Commerce"', "Sin coincidencia real: ninguna institución con ese nombre."),
];
