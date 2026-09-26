// The condition every delete of the QaDriver carries (docs/architecture.md §14): the item must be
// of a QA world (`world = qa`) and of a `qa-*` clock or one of the two fixed QA clocks. A demo or
// judge item never matches, whatever key the caller built.
import { JUDGE_TEST_CLOCK_ID, QA_GLOBAL_CLOCK_ID } from "@legajo/shared";
import type { WriteCondition } from "./table-client";

export const QA_DELETE_CONDITION: WriteCondition = {
  equals: { world: "qa" },
  oneOf: { attribute: "clockId", prefixes: ["qa-"], values: [QA_GLOBAL_CLOCK_ID, JUDGE_TEST_CLOCK_ID] },
};
