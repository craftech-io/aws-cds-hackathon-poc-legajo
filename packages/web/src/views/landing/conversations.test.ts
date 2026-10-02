// The story of the tour as each party reads it (docs/landing-spec.md §1.4): the English gloss is
// English all the way through (never a Spanish parameter of the template inside it), and the order of
// the story holds: the importer is told the file is complete only after the ETA change asked for the
// documents again, never before.
import { DISPATCH_GLOSSARY } from "@legajo/bff/copy/dispatch-glossary";
import { docTypeOfEsAR, labelsEsAR } from "@legajo/bff/copy/es-AR";
import { OBSERVATION_LABELS } from "@legajo/bff/copy/observation-labels";
import { describe, expect, it } from "vitest";
import { CONVERSATION_IDS, CORRECTION_TARGET, conversation } from "./conversations";
import { TOUR_STEPS } from "./tour-steps";

/** Every Spanish value a template parameter can take in the story: documents, fields, customs statuses. */
const SPANISH_PARAMETERS = [
  CORRECTION_TARGET,
  ...Object.values(docTypeOfEsAR),
  ...Object.values(labelsEsAR.docType),
  ...Object.values(OBSERVATION_LABELS).map((label) => label.esField),
  ...Object.values(DISPATCH_GLOSSARY).flatMap((entry) => [entry.statusText, entry.explanation]),
].filter((text) => text.length > 0 && !/^packing list$/i.test(text));

const messages = CONVERSATION_IDS.flatMap((id) => conversation(id).messages.map((message) => ({ id, message })));

describe("English gloss of the tour's WhatsApp [FL-089]", () => {
  it("never carries a Spanish parameter of the template, in a message or a button", () => {
    for (const { id, message } of messages) {
      const glosses = [message.gloss, ...message.buttons.map((button) => button.gloss)];
      for (const gloss of glosses) for (const spanish of SPANISH_PARAMETERS) expect(gloss.toLowerCase(), `${id}: ${gloss}`).not.toContain(spanish.toLowerCase());
    }
  });

  it("names the correction and the missing documents in English", () => {
    expect(conversation("noAction").messages[0]?.gloss).toContain("the gross weight of the packing list");
    expect(conversation("request").messages[0]?.gloss).toContain("Missing: certificate of origin and packing list.");
  });
});

describe("order of the story [FL-089]", () => {
  const complete = /complete for the firm to review/;
  it("tells the importer the file is complete only after the ETA change, in the approval step", () => {
    const where = CONVERSATION_IDS.filter((id) => conversation(id).messages.some((message) => complete.test(message.gloss)));
    expect(where).toEqual(["approval"]);
    const eta = TOUR_STEPS.findIndex((step) => step.id === "eta");
    const approval = TOUR_STEPS.findIndex((step) => step.id === "approval");
    expect(approval).toBeGreaterThan(eta);
    const [arrived] = conversation("approval").messages;
    const [deadline] = conversation("eta").messages;
    expect(arrived?.gloss).toMatch(complete);
    expect(`${conversation("approval").day} ${arrived?.time}` > `${conversation("eta").day} ${deadline?.time}`).toBe(true);
  });

  it("asks the supplier for the fix in step 5 and leaves the importer nothing to do yet", () => {
    const owner = conversation("noAction").messages;
    expect(owner).toHaveLength(1);
    expect(owner[0]?.gloss).toMatch(/you do not have to do anything/);
  });
});
