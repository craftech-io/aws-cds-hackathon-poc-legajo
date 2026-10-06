// The pieces of the tour that are not a phone or an email (docs/landing-spec.md §1.4 and §4.3): what
// the external document reader returned (ADR-0003), the milestones an ETA change moves, the guardrail
// that stops an out-of-scope question with the firm's escalation email, the approval that only a
// person can give, and the contact policy's deferral with its real rule id. Each one takes the stage
// of its short sequence (`stage`, final when nothing may move) and draws the real texts.
import { RuleChip } from "../../components/RuleChip";
import { inLang } from "../../lib/console-lang";
import { dossierCopy } from "../dossier/copy";
import { ESCALATION_EMAIL, STORY } from "./conversations";
import { Icon } from "./icons";
import { useLandingCopy, useRuleLabel } from "./lang";
import { ETA_MILESTONES, READINGS } from "./scenes";

const CARD = "rounded-panel border border-harbor-700 bg-harbor-900 p-4 text-foam shadow-float sm:p-5";
const SHOW = "transition-[opacity,transform] duration-300 ease-out";

/** Stage reached or not: what a piece of the sequence looks like before and after it appears. */
function shown(visible: boolean): string {
  return visible ? `${SHOW} opacity-100` : `${SHOW} translate-y-1.5 opacity-0`;
}

export function DeferralNote({ stage, note }: { readonly stage: number; readonly note: "supplier" | "importer" }) {
  const { tour } = useLandingCopy();
  const rule = note === "supplier" ? "CP-HOURS-SUPPLIER" : "CP-HOURS-AR";
  const label = useRuleLabel(rule);
  return (
    <div className={`${CARD} ${shown(stage >= 2)} flex flex-col gap-2`}>
      <p className="flex items-center gap-2 text-sm">
        <Icon name="clock" className="h-4 w-4 text-signal" />
        {tour.deferral[note]}
      </p>
      <span>
        <RuleChip ruleId={rule} tone="dark" {...(label ? { label } : {})} />
      </span>
    </div>
  );
}

export function ReaderCard({ stage }: { readonly stage: number }) {
  const { tour, labels, observation, kg } = useLandingCopy();
  const readings = READINGS.filter((reading) => reading.after === "reply");
  return (
    <div className={CARD}>
      <p className="flex items-center gap-2 font-display text-sm font-semibold text-glass">
        <Icon name="reader" className="h-4 w-4" />
        {tour.reader.title}
      </p>
      <ul className="mt-3 space-y-3">
        {readings.map((reading) => {
          const valid = reading.status === "VALID";
          return (
            <li key={reading.docType} className="rounded-card border border-harbor-700 bg-harbor-950 px-3 py-2.5 text-sm">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold">
                  {labels.docType[reading.docType]} · {tour.reader.version(reading.version)}
                </span>
                <span className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-semibold ${valid ? "bg-glass text-harbor-950" : "bg-signal text-harbor-950"}`}>
                  <Icon name={valid ? "check" : "cross"} className="h-3.5 w-3.5" />
                  {labels.docStatus[reading.status]}
                </span>
              </p>
              {valid ? null : (
                <div className={`mt-2 space-y-1 text-xs text-foam-muted ${shown(stage >= 1)}`}>
                  <p className="font-semibold text-foam">{observation("GROSS_WEIGHT_MISMATCH")}</p>
                  <p>
                    {kg(STORY.grossWeightKg.found)} {tour.reader.found} · {kg(STORY.grossWeightKg.expected)} {tour.reader.expected}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Responsable": from "—" to the supplier once the agent assigns it (step 5). */
export function OwnerLine({ stage }: { readonly stage: number }) {
  const { tour, labels, observation } = useLandingCopy();
  const assigned = stage >= 1;
  return (
    <p className={`${CARD} flex flex-wrap items-center gap-x-3 gap-y-1 text-sm`}>
      <span className="text-foam-muted">{observation("GROSS_WEIGHT_MISMATCH")}</span>
      <span className="font-semibold">
        {tour.reader.owner}: <span className={assigned ? "text-glass" : "text-foam-muted"}>{assigned ? labels.party.SUPPLIER : tour.reader.pending}</span>
      </span>
    </p>
  );
}

export function EtaTable({ stage }: { readonly stage: number }) {
  const { tour } = useLandingCopy();
  const { eta } = tour;
  const moved = stage >= 1;
  return (
    <div className={CARD}>
      <p className="flex items-center gap-2 text-sm">
        <Icon name="eta" className="h-4 w-4 text-signal" />
        {eta.event}
      </p>
      <table className="mt-3 w-full text-left text-xs">
        <caption className="sr-only">{eta.tableLabel}</caption>
        <thead className="text-foam-muted">
          <tr>
            <th scope="col" className="py-1.5 pr-2 font-semibold">
              {eta.milestone}
            </th>
            <th scope="col" className="px-2 py-1.5 font-semibold">
              {eta.before}
            </th>
            <th scope="col" className="py-1.5 pl-2 font-semibold">
              {eta.after}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-harbor-700">
          {ETA_MILESTONES.map((milestone) => (
            <tr key={milestone.id}>
              <th scope="row" className="py-2 pr-2 font-medium">
                {eta.milestones[milestone.id]}
              </th>
              <td className="px-2 py-2 text-foam-muted line-through">{milestone.before}</td>
              <td className={`py-2 pl-2 font-semibold text-glass ${shown(moved)}`}>{milestone.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The guardrail between the question and the model, then the email the firm receives. */
export function EscalationCard({ stage }: { readonly stage: number }) {
  const { tour } = useLandingCopy();
  return (
    <div className="flex flex-col gap-3">
      <div className={`${CARD} flex items-center gap-3 text-sm ${shown(stage >= 1)}`}>
        <Icon name="shield" className="h-6 w-6 text-signal" />
        <span className="flex-1">
          <span className="font-semibold">{tour.escalation.guardrail}</span>
          <span className="block text-xs text-foam-muted">
            {tour.escalation.model}: {tour.escalation.blocked}
          </span>
        </span>
        <Icon name="handoff" className="h-5 w-5 text-glass" />
      </div>
      <div className={`${CARD} ${shown(stage >= 2)}`}>
        <p className="flex items-center gap-2 text-xs font-semibold text-glass">
          <Icon name="envelope" className="h-4 w-4" />
          {tour.escalation.mailbox}
        </p>
        <p lang="es-AR" className="mt-2 text-sm font-semibold">
          {ESCALATION_EMAIL.subject}
        </p>
        {ESCALATION_EMAIL.lines.map((line) => (
          <p key={line} lang="es-AR" className="mt-1 text-xs text-foam-muted">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/** "Aprobar legajo" (the console's own button text) turning into "approved by a person". */
export function ApprovalCard({ stage }: { readonly stage: number }) {
  const { tour } = useLandingCopy();
  const ruleLabel = useRuleLabel("CED-NO-APPROVE");
  const approved = stage >= 1;
  return (
    <div className={`${CARD} flex flex-col gap-3`}>
      <p className="flex items-center gap-2 text-xs text-foam-muted">
        <Icon name="lock" className="h-4 w-4" />
        {tour.approval.recentSignIn}
      </p>
      <div className="grid">
        <span aria-hidden={approved} lang="es-AR" className={`col-start-1 row-start-1 inline-flex min-h-11 items-center justify-center rounded-pill bg-signal px-5 font-semibold text-harbor-950 ${SHOW} ${approved ? "opacity-0" : "opacity-100"}`}>
          {inLang("es", () => dossierCopy.approval.approve)}
        </span>
        <span aria-hidden={!approved} className={`col-start-1 row-start-1 inline-flex min-h-11 items-center justify-center gap-2 rounded-pill bg-glass px-5 font-semibold text-harbor-950 ${shown(approved)}`}>
          <Icon name="personCheck" className="h-5 w-5" />
          {tour.approval.approved}
        </span>
      </div>
      <RuleChip ruleId="CED-NO-APPROVE" tone="dark" {...(ruleLabel ? { label: ruleLabel } : {})} />
    </div>
  );
}
