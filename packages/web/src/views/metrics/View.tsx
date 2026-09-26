// Placeholder of the metrics view until WP-35 replaces this file (docs/build-plan.md §4): the route's
// title and description inside the shell. console-routes.tsx loads the default export lazily.
import { ViewPlaceholder } from "../../components/ViewPlaceholder";

export default function View() {
  return <ViewPlaceholder id="metrics" />;
}
