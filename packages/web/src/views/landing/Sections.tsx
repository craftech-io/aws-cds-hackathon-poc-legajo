// Three sections of the landing (docs/landing-spec.md §1.3, §1.5 and §1.6): the three pains with the
// "vessel on its way" line that fills as it scrolls in, what the product does for each party (an
// accordion below 768 px, three columns above), and the six guarantees in code with the real rule ids
// that enforce them (`RuleChip` takes the id from @legajo/shared, so a rule that disappears breaks
// the typecheck).
import type { RuleId } from "@legajo/shared";
import { RuleChip } from "../../components/RuleChip";
import { SectionShell } from "../../components/Section";
import { Icon, type IconName } from "./icons";
import { useLandingCopy, useRuleLabel, type LandingRuleId } from "./lang";

const PAIN_ICONS: readonly IconName[] = ["chat", "documents", "eta"];

export function ProblemSection() {
  const { problem } = useLandingCopy();
  return (
    <SectionShell id="problem" eyebrow={problem.eyebrow} title={problem.title} lead={problem.lead} tone="light">
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {problem.items.map((item, index) => (
          <li key={item.title} data-reveal="" style={{ ["--reveal-index" as string]: index }} className="rounded-panel border border-rule bg-white p-6 shadow-card md:last:col-span-2 lg:last:col-span-1">
            <Icon name={PAIN_ICONS[index] ?? "document"} className="h-7 w-7 text-signal-ink" />
            <h3 className="mt-4 font-display text-h3 font-semibold text-ink">{item.title}</h3>
            <p className="mt-2 text-base leading-relaxed text-ink-muted">{item.text}</p>
          </li>
        ))}
      </ul>
      <figure className="mt-12" aria-labelledby="problem-timeline">
        <figcaption id="problem-timeline" className="font-display text-eyebrow font-semibold uppercase text-ink-muted">
          {problem.timeline.label}
        </figcaption>
        <div className="relative mt-5">
          <div aria-hidden="true" className="h-1 rounded-pill bg-rule" />
          <div aria-hidden="true" data-timeline-fill="" className="absolute inset-x-0 top-0 h-1 origin-left rounded-pill bg-signal" />
          <ol className="mt-3 grid grid-cols-4 text-xs font-semibold text-ink sm:text-sm">
            {problem.timeline.marks.map((mark, index) => (
              <li key={mark} className={`flex items-center gap-1.5 ${index === problem.timeline.marks.length - 1 ? "justify-end" : ""}`}>
                {index === problem.timeline.marks.length - 1 ? <Icon name="ship" className="h-4 w-4 text-signal-ink" /> : null}
                {mark}
              </li>
            ))}
          </ol>
        </div>
      </figure>
    </SectionShell>
  );
}

type ActorKey = "importer" | "supplier" | "firm";

const ACTORS: ReadonlyArray<{ readonly key: ActorKey; readonly icon: IconName }> = [
  { key: "importer", icon: "chat" },
  { key: "supplier", icon: "envelope" },
  { key: "firm", icon: "documents" },
];

function ActorItems({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="mt-4 space-y-2.5 text-base text-ink">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <Icon name="check" className="mt-1 h-4 w-4 text-glass-ink" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function CapabilitiesSection() {
  const { capabilities } = useLandingCopy();
  return (
    <SectionShell id="capabilities" eyebrow={capabilities.eyebrow} title={capabilities.title} tone="alt">
      <div className="flex flex-col gap-3 md:hidden">
        {ACTORS.map(({ key, icon }, index) => (
          <details key={key} open={index === 0} className="group rounded-panel border border-rule bg-white px-5 shadow-card">
            <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 font-display text-h3 font-semibold text-ink">
              <Icon name={icon} className="h-6 w-6 text-signal-ink" />
              <span className="flex-1">{capabilities[key].title}</span>
              <Icon name="chevronRight" className="h-5 w-5 text-ink-muted transition-transform group-open:rotate-90" />
            </summary>
            <div className="pb-5">
              <p className="text-base text-ink-muted">{capabilities[key].lead}</p>
              <ActorItems items={capabilities[key].items} />
            </div>
          </details>
        ))}
      </div>
      <div className="hidden gap-4 md:grid md:grid-cols-3">
        {ACTORS.map(({ key, icon }, index) => (
          <article key={key} data-reveal="" style={{ ["--reveal-index" as string]: index }} className="rounded-panel border border-rule bg-white p-6 shadow-card">
            <Icon name={icon} className="h-7 w-7 text-signal-ink" />
            <h3 className="mt-4 font-display text-h3 font-semibold text-ink">{capabilities[key].title}</h3>
            <p className="mt-2 text-base text-ink-muted">{capabilities[key].lead}</p>
            <ActorItems items={capabilities[key].items} />
          </article>
        ))}
      </div>
    </SectionShell>
  );
}

/** The rules behind each guarantee, in the order of the copy (§1.6). */
const GUARANTEE_RULES: ReadonlyArray<readonly LandingRuleId[]> = [["CED-NO-APPROVE"], ["CP-OPTIN", "CP-HOURS-AR", "CP-HOURS-SUPPLIER", "CP-ONE-PER-DAY"], ["CP-NO-FOREIGN-LINKS"], [], [], []];
const GUARANTEE_ICONS: readonly IconName[] = ["personCheck", "policy", "linkBroken", "reader", "lock", "mask"];

function GuaranteeRule({ rule }: { readonly rule: LandingRuleId & RuleId }) {
  const label = useRuleLabel(rule);
  return <RuleChip ruleId={rule} tone="paper" {...(label ? { label } : {})} />;
}

export function GuaranteesSection() {
  const { guarantees } = useLandingCopy();
  return (
    <SectionShell id="guarantees" eyebrow={guarantees.eyebrow} title={guarantees.title} lead={guarantees.lead} tone="light">
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {guarantees.items.map((item, index) => {
          const rules = GUARANTEE_RULES[index] ?? [];
          return (
            <li key={item.title} data-reveal="" style={{ ["--reveal-index" as string]: index }} className="flex flex-col rounded-panel border border-rule bg-white p-6 shadow-card">
              <Icon name={GUARANTEE_ICONS[index] ?? "shield"} className="h-7 w-7 text-glass-ink" />
              <h3 className="mt-4 font-display text-h3 font-semibold text-ink">{item.title}</h3>
              <p className="mt-2 flex-1 text-base leading-relaxed text-ink-muted">{item.text}</p>
              {rules.length > 0 ? (
                <div className="mt-4">
                  <p className="sr-only">{guarantees.ruleLabel}</p>
                  <ul className="flex flex-wrap gap-2">
                    {rules.map((rule) => (
                      <li key={rule}>
                        <GuaranteeRule rule={rule} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </SectionShell>
  );
}
