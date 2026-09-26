// The unified timeline of the operation (docs/design-brief.md §6, row 2; FL-081), in simulated order:
// messages by WhatsApp and email exactly as stored (inbound already masked, outbound exactly as sent,
// plain text), with the policy decision and the rules it evaluated; the agent's internal turn notes;
// escalations; and the decisions of the audit log no message already shows.
import { Badge, type BadgeTone } from "../../components/Badge";
import { RuleChips } from "../../components/RuleChips";
import { Section } from "../../components/Section";
import { formatNumber, formatSimDateTime } from "../../lib/format";
import { dossierCopy } from "./copy";
import {
  actorLabel,
  auditActionLabel,
  channelLabel,
  decisionLabel,
  decisionTone,
  escalationReasonLabel,
  messageKindLabel,
  messageStatusLabel,
  partyLabel,
  turnTriggerText,
} from "./labels";
import type { TimelineItem } from "./timeline-model";
import type { DecisionData, EscalationData, MessageData } from "./types";

const text = dossierCopy.timeline;

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  SENT: "success",
  DELIVERED: "success",
  READ: "success",
  RECEIVED: "info",
  QUEUED: "neutral",
  DEFERRED: "warning",
  DELAYED: "warning",
  FAILED: "danger",
  BOUNCED: "danger",
  COMPLAINED: "danger",
  QUARANTINED: "danger",
  DISCARDED: "neutral",
};

function counterpartLabel(counterpart: MessageData["counterpart"]): string {
  return counterpart === "FIRM" ? text.firmMailbox : partyLabel[counterpart];
}

function MessageCard({ message }: { readonly message: MessageData }) {
  const route = message.direction === "OUT" ? text.route(actorLabel(message.author), counterpartLabel(message.counterpart)) : text.route(counterpartLabel(message.counterpart), partyLabel.BROKER);
  const { policy } = message;
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="brand">{channelLabel[message.channel]}</Badge>
        <span className="font-semibold text-ink">{route}</span>
        {message.kind ? <span className="text-slate">· {messageKindLabel[message.kind]}</span> : null}
        <Badge tone={STATUS_TONE[message.status] ?? "neutral"}>{messageStatusLabel[message.status] ?? ""}</Badge>
        {message.template ? <Badge>{text.template}</Badge> : null}
      </p>
      {message.subject ? <p className="text-sm text-slate">{text.subject(message.subject)}</p> : null}
      <p className="whitespace-pre-wrap break-words rounded-md bg-paper px-3 py-2 text-sm text-ink">{message.body}</p>
      {message.buttons.length > 0 ? (
        <ul aria-label={text.buttons} className="flex flex-wrap gap-2">
          {message.buttons.map((button) => (
            <li key={button.action} className="rounded-full border border-cyan-deep px-3 py-0.5 text-xs font-medium text-cyan-deep">
              {button.title}
            </li>
          ))}
        </ul>
      ) : null}
      {message.attachments.map((attachment) => (
        <p key={attachment.index} className="text-xs text-slate">
          {text.attachment(`${formatNumber(Math.max(1, Math.round(attachment.sizeBytes / 1024)))} KB`, text.attachmentStatus[attachment.status] ?? "")}
        </p>
      ))}
      {policy ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={decisionTone[policy.decision]}>{decisionLabel[policy.decision]}</Badge>
          <RuleChips ids={policy.ruleIds} compact={policy.decision === "ALLOW"} />
          {policy.nextAllowedAt ? <span className="text-slate">{text.deferredUntil(formatSimDateTime(policy.nextAllowedAt))}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function EscalationCard({ escalation }: { readonly escalation: EscalationData }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">{text.escalation}</Badge>
        <span className="font-semibold text-ink">{escalationReasonLabel[escalation.reason]}</span>
        <span className="text-slate">{text.by(actorLabel(escalation.openedBy))}</span>
      </p>
      {escalation.summary ? <p className="whitespace-pre-wrap text-ink">{escalation.summary}</p> : null}
      <p className="text-slate">{escalation.resolution ? text.escalationResolved(escalation.resolution) : text.escalationOpen}</p>
    </div>
  );
}

function DecisionCard({ decision }: { readonly decision: DecisionData }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <Badge tone={decisionTone[decision.decision]}>{decisionLabel[decision.decision]}</Badge>
      <span className="font-medium text-ink">{auditActionLabel[decision.action] ?? decisionLabel[decision.decision]}</span>
      <span className="text-slate">{text.by(actorLabel(decision.actor))}</span>
      <RuleChips ids={decision.ruleIds} />
    </p>
  );
}

function ItemBody({ item }: { readonly item: TimelineItem }) {
  switch (item.kind) {
    case "MESSAGE":
      return <MessageCard message={item.message} />;
    case "NOTE":
      return (
        <div className="space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge>{text.note}</Badge>
            <span className="text-slate">{text.noteTrigger(turnTriggerText(item.trigger))}</span>
          </p>
          <p className="whitespace-pre-wrap italic text-slate">{item.text}</p>
        </div>
      );
    case "ESCALATION":
      return <EscalationCard escalation={item.escalation} />;
    case "DECISION":
      return <DecisionCard decision={item.decision} />;
  }
}

export function TimelineSection({ items }: { readonly items: readonly TimelineItem[] }) {
  return (
    <Section id="timeline" title={dossierCopy.sections.timeline} description={text.lead}>
      {items.length === 0 ? (
        <p className="text-sm text-slate">{text.empty}</p>
      ) : (
        <ol className="space-y-4">
          {items.map((item) => (
            <li key={item.key} className="grid gap-2 border-l-2 border-mist pl-4 md:grid-cols-[9rem_1fr]">
              <time dateTime={item.atSim} className="text-sm font-semibold tabular-nums text-navy">
                {formatSimDateTime(item.atSim)}
              </time>
              <ItemBody item={item} />
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
