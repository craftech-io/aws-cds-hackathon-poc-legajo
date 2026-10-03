// "Cómo funciona por dentro": the AWS architecture as six layers read top to bottom (architecture.ts),
// each AWS service with its official architecture icon, then the four steps of one message through it.
// Plain lists, so it reflows on a phone and a screen reader reads it in order; the figure carries a
// text alternative for the whole diagram.
import { SectionShell } from "../../components/Section";
import { ARCHITECTURE, type NodeVisual } from "./architecture";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";

function NodeIcon({ visual }: { readonly visual: NodeVisual }) {
  if ("aws" in visual) return <img src={visual.aws} alt="" width={40} height={40} loading="lazy" decoding="async" className="h-10 w-10 shrink-0 rounded-md" />;
  return (
    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-harbor-800 text-glass">
      <Icon name={visual.icon} className="h-5 w-5" />
    </span>
  );
}

export function ArchitectureSection() {
  const { architecture } = useLandingCopy();
  return (
    <SectionShell id="architecture" eyebrow={architecture.eyebrow} title={architecture.title} lead={architecture.lead} tone="dark">
      <figure>
        <figcaption className="sr-only">{architecture.alt}</figcaption>
        <ol className="flex flex-col gap-3">
          {ARCHITECTURE.map((layer, index) => (
            <li key={layer.id} data-reveal="" className="relative grid gap-3 rounded-panel border border-harbor-700 bg-harbor-900 p-4 lg:grid-cols-[11rem_1fr] lg:items-center">
              <p className="font-display text-eyebrow font-semibold uppercase text-glass">
                {index + 1} · {architecture.layers[layer.id]}
              </p>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {layer.nodes.map((node) => {
                  const text = architecture.nodes[node.id];
                  return (
                    <li key={node.id} className="flex items-center gap-3 rounded-card bg-harbor-950 px-3 py-2.5">
                      <NodeIcon visual={node.visual} />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-foam">{text.name}</span>
                        <span className="block text-xs leading-snug text-foam-muted">{text.role}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {index < ARCHITECTURE.length - 1 ? (
                <span aria-hidden="true" className="absolute -bottom-3 left-1/2 z-10 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full bg-signal text-harbor-950">
                  <Icon name="arrowDown" className="h-3.5 w-3.5" />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </figure>
      <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {architecture.steps.map((step, index) => (
          <li key={step.title} data-reveal="" className="rounded-panel border border-harbor-700 p-5">
            <p className="font-display text-h3 font-semibold text-signal">{index + 1}</p>
            <h3 className="mt-2 font-display text-base font-semibold text-foam">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-foam-muted">{step.text}</p>
          </li>
        ))}
      </ol>
    </SectionShell>
  );
}
