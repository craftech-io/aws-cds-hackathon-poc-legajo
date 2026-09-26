// "Próximos eventos": every kind of timer the world will fire next (milestones, deferred sends,
// the simulated supplier's replies, reader retries, contact checks), in the order they fall, each with
// "Avanzar hasta ahí" (`clock.advanceTo` its simulated hour). A reason that is a rule id reads as
// the rule's chip; the BFF's other reasons are plain words.
import { isRuleId } from "@legajo/shared";
import { useId } from "react";
import { Button } from "../../components/Button";
import { RuleIdChip } from "../../components/RuleChips";
import { Section } from "../../components/Section";
import { type Column, Table } from "../../components/Table";
import type { ClockDetail } from "./clock-api";
import { type ControlGate, type EventRow, eventRows } from "./clock-model";
import { clockCopy } from "./copy";
import { ActionOutcome, GateNote } from "./parts";
import { useClockCommand } from "./use-clock-command";

const copy = clockCopy.events;

function Reason({ reason }: { readonly reason: string | undefined }) {
  if (reason === undefined) return <span className="text-slate">—</span>;
  if (isRuleId(reason)) return <RuleIdChip id={reason} />;
  return <span>{reason}</span>;
}

export function EventsSection({ detail, gate }: { readonly detail: ClockDetail; readonly gate: ControlGate }) {
  const command = useClockCommand();
  const gateId = useId();
  const busy = gate.disabled || command.state.status === "running";
  const columns: readonly Column<EventRow>[] = [
    { id: "at", header: copy.at, cell: (row) => <time dateTime={row.dueAtSim}>{row.whenText}</time> },
    { id: "operation", header: copy.operation, cell: (row) => row.operationNumber },
    { id: "kind", header: copy.kind, cell: (row) => row.label },
    { id: "reason", header: copy.reason, cell: (row) => <Reason reason={row.reason} /> },
    {
      id: "action",
      header: copy.action,
      cell: (row) => (
        <Button
          variant="secondary"
          disabled={busy}
          title={copy.goThereLabel(row.operationNumber, row.whenText)}
          aria-describedby={gate.reason === undefined ? undefined : gateId}
          onClick={() => void command.run({ command: { kind: "advanceTo", toSim: row.dueAtSim }, force: gate.force })}
        >
          {copy.goThere}
        </Button>
      ),
    },
  ];
  return (
    <Section id="clock-events" title={copy.title} description={copy.description}>
      <div className="flex flex-col gap-4">
        <GateNote id={gateId} gate={gate} />
        <Table columns={columns} rows={eventRows(detail)} keyOf={(row) => row.key} emptyTitle={copy.empty} caption={copy.title} variant="inset" />
        <ActionOutcome state={command.state} done={clockCopy.done.moved} />
      </div>
    </Section>
  );
}
