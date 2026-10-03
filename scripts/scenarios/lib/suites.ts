// The scenarios of docs/test-plan.md §4.5 and the two suites (§5): `smoke` is SC-00, what every deploy
// runs; `full` is every scenario, SC-25 then SC-24 in one lane (one guest account) and SC-20 last.
// SC-23 (live WhatsApp) joins when P-01 is closed; the light load runs only when named.
import { loadLight } from "../load-light";
import { sc00 } from "../sc-00-smoke";
import { sc01 } from "../sc-01-happy-path";
import { sc02 } from "../sc-02-observation";
import { sc03 } from "../sc-03-two-attempts";
import { sc04 } from "../sc-04-wrong-unknown";
import { sc05 } from "../sc-05-bounce";
import { sc06 } from "../sc-06-no-reply";
import { sc07 } from "../sc-07-upload-link";
import { sc08 } from "../sc-08-whatsapp-pdf";
import { sc09 } from "../sc-09-questions";
import { sc10 } from "../sc-10-eta";
import { sc11 } from "../sc-11-window-hours";
import { sc12 } from "../sc-12-handoff";
import { sc13 } from "../sc-13-approval";
import { sc14 } from "../sc-14-dispatch";
import { sc15 } from "../sc-15-email-security";
import { sc16 } from "../sc-16-consent-registry";
import { sc17 } from "../sc-17-promise-hours";
import { sc18 } from "../sc-18-identity";
import { sc19 } from "../sc-19-failures";
import { sc20 } from "../sc-20-audit";
import { sc21 } from "../sc-21-complaint";
import { sc22 } from "../sc-22-observations";
import { sc24 } from "../sc-24-guest";
import { sc25 } from "../sc-25-guest-sessions";
import { sc26 } from "../sc-26-public-signup";
import type { ScenarioDef, Suite } from "./steps";

/** In the order they are listed; the runner puts lanes, `alone` and `last` in place. SC-25 goes before SC-24. */
export const SCENARIOS: readonly ScenarioDef[] = [sc00, sc01, sc02, sc03, sc04, sc05, sc06, sc07, sc08, sc09, sc10, sc11, sc12, sc13, sc14, sc15, sc16, sc17, sc18, sc19, sc21, sc22, sc25, sc24, sc26, sc20, loadLight];

export function scenariosOf(suite: Suite): ScenarioDef[] {
  return SCENARIOS.filter((scenario) => scenario.suites.includes(suite));
}

/** Scenarios named with `--scenario SC-xx` (repeatable), in the suite's order. */
export function namedScenarios(ids: readonly string[]): ScenarioDef[] {
  const unknown = ids.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length > 0) throw new RangeError(`unknown scenario(s): ${unknown.join(", ")}`);
  return SCENARIOS.filter((scenario) => ids.includes(scenario.id));
}
