import { describe, expect, it } from "vitest";
import { findAvoidedWord, findSensitiveAsk, stripAccents } from "./forbidden";

describe("findSensitiveAsk (CP-NO-SENSITIVE-ASK)", () => {
  it.each([
    ["Mandanos el CUIT de la empresa.", "cuit"],
    ["¿Me pasás tu CBU?", "cbu"],
    ["Pasame el número de tarjeta así lo cargamos.", "tarjeta"],
    ["Necesitamos tu DNI para seguir.", "dni"],
    ["Confirmá tu clave fiscal, por favor.", "clave fiscal"],
    ["¿Cuál es tu contraseña?", "contrasena"],
    ["No tenés que hacer nada. Mandanos el CBU.", "cbu"],
    ["Si no lo tenés a mano, mandanos el CUIT.", "cuit"],
    ["Please send your bank account number.", "bank account"],
    ["What's your tax ID?", "tax id"],
    ["Could you share the credit card used for the payment?", "credit card"],
  ])("flags %s", (text, term) => {
    expect(findSensitiveAsk(text)?.term).toBe(term);
  });

  it.each([
    "No nos mandes datos bancarios por acá.",
    "Nunca te vamos a pedir tu clave fiscal.",
    "Mandá la factura sin datos bancarios.",
    "Please do not send passwords by email.",
    "Never share your card number in this chat.",
    "Razón social, CUIT y domicilio del comprador iguales a los del registro del importador en el estudio.",
    "Recibimos el packing list; falta el certificado de origen.",
    "Si no podés, mandanos el PDF por el link de carga.",
    "Please confirm the gross weight of the packing list.",
  ])("does not flag %s", (text) => {
    expect(findSensitiveAsk(text)).toBeUndefined();
  });

  it("returns the term, never the value that follows it", () => {
    const ask = findSensitiveAsk("Pasame el CBU 0000003100012345678901");
    expect(ask).toEqual({ term: "cbu", cue: "pasame" });
  });
});

describe("findAvoidedWord", () => {
  it("finds CONTEXT.md words our copy avoids, whole-word and accent-insensitive", () => {
    expect(findAvoidedWord("Tu expediente está completo")).toBe("expediente");
    expect(findAvoidedWord("El vencimiento es mañana")).toBe("vencimiento");
    expect(findAvoidedWord("Estado del despacho: canal naranja")).toBeUndefined();
    expect(findAvoidedWord("Embarcamos el pedido")).toBeUndefined();
  });

  it("strips accents without touching the base letters", () => {
    expect(stripAccents("Operación número")).toBe("Operacion numero");
  });
});
