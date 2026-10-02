// "Qué es simulado en esta demo" (docs/landing-spec.md §1.9): four columns, each service or system in
// exactly one of them (demo-columns.ts), a table from 1024 px and cards below; and the six frequently
// asked questions (§2.13), each a `<details>` the visitor opens, with "Hablemos" in the answer about
// cost. Every answer says only what the design backs.
import { SectionShell } from "../../components/Section";
import { Icon, type IconName } from "./icons";
import { useLandingCopy } from "./lang";
import { EXTERNAL_LINK, contactHref } from "./links";

const COLUMNS = [
  { key: "real", icon: "check" },
  { key: "simulatedMode", icon: "chat" },
  { key: "mocks", icon: "documents" },
  { key: "data", icon: "mask" },
] as const satisfies ReadonlyArray<{ readonly key: string; readonly icon: IconName }>;

export function DemoSection() {
  const { demo } = useLandingCopy();
  return (
    <SectionShell id="demo" eyebrow={demo.eyebrow} title={demo.title} tone="dark">
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 lg:gap-0 lg:overflow-hidden lg:rounded-panel lg:border lg:border-harbor-700">
        {COLUMNS.map(({ key, icon }, index) => (
          <li key={key} data-reveal="" className={`rounded-panel border border-harbor-700 bg-harbor-900 p-5 lg:rounded-none lg:border-0 ${index > 0 ? "lg:border-l lg:border-harbor-700" : ""}`}>
            <h3 className="flex items-center gap-2 font-display text-base font-semibold text-foam">
              <Icon name={icon} className="h-5 w-5 text-glass" />
              {demo.columns[key].title}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-foam-muted">{demo.columns[key].text}</p>
          </li>
        ))}
      </ul>
      <p className="mt-6 flex max-w-prose items-start gap-2 text-sm text-foam-muted">
        <Icon name="clock" className="mt-0.5 h-4 w-4 text-signal" />
        {demo.clock}
      </p>
    </SectionShell>
  );
}

const QUESTIONS = ["data", "reader", "platform", "whatsapp", "cost", "approval"] as const;

export function FaqSection() {
  const { faq, cta } = useLandingCopy();
  return (
    <SectionShell id="faq" eyebrow={faq.eyebrow} title={faq.title} tone="light">
      <div className="grid gap-3 lg:grid-cols-2 lg:gap-x-6">
        {QUESTIONS.map((key) => {
          const item = faq[key];
          return (
            <details key={key} className="group rounded-panel border border-rule bg-white px-5 shadow-card">
              <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 py-3 font-semibold text-ink">
                <span className="flex-1">{item.q}</span>
                <Icon name="chevronRight" className="h-5 w-5 text-ink-muted transition-transform group-open:rotate-90" />
              </summary>
              <div className="pb-5 text-base leading-relaxed text-ink-muted">
                <p>{item.a}</p>
                {key === "cost" ? (
                  <a href={contactHref("faq")} {...EXTERNAL_LINK} title={cta.talkHint} className="mt-3 inline-flex min-h-11 items-center gap-1.5 font-semibold text-signal-ink underline underline-offset-4">
                    {faq.cost.cta}
                    <Icon name="external" className="h-4 w-4" />
                    <span className="sr-only">{cta.newTab}</span>
                  </a>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </SectionShell>
  );
}
