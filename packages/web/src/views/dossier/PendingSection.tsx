// Pendings of the operation with their reason (docs/design-brief.md §6, row 2): every SCHEDULED timer
// ("Diferido: horario del proveedor (CP-HOURS-SUPPLIER) hasta 16/10 09:00 hora del proveedor ·
// [Avanzar hasta ahí]", "Esperando respuesta del proveedor por SES"), a supplier's business hours read
// in its own zone and in Argentina's; and what the world is still waiting for on this operation.
// "Avanzar hasta ahí" moves the paused clock of the operation's world exactly to the pending
// (`clock.advanceTo`), and is disabled with the shell's reason while the world is busy or the shell is
// moving it (docs/architecture.md §8, `WORLD_BUSY`); a refusal is shown in words under the list.
import { useId } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { RuleChip } from "../../components/RuleChip";
import { Section } from "../../components/Section";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy } from "../../copy/console";
import { formatSimDateTime } from "../../lib/format";
import { isBusy } from "../../lib/world-clock";
import { dossierCopy } from "./copy";
import { timerReasonLabel, timerTitle } from "./labels";
import { type PendingTimer, pendingTimers, worldPendingsOf } from "./timeline-model";
import type { PendingTimerData } from "./types";
import { useAdvanceTo } from "./use-dossier-action";

const text = dossierCopy.pending;

function Reason({ item }: { readonly item: PendingTimer }) {
  const { reason } = item;
  switch (reason.kind) {
    case "rule":
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {item.timer.kind === "DEFERRED_SEND" ? <span>{text.deferred}</span> : null}
          <RuleChip ruleId={reason.ruleId} />
        </span>
      );
    case "code":
      return timerReasonLabel[reason.code] ? <span>{timerReasonLabel[reason.code]}</span> : null;
    case "text":
      return <span>{reason.text}</span>;
    case "none":
      return null;
  }
}

function whenText(item: PendingTimer, supplierZone: string): string {
  const argentina = formatSimDateTime(item.timer.dueAtSim);
  return item.zone === "SUPPLIER" ? text.supplierTime(formatSimDateTime(item.timer.dueAtSim, supplierZone), argentina) : argentina;
}

interface RowProps {
  readonly item: PendingTimer;
  readonly supplierZone: string;
  readonly disabled: boolean;
  readonly busyId: string | undefined;
  readonly onAdvance: (toSim: string) => void;
}

function PendingRow({ item, supplierZone, disabled, busyId, onAdvance }: RowProps) {
  const title = timerTitle(item.timer.kind, item.timer.timerId);
  const when = whenText(item, supplierZone);
  const { advance } = item;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-mist px-3 py-2 text-sm">
      <div className="space-y-1">
        <p className="font-semibold text-ink">{title}</p>
        <p className="flex flex-wrap items-center gap-1.5 text-slate">
          <Reason item={item} />
          <time dateTime={item.timer.dueAtSim}>{item.timer.kind === "DEFERRED_SEND" ? text.until(when) : when}</time>
        </p>
      </div>
      {advance.kind === "to" ? (
        <Button
          variant="secondary"
          disabled={disabled}
          aria-label={text.advanceLabel(title, when)}
          {...(disabled && busyId !== undefined ? { "aria-describedby": busyId } : {})}
          onClick={() => onAdvance(advance.toSim)}
        >
          {text.advance}
        </Button>
      ) : null}
      {advance.kind === "due" ? <p className="text-xs text-slate">{text.due}</p> : null}
      {advance.kind === "tooFar" ? <p className="text-xs text-slate">{text.tooFar}</p> : null}
    </li>
  );
}

interface PendingSectionProps {
  readonly clockId: string;
  readonly operationNumber: string;
  readonly timers: readonly PendingTimerData[];
  readonly supplierZone: string;
  /** The clock moved: read the dossier again. */
  readonly onChanged: () => void;
}

export function PendingSection({ clockId, operationNumber, timers, supplierZone, onChanged }: PendingSectionProps) {
  const { snapshot, moving } = useWorldClock();
  const advanceTo = useAdvanceTo(onChanged);
  const busyId = useId();
  // The shell's clock is the session's world; an operation of another world is not moved from here.
  const world = snapshot?.clockId === clockId ? snapshot : undefined;
  const items = pendingTimers(timers, world?.simNow);
  const waiting = world ? worldPendingsOf(world.pending, operationNumber) : [];
  const busy = world !== undefined && isBusy(world);
  const disabled = world === undefined || busy || moving || advanceTo.state.status === "running";

  return (
    <Section id="pending" title={dossierCopy.sections.pending} description={text.lead}>
      <div className="space-y-3">
        {waiting.length > 0 ? (
          <Callout tone="info" title={text.waitingTitle}>
            <ul className="list-disc pl-5">
              {waiting.map((item) => (
                <li key={`${item.kind}-${item.sinceReal}-${item.detail ?? ""}`}>{copy.clock.pending[item.kind]}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {busy ? (
          <p id={busyId} className="text-xs text-slate">
            {text.busy}
          </p>
        ) : null}
        {items.length === 0 ? (
          <p className="text-sm text-slate">{text.empty}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <PendingRow
                key={item.key}
                item={item}
                supplierZone={supplierZone}
                disabled={disabled}
                busyId={busy ? busyId : undefined}
                onAdvance={(toSim) => void advanceTo.run({ clockId, toSim })}
              />
            ))}
          </ul>
        )}
        {advanceTo.state.status === "error" ? <ApiErrorNotice error={advanceTo.state.error} /> : null}
      </div>
    </Section>
  );
}
