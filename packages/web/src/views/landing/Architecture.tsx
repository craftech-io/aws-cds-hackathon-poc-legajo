// The architecture of the landing (docs/architecture.md, in four lanes): the parties and their
// channels, intake and orchestration, the agent, and outbound and data, read left to right. Plain
// HTML, so it reflows on a phone and a screen reader reads it as lists; each node that is not a real
// external service says so (simulated mode, mock).
import { useLandingCopy } from "./lang";
import { LandingSection } from "./Sections";

const TAG_TONE = { simulated: "bg-warning-soft text-warning", mock: "bg-mist text-slate", live: "bg-success-soft text-success" } as const;

export function ArchitectureSection() {
  const { architecture } = useLandingCopy();
  return (
    <LandingSection id="architecture" eyebrow={architecture.eyebrow} title={architecture.title} lead={architecture.lead}>
      <ol className="grid gap-4 lg:grid-cols-4">
        {architecture.lanes.map((lane, laneIndex) => (
          <li key={lane.title} className="relative flex flex-col rounded-card border border-mist bg-white p-4 shadow-card">
            <p className="text-xs font-semibold uppercase tracking-widest text-cyan-deep">
              {laneIndex + 1} · {lane.title}
            </p>
            <ul className="mt-3 flex flex-1 flex-col gap-3">
              {lane.nodes.map((node) => (
                <li key={node.name} className="rounded-lg border border-mist bg-paper px-3 py-2">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-navy">
                    {node.name}
                    {node.tag ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TAG_TONE[node.tag]}`}>{architecture.tags[node.tag]}</span> : null}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate">{node.note}</p>
                </li>
              ))}
            </ul>
            {laneIndex < architecture.lanes.length - 1 ? (
              <span aria-hidden="true" className="absolute -right-3.5 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-navy text-xs font-bold text-white lg:flex">
                →
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </LandingSection>
  );
}
