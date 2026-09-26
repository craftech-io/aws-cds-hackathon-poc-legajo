// What each scene shows (scenes.ts): the importer's phone, the email thread with the supplier, the
// milestones an ETA change moves, or the decisions of the contact policy and Cedar with their rule.
// A pending the policy decided in the scene is shown as the console shows it: reason and rule id.
import { Badge } from "../../components/Badge";
import { RuleChip } from "../../components/RuleChip";
import { STORY, conversation } from "./conversations";
import { EmailThread } from "./EmailThread";
import { useLandingCopy } from "./lang";
import { MediaFigure } from "./MediaFigure";
import type { MediaState } from "./media";
import { DECISIONS, ETA_MILESTONES, type Scene, type SceneDeferral } from "./scenes";
import { WhatsAppPhone } from "./WhatsAppPhone";

function Deferral({ deferral }: { readonly deferral: SceneDeferral }) {
  const { story } = useLandingCopy();
  return (
    <p className="flex flex-col gap-2 rounded-card border border-warning bg-warning-soft px-4 py-3 text-sm text-ink">
      <span>{story.deferrals[deferral.note]}</span>
      <span>
        <RuleChip ruleId={deferral.rule} compact />
      </span>
    </p>
  );
}

function EtaChange() {
  const { story } = useLandingCopy();
  const { eta } = story;
  return (
    <div className="grid items-start gap-6 sm:grid-cols-2">
      <div className="space-y-3">
        <p className="rounded-card border border-info bg-info-soft px-4 py-3 text-sm text-ink">{eta.event}</p>
        <table className="w-full overflow-hidden rounded-card border border-mist bg-white text-left text-xs shadow-card">
          <caption className="px-4 pt-3 text-left text-sm font-semibold text-navy">{eta.tableLabel}</caption>
          <thead className="text-slate">
            <tr>
              <th scope="col" className="px-4 py-2 font-semibold">
                {eta.milestone}
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                {eta.before}
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                {eta.after}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-mist">
            {ETA_MILESTONES.map((milestone) => (
              <tr key={milestone.id}>
                <th scope="row" className="px-4 py-2 font-medium text-ink">
                  {eta.milestones[milestone.id]}
                </th>
                <td className="px-2 py-2 text-slate line-through">{milestone.before}</td>
                <td className="px-2 py-2 font-semibold text-navy">{milestone.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <WhatsAppPhone conversation={conversation("eta")} firmName={STORY.firmName} />
    </div>
  );
}

function Decisions() {
  const { story } = useLandingCopy();
  return (
    <div className="overflow-hidden rounded-card border border-mist bg-white shadow-card">
      <p className="border-b border-mist px-4 py-3 text-sm font-semibold text-navy">{story.decisionsTitle}</p>
      <ul className="divide-y divide-mist">
        {DECISIONS.map((decision) => {
          const text = story.decisions[decision.rule];
          return (
            <li key={decision.rule} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <span className="text-sm text-ink">{text.attempt}</span>
              <span className="flex flex-wrap items-center gap-2 sm:justify-end">
                <Badge tone={decision.outcome === "deferred" ? "warning" : "danger"}>
                  {story.outcomes[decision.outcome]} · {text.outcome}
                </Badge>
                <RuleChip ruleId={decision.rule} compact />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SceneVisual({ scene, media }: { readonly scene: Scene; readonly media: MediaState }) {
  const { visual } = scene;
  switch (visual.kind) {
    case "phone":
      return (
        <div className="grid items-start gap-6 sm:grid-cols-2">
          <WhatsAppPhone conversation={conversation(visual.conversation)} firmName={STORY.firmName} />
          <div className="space-y-4">
            {visual.deferral ? <Deferral deferral={visual.deferral} /> : null}
            {visual.media ? <MediaFigure media={media} id={visual.media} captioned /> : null}
          </div>
        </div>
      );
    case "supplier":
      return <EmailThread />;
    case "eta":
      return <EtaChange />;
    case "decisions":
      return <Decisions />;
  }
}
