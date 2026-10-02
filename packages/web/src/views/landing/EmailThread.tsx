// The email thread with the supplier as the demo mailbox shows it (conversations.ts): plain text, the
// operation's address on every email, in English. Subjects, the sender's name and the simulated
// supplier's replies are the real texts of packages/bff/src/copy; the bodies the agent writes are
// examples and say so. A step of the tour shows the part of the thread it is about.
import { STORY, SUPPLIER_THREAD, type EmailView } from "./conversations";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";

function EmailCard({ email }: { readonly email: EmailView }) {
  const copy = useLandingCopy();
  const outgoing = email.direction === "out";
  return (
    <li className={`overflow-hidden rounded-card border bg-white text-ink shadow-card ${outgoing ? "border-rule" : "border-glass"}`}>
      <div className="space-y-0.5 border-b border-rule bg-manifest px-4 py-2 text-xs text-ink-muted">
        <p className="wrap-anywhere">
          <span className="font-semibold text-ink">{copy.email.from}:</span> {email.from}
        </p>
        <p className="wrap-anywhere">
          <span className="font-semibold text-ink">{copy.email.to}:</span> {email.to}
        </p>
        <p className="text-ink">
          <span className="font-semibold">{copy.email.subject}:</span> {email.subject}
        </p>
        <p>{copy.email.when(email.at.ar, email.at.supplier)}</p>
      </div>
      <pre lang="en" className="whitespace-pre-wrap px-4 py-3 font-sans text-xs leading-relaxed text-ink">
        {email.body}
      </pre>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs text-ink-muted">
        <span className={`rounded-pill px-2.5 py-0.5 font-semibold ${email.source === "agent" ? "bg-manifest-deep text-signal-ink" : "bg-manifest-deep text-glass-ink"}`}>
          {email.source === "agent" ? copy.email.agent : copy.email.simulator}
        </span>
        {email.attachments.map((file) => (
          <span key={file} className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 font-mono text-ink">
            <Icon name="document" className="h-3.5 w-3.5" />
            {file}
          </span>
        ))}
      </div>
    </li>
  );
}

/** The emails of `ids`, in the thread's order. */
export function EmailThread({ ids }: { readonly ids: readonly EmailView["id"][] }) {
  const { email } = useLandingCopy();
  return (
    <ol aria-label={`${email.threadLabel} · ${STORY.supplierName}`} className="space-y-3">
      {SUPPLIER_THREAD.filter((item) => ids.includes(item.id)).map((item) => (
        <EmailCard key={item.id} email={item} />
      ))}
    </ol>
  );
}
