// A WhatsApp thread as the importer's phone shows it (conversations.ts), drawn in the landing's own
// style (no third-party colours or logo, docs/landing-spec.md D-04) and always labelled "Simulador":
// the channel runs in simulated mode. The firm's messages sit on the left, the importer's on the
// right, a template's buttons under its bubble, and each message carries its source (approved
// template, fixed text, sample agent text) and its fixed English gloss behind "EN" (on by default on
// the English page), buttons included. While a conversation is being written the thread is anchored to
// its newest message, so it follows it without animating the scroll; once it rests it can open at a
// chosen message instead, and a fade under the header keeps a bubble from looking cut. A pending
// message shows "escribiendo" or the tapped button lit up. In the tour the screen takes the height of
// its messages (`fit`) and FitToSlot scales the whole phone, so nothing hides behind a scroll; there
// the phone follows the tour's gloss choice (gloss.tsx) and its "EN" toggle sits in the step's footer.
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { ConversationView, WaButtonView, WaMessageView } from "./conversations";
import { useSharedGloss } from "./gloss";
import { Icon } from "./icons";
import { useLandingCopy, useLandingLang } from "./lang";

/** "ED" for "Estudio Delta": the avatar of the firm's chat. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
}

function Buttons({ buttons, lit, gloss }: { readonly buttons: readonly WaButtonView[]; readonly lit: string | undefined; readonly gloss: boolean }) {
  if (buttons.length === 0) return null;
  return (
    <ul className="mt-1 divide-y divide-rule overflow-hidden rounded-xl bg-white shadow-card">
      {buttons.map((button) => (
        <li key={button.text} className={`flex flex-wrap items-center justify-center gap-x-1 px-3 py-2 text-center text-xs font-semibold transition-colors duration-150 ${lit === button.text ? "bg-glass text-harbor-950" : "text-glass-ink"}`}>
          {button.url ? <Icon name="external" className="h-3.5 w-3.5" /> : null}
          <span lang="es-AR">{button.text}</span>
          {gloss && button.gloss !== button.text ? (
            <span lang="en" className="font-normal italic text-ink-muted">
              · {button.gloss}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Message({ message, gloss, lit, animate, hidden, index }: { readonly message: WaMessageView; readonly gloss: boolean; readonly lit: string | undefined; readonly animate: boolean; readonly hidden: boolean; readonly index: number }) {
  const { tour } = useLandingCopy();
  const fromFirm = message.from === "firm";
  const source = { template: tour.template, fixed: tour.fixed, agent: tour.agentSample, importer: "" }[message.source];
  return (
    <li
      data-message={index}
      aria-hidden={hidden || undefined}
      className={`flex max-w-[86%] flex-col transition-[opacity,transform] duration-300 ease-out ${fromFirm ? "self-start origin-bottom-left" : "self-end origin-bottom-right"} ${animate ? "animate-bubble-in" : ""} ${hidden ? "translate-y-1.5 opacity-0" : "opacity-100"}`}
    >
      <div className={`rounded-2xl px-3 py-2 text-xs leading-relaxed text-ink shadow-card ${fromFirm ? "rounded-tl-sm bg-white" : "rounded-tr-sm bg-manifest-deep"}`}>
        {source ? <p className="mb-1 text-xs font-semibold text-glass-ink">{source}</p> : null}
        <p lang="es-AR" className="whitespace-pre-line">
          {message.text}
        </p>
        {gloss ? (
          <p lang="en" className="mt-1.5 border-t border-rule pt-1.5 italic text-ink-muted">
            <span className="mr-1 font-semibold not-italic text-ink">EN</span>
            {message.gloss}
          </p>
        ) : null}
        <p className="mt-1 text-right text-xs text-ink-muted">{message.time}</p>
      </div>
      <Buttons buttons={message.buttons} lit={lit} gloss={gloss} />
    </li>
  );
}

/** The three dots of "escribiendo", 150 ms apart. */
const DOT_DELAYS = ["[animation-delay:0ms]", "[animation-delay:150ms]", "[animation-delay:300ms]"] as const;

function Typing() {
  const { phone } = useLandingCopy();
  return (
    <li className="self-start rounded-2xl rounded-tl-sm bg-white px-3 py-2.5 shadow-card">
      <span className="sr-only">{phone.typing}</span>
      <span aria-hidden="true" className="flex gap-1">
        {DOT_DELAYS.map((delay) => (
          <span key={delay} className={`h-1.5 w-1.5 animate-typing-dot rounded-full bg-ink-muted ${delay}`} />
        ))}
      </span>
    </li>
  );
}

export interface PhonePending {
  readonly phase: "typing" | "highlight" | "writing";
  /** The text the importer is writing, so far. */
  readonly partial?: string;
  /** The button the importer is about to tap. */
  readonly tapped?: string;
}

interface WhatsAppPhoneProps {
  readonly conversation: Pick<ConversationView, "id" | "day">;
  readonly messages: readonly WaMessageView[];
  readonly firmName: string;
  /** Under the phone; omitted where the screen's own header labels it. */
  readonly caption?: string | undefined;
  /** The screen's height: the hero's is fixed and scrolls; `fit` takes the height of the messages (the tour). */
  readonly size?: "hero" | "fit";
  /** Messages from this index on keep their room but are not shown yet (a step's sequence). */
  readonly revealed?: number;
  /** At rest, open the thread with this message at the top instead of the newest at the bottom. */
  readonly anchor?: number;
  readonly pending?: PhonePending;
  /** New bubbles pop in (only while the hero plays). */
  readonly animate?: boolean;
  /** The list is decoration while a transcript elsewhere carries the text (the hero). */
  readonly decorative?: boolean;
  readonly children?: ReactNode;
}

const SCREEN: Readonly<Record<NonNullable<WhatsAppPhoneProps["size"]>, string>> = { hero: "h-112 overflow-y-auto overscroll-contain sm:h-120", fit: "" };

/** Scrolls `screen` so the message `anchor` sits at its top, below the fade. */
function useAnchor(screen: RefObject<HTMLDivElement | null>, anchor: number | undefined, gloss: boolean): void {
  useLayoutEffect(() => {
    const box = screen.current;
    if (!box || anchor === undefined) return;
    const target = box.querySelector<HTMLElement>(`[data-message="${anchor}"]`);
    if (!target) return;
    box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
  }, [screen, anchor, gloss]);
}

export function WhatsAppPhone({ conversation, messages, firmName, caption, size = "fit", revealed, anchor, pending, animate = false, decorative = false, children }: WhatsAppPhoneProps) {
  const { phone } = useLandingCopy();
  const english = useLandingLang()?.lang === "en";
  const shared = useSharedGloss();
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const gloss = shared?.gloss ?? chosen ?? english;
  const screen = useRef<HTMLDivElement>(null);
  useAnchor(screen, anchor, gloss);
  const scrolls = size === "hero";
  return (
    <figure className="mx-auto w-full max-w-xs">
      <div className="rounded-phone border border-harbor-700 bg-harbor-900 p-1.5 shadow-float">
        <div className="overflow-hidden rounded-[1.875rem] bg-manifest">
          <p className="bg-signal px-4 py-1 text-center text-xs font-semibold text-harbor-950">{phone.simulator}</p>
          <div className="flex items-center gap-2 bg-harbor-800 px-4 py-3 text-foam">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-glass text-xs font-bold text-harbor-950">
              {initials(firmName)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{firmName}</p>
              <p className="text-xs text-foam-muted">{phone.fictitious}</p>
            </div>
            {shared ? null : (
              <button
                type="button"
                aria-pressed={gloss}
                aria-label={phone.glossToggle}
                title={phone.glossToggle}
                onClick={() => setChosen(!gloss)}
                className={`flex h-11 min-w-11 items-center justify-center rounded-pill border px-2 text-xs font-semibold ${gloss ? "border-glass bg-glass text-harbor-950" : "border-harbor-700 text-foam hover:bg-harbor-700"}`}
              >
                EN
              </button>
            )}
          </div>
          <div className="relative">
            {/* A scrolling screen takes the keyboard's focus too (WCAG 2.1.1). */}
            <div ref={screen} role="group" tabIndex={scrolls ? 0 : undefined} aria-label={phone.conversation(conversation.day)} className={`relative flex flex-col-reverse ${SCREEN[size]}`}>
              <ol aria-hidden={decorative || undefined} className="flex flex-col gap-3 px-3 py-4">
                <li className="self-center rounded-md bg-white px-2 py-0.5 text-xs text-ink-muted shadow-card">{conversation.day}</li>
                {messages.map((message, index) => (
                  <Message
                    key={`${conversation.id}-${index}`}
                    index={index}
                    message={message}
                    gloss={gloss}
                    lit={pending?.phase === "highlight" && index === messages.length - 1 ? pending.tapped : undefined}
                    animate={animate}
                    hidden={revealed !== undefined && index >= revealed}
                  />
                ))}
                {pending?.phase === "typing" ? <Typing /> : null}
                {pending?.phase === "writing" && pending.partial ? (
                  <li className="max-w-[86%] self-end rounded-2xl rounded-tr-sm bg-manifest-deep px-3 py-2 text-xs text-ink shadow-card">{pending.partial}</li>
                ) : null}
              </ol>
            </div>
            {scrolls ? <span aria-hidden="true" data-phone-fade="" className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-linear-to-b from-manifest to-transparent" /> : null}
          </div>
          {children}
        </div>
      </div>
      {caption ? <figcaption className="mt-3 text-center text-xs text-foam-muted">{caption}</figcaption> : null}
    </figure>
  );
}
