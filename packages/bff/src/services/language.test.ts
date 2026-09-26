import { describe, expect, it } from "vitest";
import { detectLanguage, isInLanguage } from "./language";

const SPANISH_TEXTS = [
  "Operación 4471, buque Austral Aurora, arribo estimado 22/10. Faltan: certificado de origen y packing list.",
  "No tenés que hacer nada, se lo pedimos al proveedor.",
  "Le escribimos al proveedor a primera hora de Qingdao.",
  "Te va a escribir alguien del estudio.",
  "Para el certificado de origen hace falta la firma y el sello de la cámara (ítem CO-02 del checklist).",
  "Llegaron los documentos de la operación 4471, gracias.",
  "¿Le escribimos a s•••@sim.legajo.demo.craftech.io?",
];

const ENGLISH_TEXTS = [
  "Dear supplier, for operation 4471 (invoice QBT-2026-0917) we still need the packing list and the certificate of origin. Please send them by 18 Oct 17:00 (Qingdao time).",
  "The gross weight on the packing list (12,480 kg) does not match the invoice (12,840 kg). Please send a corrected version in this thread.",
  "Thanks, we've received the documents.",
  "Kind regards, Estudio Delta via Legajo listo",
  "The new estimated arrival is 20 Oct; the deadline for the missing documents is now 16 Oct 17:00 your time.",
];

describe("detectLanguage", () => {
  it("recognizes the importer's Spanish, voseo included", () => {
    for (const text of SPANISH_TEXTS) expect(detectLanguage(text).language, text).toBe("es");
  });

  it("recognizes the supplier's English, even with Spanish names and a firm signature", () => {
    for (const text of ENGLISH_TEXTS) expect(detectLanguage(text).language, text).toBe("en");
  });

  it("does not guess on texts without enough evidence", () => {
    for (const text of ["", "OK", "4471", "QBT-2026-0917", "packing list", "https://legajo.demo.craftech.io/u/abc", "[CUIT] [CBU]"]) {
      expect(detectLanguage(text).language, text).toBe("und");
    }
  });

  it("calls a half-and-half text undecided instead of picking a side", () => {
    expect(detectLanguage("Hola team, please send la factura").language).toBe("und");
  });

  it("ignores masked markers, links and emails, and handles decomposed accents", () => {
    expect(detectLanguage("Te paso el [CUIT] y el [CBU]").language).toBe("es");
    expect(detectLanguage("Please write to ops@supplier.sim or visit https://example.sim/de/la/que").language).toBe("en");
    expect(detectLanguage("Operacio\u0301n lista, gracias").language).toBe("es");
  });

  it("is deterministic and reports its evidence", () => {
    const text = SPANISH_TEXTS[1] ?? "";
    expect(detectLanguage(text)).toEqual(detectLanguage(text));
    expect(detectLanguage(text).es).toBeGreaterThan(detectLanguage(text).en);
  });
});

describe("isInLanguage", () => {
  it("is true only for the detected language", () => {
    expect(isInLanguage(SPANISH_TEXTS[0] ?? "", "es")).toBe(true);
    expect(isInLanguage(SPANISH_TEXTS[0] ?? "", "en")).toBe(false);
    expect(isInLanguage(ENGLISH_TEXTS[0] ?? "", "en")).toBe(true);
    expect(isInLanguage("OK", "es")).toBe(false);
    expect(isInLanguage("OK", "en")).toBe(false);
  });
});
