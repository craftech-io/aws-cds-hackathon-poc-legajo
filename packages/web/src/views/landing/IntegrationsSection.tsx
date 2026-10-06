// "Cómo se integra" (docs/landing-spec.md §1.8 and §2.8): four lanes read in order (the parties'
// channels, the agent, time and events, your systems), AWS services by their official names and no
// logos (D-05), WhatsApp only as a channel (D-04), the three sales points, and the block for trade-
// software platforms with its own "Hablemos de integrarlo" (D-13). Plain HTML lists, so it reflows on
// a phone and a screen reader reads it in order.
import { buttonClass } from "../../components/Button";
import { SectionShell } from "../../components/Section";
import type { NodeVisual } from "./architecture";
import { Icon, type IconName } from "./icons";
import { useLandingCopy } from "./lang";
import { EXTERNAL_LINK, contactHref } from "./links";
import { NodeIcon } from "./NodeIcon";

type NodeKey = "whatsapp" | "email" | "upload" | "agentcore" | "guardrails" | "scheduler" | "reader" | "platform";
type LaneKey = "channels" | "agent" | "time" | "systems";

const LANES: ReadonlyArray<{ readonly key: LaneKey; readonly icon: IconName; readonly nodes: readonly NodeKey[] }> = [
  { key: "channels", icon: "chat", nodes: ["whatsapp", "email", "upload"] },
  { key: "agent", icon: "policy", nodes: ["agentcore", "guardrails"] },
  { key: "time", icon: "clock", nodes: ["scheduler"] },
  { key: "systems", icon: "reader", nodes: ["reader", "platform"] },
];

/** The icon of each node: the service's official architecture icon, or the landing's own for what is not a service. */
const aws = (file: string): NodeVisual => ({ aws: `/landing/aws/${file}.svg` });
const NODE_VISUALS: Readonly<Record<NodeKey, NodeVisual>> = {
  whatsapp: aws("AWSEndUserMessaging"),
  email: aws("AmazonSimpleEmailService"),
  upload: aws("AmazonSimpleStorageService"),
  agentcore: aws("AmazonBedrockAgentCore"),
  guardrails: { icon: "shield" },
  scheduler: aws("AmazonEventBridge"),
  reader: { icon: "reader" },
  platform: { icon: "documents" },
};

/** "Amazon SES · envío y recepción…": the service, then what it does here. */
function Node({ node, text }: { readonly node: NodeKey; readonly text: string }) {
  const [name = text, ...rest] = text.split(" · ");
  return (
    <li className="flex items-start gap-3 rounded-card border border-rule bg-manifest px-3 py-2.5">
      <NodeIcon visual={NODE_VISUALS[node]} size="sm" tone="paper" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{name}</p>
        {rest.length > 0 ? <p className="mt-0.5 text-sm text-ink-muted">{rest.join(" · ")}</p> : null}
      </div>
    </li>
  );
}

export function IntegrationsSection() {
  const { integrations, cta } = useLandingCopy();
  return (
    <SectionShell id="integrations" eyebrow={integrations.eyebrow} title={integrations.title} lead={integrations.lead} tone="light">
      <figure>
        <figcaption className="sr-only">{integrations.diagramAlt}</figcaption>
        <ol className="grid gap-3 xl:grid-cols-4 xl:gap-6">
          {LANES.map((lane, index) => (
            <li key={lane.key} data-reveal="" className="relative flex flex-col rounded-panel border border-rule bg-white p-4 shadow-card">
              <p className="flex items-center gap-2 font-display text-eyebrow font-semibold uppercase text-signal-ink">
                <Icon name={lane.icon} className="h-4 w-4" />
                {index + 1} · {integrations.lanes[lane.key]}
              </p>
              <ul className="mt-3 grid flex-1 content-start gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-1">
                {lane.nodes.map((node) => (
                  <Node key={node} node={node} text={integrations.nodes[node]} />
                ))}
              </ul>
              {index < LANES.length - 1 ? (
                <span aria-hidden="true" className="absolute -bottom-3 left-1/2 z-10 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full bg-harbor-950 text-foam xl:-right-5 xl:bottom-auto xl:left-auto xl:top-1/2 xl:-translate-y-1/2 xl:translate-x-0">
                  <Icon name="arrowDown" className="h-3.5 w-3.5 xl:-rotate-90" />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </figure>
      <ul className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-x-8">
        {integrations.points.map((point) => (
          <li key={point} className="flex items-center gap-2 font-semibold text-ink">
            <Icon name="check" className="h-5 w-5 text-glass-ink" />
            {point}
          </li>
        ))}
      </ul>
      <div data-reveal="" className="mt-12 grid gap-6 rounded-panel bg-harbor-950 p-6 text-foam sm:p-8 lg:grid-cols-2 lg:items-center" data-tone="dark">
        <div>
          <h3 className="font-display text-h3 font-semibold">{integrations.platforms.title}</h3>
          <p className="mt-3 text-base text-foam-muted">{integrations.platforms.lead}</p>
          <a href={contactHref("platform")} {...EXTERNAL_LINK} title={cta.talkHint} className={`${buttonClass("primary-signal")} mt-6 w-full sm:w-auto`}>
            {integrations.platforms.cta}
            <Icon name="external" className="h-4 w-4" />
            <span className="sr-only">{cta.newTab}</span>
          </a>
        </div>
        <ul className="space-y-3 text-base">
          {integrations.platforms.items.map((item) => (
            <li key={item} className="flex gap-2.5">
              <Icon name="check" className="mt-1 h-4 w-4 text-glass" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </SectionShell>
  );
}
