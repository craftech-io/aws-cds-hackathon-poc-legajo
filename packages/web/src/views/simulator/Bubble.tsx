// One message on the importer's phone, drawn as WhatsApp draws it: the importer's own on the right,
// the firm's on the left with its template body, reply buttons (tapping one sends the button's action
// through the BFF, which resolves its nonce), the URL button that opens the upload link, attachments,
// the hour and the ticks. A template or fixed text carries its English gloss behind "EN".
import { useId, useState } from "react";
import { simulatorCopy } from "./copy";
import type { SimButton, SimMessage } from "./simulator-api";
import { bubbleTime, ticksOf } from "./simulator-model";

const copy = simulatorCopy.phone;

interface BubbleProps {
  readonly message: SimMessage;
  readonly onTap: (message: SimMessage, button: SimButton) => void;
  readonly tapping: boolean;
}

function ReplyButton({ message, button, onTap, tapping }: { readonly message: SimMessage; readonly button: SimButton } & Omit<BubbleProps, "message">) {
  const className = "block w-full border-t border-mist px-3 py-2 text-center text-sm font-semibold text-cyan-deep hover:bg-paper disabled:opacity-50";
  if (button.url) {
    return (
      <a href={button.url} target="_blank" rel="noopener noreferrer" className={className} title={copy.openLink(button.title)}>
        {button.title}
      </a>
    );
  }
  return (
    <button type="button" className={className} disabled={tapping} title={copy.tapLabel(button.title)} onClick={() => onTap(message, button)}>
      {button.title}
    </button>
  );
}

function Gloss({ message }: { readonly message: SimMessage }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttons = message.buttons.filter((button) => button.glossEn);
  if (!message.glossEn && buttons.length === 0) return null;
  return (
    <div className="mt-1">
      <button type="button" aria-pressed={open} aria-controls={id} title={copy.glossShow} className="rounded bg-mist px-1.5 py-0.5 text-xs font-bold text-navy" onClick={() => setOpen((value) => !value)}>
        {copy.gloss}
      </button>
      {open ? (
        <div id={id} lang="en" aria-label={copy.glossLabel} className="mt-1 rounded bg-info-soft px-2 py-1 text-xs text-info italic">
          {message.glossEn ? <p>{message.glossEn}</p> : null}
          {buttons.length > 0 ? <p className="mt-1">{buttons.map((button) => `[${button.glossEn ?? ""}]`).join(" ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Bubble({ message, onTap, tapping }: BubbleProps) {
  const own = message.direction === "IN";
  const ticks = ticksOf(message);
  return (
    <li className={`flex ${own ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-72 overflow-hidden rounded-lg shadow-card ${own ? "bg-success-soft" : "bg-white"}`}>
        <div className="px-3 pt-2 pb-1">
          {message.template ? <p className="mb-1 text-xs font-semibold text-slate uppercase">{copy.template}</p> : null}
          <p className="whitespace-pre-wrap break-words text-sm text-ink">{message.body}</p>
          {message.attachments.map((attachment) => (
            <p key={attachment.index} className="mt-1 flex items-center gap-2 rounded bg-paper px-2 py-1 text-xs text-navy">
              <span aria-hidden="true" className="rounded bg-danger px-1 font-bold text-white">
                PDF
              </span>
              {attachment.status === "ACCEPTED" ? copy.attachment : copy.attachmentRejected}
            </p>
          ))}
          <Gloss message={message} />
          <p className="mt-1 flex items-center justify-end gap-1 text-xs text-slate">
            <time dateTime={message.sentAtSim}>{bubbleTime(message)}</time>
            {ticks ? (
              <span title={ticks.label} aria-label={ticks.label} className={ticks.read ? "font-bold text-info" : ""}>
                {ticks.symbol}
              </span>
            ) : null}
          </p>
        </div>
        {!own && message.buttons.length > 0 ? (
          <div>
            {message.buttons.map((button) => (
              <ReplyButton key={`${button.action}-${button.title}`} message={message} button={button} onTap={onTap} tapping={tapping} />
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}
