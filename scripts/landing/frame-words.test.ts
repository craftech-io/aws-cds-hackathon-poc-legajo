// Every frame of the landing is checked against the neutral list of ADR-0014 §2 before it is written
// (FL-129): each word and the phrase, in any case, accented or inside an identifier, makes the frame
// fail by name and line; the list is imported, never copied.
import { describe, expect, it } from "vitest";
import { NEUTRAL_PHRASE, NEUTRAL_WORDS } from "../lint/neutral-words";
import { assertCleanFrame, frameProblems } from "./frame-check";

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

describe("neutral words in a frame [FL-129]", () => {
  it.each(NEUTRAL_WORDS)("refuses a frame that shows %s, in any form", (word) => {
    for (const form of [word, word.toUpperCase(), capitalized(word), `is${capitalized(word)}Button`]) {
      expect(frameProblems(`Legajo listo\nsee ${form} here`, []), form).toEqual([`the neutral word "${word}" on line 2`]);
    }
  });

  it("refuses the phrase spaced, hyphenated or in camel case", () => {
    const [first = "", second = ""] = NEUTRAL_PHRASE.split(" ");
    for (const form of [NEUTRAL_PHRASE.toUpperCase(), `${first}-${second}`, `${capitalized(first)}${capitalized(second)}`]) {
      expect(frameProblems(form, []), form).toEqual([`the neutral word "${NEUTRAL_PHRASE}" on line 1`]);
    }
  });

  it("passes the product's own words and fails the frame by name", () => {
    expect(frameProblems("Probar la demo · Invitado · Guest · evaluar · premium", [])).toEqual([]);
    const [word = ""] = NEUTRAL_WORDS;
    expect(() => assertCleanFrame("console-tour", word, [])).toThrow(`console-tour: the frame shows the neutral word "${word}" on line 1`);
  });
});
