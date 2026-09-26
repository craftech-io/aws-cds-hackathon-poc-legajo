// A frame of the landing is refused when its text shows a forbidden term, a token or a key, and the
// refusal never repeats what it found (docs/design-brief.md §9).
import { describe, expect, it } from "vitest";
import { parseTerms } from "../lint/forbidden-terms";
import { assertCleanFrame, frameProblems, termsFor } from "./frame-check";

const TERMS = parseTerms("Zeta Brokers Group\nomegasoft");

describe("landing frame check", () => {
  it("passes the synthetic console text", () => {
    expect(frameProblems("Operación 4471 · Norpampa Insumos SRL\nEstudio Delta via Legajo listo <op-4471-k7p2q9@legajo.demo.craftech.io>", TERMS)).toEqual([]);
  });

  it("finds tokens, keys, upload links and forbidden terms by line, without the matched text", () => {
    const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"].join(".");
    const text = ["ok", `Bearer ${jwt}`, "key AKIAABCDEFGHIJKLMNOP", "https://legajo.demo.craftech.io/u/Zq3v9Kf0mX2bR7wLpT4yNc8hJd1sGa6eUo5iQkVxWtY", "made by OmegaSoft"].join("\n");
    const problems = frameProblems(text, TERMS);
    expect(problems).toEqual([
      "a JSON web token on line 2",
      "an AWS access key id on line 3",
      "an upload link with its token on line 4",
      "term #2 of the forbidden list on line 5",
    ]);
    expect(() => assertCleanFrame("console-audit", text, TERMS)).toThrow(/console-audit: the frame shows/);
    expect(() => assertCleanFrame("console-audit", text, TERMS)).not.toThrow(/OmegaSoft|AKIA|eyJ/);
  });

  it("fails closed without the list for a console capture, and only warns for a local render", () => {
    expect(() => termsFor(true, {})).toThrow(/FORBIDDEN_TERMS/);
    expect(() => termsFor(false, { CI: "true" })).toThrow(/FORBIDDEN_TERMS/);
    expect(termsFor(false, {})).toEqual([]);
    expect(termsFor(true, { FORBIDDEN_TERMS: "omegasoft" })).toHaveLength(1);
  });
});
