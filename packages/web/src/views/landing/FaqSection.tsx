// The six frequently asked questions (docs/landing-spec.md §2.13), each a `<details>` the visitor opens,
// with "Hablemos" in the answer about cost. Every answer says only what the design backs.
import { SectionShell } from "../../components/Section";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";
import { EXTERNAL_LINK, contactHref } from "./links";

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
