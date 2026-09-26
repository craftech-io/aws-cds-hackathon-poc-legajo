// Scene 3 as the demo mailbox shows it: the email thread with the supplier, in plain text, with the
// reader's result after each email that carried PDFs. Subjects, the sender's name and the simulated
// supplier's replies are the real texts of packages/bff/src/copy; the bodies the agent writes are
// examples and say so. The reader's result is what the external reader returns (ADR-0003).
import { Fragment } from "react";
import { Badge } from "../../components/Badge";
import { STORY, SUPPLIER_THREAD, type EmailView } from "./conversations";
import { useLandingCopy } from "./lang";
import { READINGS } from "./scenes";

function EmailCard({ email }: { readonly email: EmailView }) {
  const copy = useLandingCopy();
  const outgoing = email.direction === "out";
  return (
    <li className={`overflow-hidden rounded-card border bg-white shadow-card ${outgoing ? "border-mist" : "border-cyan-soft"}`}>
      <div className="space-y-0.5 border-b border-mist bg-paper px-4 py-2 text-xs text-slate">
        <p className="break-all">
          <span className="font-semibold text-ink">{copy.email.from}:</span> {email.from}
        </p>
        <p className="break-all">
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
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs text-slate">
        <Badge tone={email.source === "agent" ? "brand" : "neutral"}>{email.source === "agent" ? copy.email.agent : copy.email.simulator}</Badge>
        {email.attachments.map((file) => (
          <span key={file} className="inline-flex items-center gap-1 rounded-md border border-mist px-2 py-0.5 font-mono text-ink">
            <span aria-hidden="true" className="rounded bg-danger px-1 text-white">
              PDF
            </span>
            {file}
          </span>
        ))}
      </div>
    </li>
  );
}

function ReaderCard({ after }: { readonly after: EmailView["id"] }) {
  const { story } = useLandingCopy();
  const { labels, reader } = story;
  const readings = READINGS.filter((reading) => reading.after === after);
  if (readings.length === 0) return null;
  return (
    <li className="rounded-card border border-info bg-info-soft px-4 py-3 text-xs text-ink">
      <p className="font-semibold text-info">{reader.title}</p>
      <ul className="mt-2 space-y-1.5">
        {readings.map((reading) => (
          <li key={`${reading.docType}-${reading.version}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">
              {labels.docType[reading.docType]} · {reader.version(reading.version)}
            </span>
            <Badge tone={reading.status === "VALID" ? "success" : "warning"}>{labels.docStatus[reading.status]}</Badge>
            {reading.status === "WITH_OBSERVATION" ? (
              <span className="w-full text-slate">
                {story.observation("GROSS_WEIGHT_MISMATCH")}: {story.kg(STORY.grossWeightKg.found)} {reader.found} · {story.kg(STORY.grossWeightKg.expected)} {reader.expected} ·{" "}
                {reader.responsible}: {labels.party.SUPPLIER}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function EmailThread() {
  const { email } = useLandingCopy();
  return (
    <ol aria-label={email.threadLabel} className="space-y-3">
      {SUPPLIER_THREAD.map((item) => (
        <Fragment key={item.id}>
          <EmailCard email={item} />
          <ReaderCard after={item.id} />
        </Fragment>
      ))}
    </ol>
  );
}
