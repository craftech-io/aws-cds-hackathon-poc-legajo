// Placeholder of the guided-tour panel until WP-35 replaces this file with the steps of
// views/tour/steps.ts (docs/design-brief.md §15). The shell shows it in its side panel, open from the
// start for a judge; console-routes.tsx loads the default export lazily.
import { copy } from "../../copy/console";

export default function View() {
  return <p className="text-sm text-slate">{copy.tour.lead}</p>;
}
