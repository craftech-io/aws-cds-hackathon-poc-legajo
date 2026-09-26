// A WhatsApp thread as the importer's phone shows it (conversations.ts): the firm's messages on the
// left, the importer's on the right, a template's buttons under its bubble, each message with its
// fixed English gloss behind "EN" (shown by default on the English page). The frame always says
// "simulador": WhatsApp runs in simulated mode, and this is an illustration, not a capture.
import { useState } from "react";
import type { ConversationView, WaButtonView, WaMessageView } from "./conversations";
import { useLandingCopy, useLandingLang } from "./lang";

/** "ED" for "Estudio Delta": the avatar of the firm's chat. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
}

function Buttons({ buttons }: { readonly buttons: readonly WaButtonView[] }) {
  if (buttons.length === 0) return null;
  return (
    <ul className="mt-1 divide-y divide-mist overflow-hidden rounded-xl bg-white shadow-card">
      {buttons.map((button) => (
        <li key={button.text} className="px-3 py-2 text-center text-xs font-semibold text-cyan-deep">
          {button.url ? <span aria-hidden="true">↗ </span> : null}
          {button.text}
        </li>
      ))}
    </ul>
  );
}

function Message({ message, gloss }: { readonly message: WaMessageView; readonly gloss: boolean }) {
  const { phone } = useLandingCopy();
  const fromFirm = message.from === "firm";
  const source = phone.sources[message.source];
  return (
    <li className={`flex max-w-[86%] flex-col ${fromFirm ? "self-start" : "self-end"}`}>
      <div className={`rounded-2xl px-3 py-2 text-xs leading-relaxed text-ink shadow-card ${fromFirm ? "rounded-tl-sm bg-white" : "rounded-tr-sm bg-success-soft"}`}>
        {source ? <p className="mb-1 text-xs font-semibold text-cyan-deep">{source}</p> : null}
        <p lang="es-AR" className="whitespace-pre-line">
          {message.text}
        </p>
        {gloss ? (
          <p lang="en" className="mt-1.5 border-t border-mist pt-1.5 italic text-slate">
            <span className="mr-1 font-semibold not-italic text-navy">EN</span>
            {message.gloss}
          </p>
        ) : null}
        <p className="mt-1 text-right text-xs text-slate">{message.time}</p>
      </div>
      <Buttons buttons={message.buttons} />
    </li>
  );
}

interface WhatsAppPhoneProps {
  readonly conversation: ConversationView;
  /** Only the first messages (the hero shows the opening template). */
  readonly limit?: number;
  readonly className?: string;
  /** The caption sits on a dark background (the hero). */
  readonly onDark?: boolean;
  /** Firm name of the header (fictitious). */
  readonly firmName: string;
}

export function WhatsAppPhone({ conversation, limit, className = "", onDark = false, firmName }: WhatsAppPhoneProps) {
  const { phone } = useLandingCopy();
  const english = useLandingLang()?.lang === "en";
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const gloss = chosen ?? english;
  const messages = limit === undefined ? conversation.messages : conversation.messages.slice(0, limit);
  return (
    <figure className={`mx-auto w-full max-w-xs ${className}`}>
      <div className="rounded-4xl border-4 border-navy-deep bg-navy-deep p-1.5 shadow-card">
        <div className="overflow-hidden rounded-3xl bg-paper">
          <p className="bg-warning-soft px-4 py-1 text-center text-xs font-semibold text-warning">{phone.simulator}</p>
          <div className="flex items-center gap-2 bg-navy px-4 py-3 text-white">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan text-xs font-bold text-navy-deep">
              {initials(firmName)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{firmName}</p>
              <p className="text-xs text-cyan-soft">{phone.fictitious}</p>
            </div>
            <button
              type="button"
              aria-pressed={gloss}
              aria-label={phone.glossToggle}
              title={phone.glossToggle}
              onClick={() => setChosen(!gloss)}
              className={`rounded-md border px-2 py-1 text-xs font-semibold ${gloss ? "border-cyan bg-cyan text-navy-deep" : "border-navy-soft text-white hover:bg-navy-soft"}`}
            >
              EN
            </button>
          </div>
          <p className="pt-3 text-center">
            <span className="rounded-md bg-white px-2 py-0.5 text-xs text-slate shadow-card">{conversation.day}</span>
          </p>
          <ol aria-label={phone.conversation(conversation.day)} className="flex max-h-112 min-h-64 flex-col gap-3 overflow-y-auto px-3 py-4">
            {messages.map((message, index) => (
              <Message key={`${conversation.id}-${index}`} message={message} gloss={gloss} />
            ))}
          </ol>
        </div>
      </div>
      <figcaption className={`mt-2 text-center text-xs ${onDark ? "text-cyan-soft" : "text-slate"}`}>{phone.caption}</figcaption>
    </figure>
  );
}
