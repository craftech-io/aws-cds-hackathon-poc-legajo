// Stand-in of a view that a later work package builds (docs/build-plan.md, wave 5): the title and
// description of its route, so the shell, the navigation and the role guards work end to end before
// the data exists. Each views/<id>/View.tsx renders one until its package replaces the file.
import { copy } from "../copy/console";
import type { RouteId } from "../routes";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";

export function ViewPlaceholder({ id }: { readonly id: RouteId }) {
  const view = copy.views[id];
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <EmptyState title={copy.placeholder.title} lead={copy.placeholder.lead} />
    </div>
  );
}
