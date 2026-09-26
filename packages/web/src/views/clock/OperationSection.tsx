// "Eventos de una operación": what arrives from outside in reality, played from the console on one
// operation of the world: the carrier moves the ETA (`clock.moveEta`, the platform publishes
// `CarrierEtaChanged`), a milestone fires before its hour (`clock.fireMilestone`, `MANUAL`), and
// customs reports a dispatch status (`clock.emitDispatchStatus`). All three wait for a quiet world.
import type { MilestoneName } from "@legajo/shared";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { formatSimDateTime } from "../../lib/format";
import { isoToLocalInput, localInputToIso } from "../../lib/local-datetime";
import type { RouterOutputs } from "../../lib/trpc-router";
import { type ControlGate, DISPATCH_OPTIONS, MILESTONE_OPTIONS, dispatchChoice, shiftEta } from "./clock-model";
import { type EmittableDispatch, clockCopy } from "./copy";
import { ActionOutcome, DateTimeField, GateNote } from "./parts";
import { useClockCommand } from "./use-clock-command";

export type WorldOperation = RouterOutputs["operations"]["list"]["operations"][number];

const copy = clockCopy.operation;

function FormBlock({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-mist p-4">
      <legend className="px-1 text-sm font-semibold text-navy">{title}</legend>
      {children}
    </fieldset>
  );
}

interface OperationFormsProps {
  readonly operation: WorldOperation;
  readonly gate: ControlGate;
  readonly gateId: string;
}

function OperationForms({ operation, gate, gateId }: OperationFormsProps) {
  const command = useClockCommand();
  const [eta, setEta] = useState(() => isoToLocalInput(operation.eta));
  const [milestone, setMilestone] = useState<MilestoneName>("DOCS_REQUEST");
  const [dispatch, setDispatch] = useState<EmittableDispatch>("OFICIALIZADO");
  const busy = gate.disabled || command.state.status === "running";
  const describedBy = gate.reason === undefined ? undefined : gateId;
  const newEta = localInputToIso(eta);
  const force = gate.force;
  const { operationId } = operation;

  return (
    <div className="grid gap-4 2xl:grid-cols-3">
      <FormBlock title={copy.etaTitle}>
        <p className="text-xs text-slate">{copy.currentEta(formatSimDateTime(operation.eta))}</p>
        <DateTimeField label={copy.etaInput} value={eta} onChange={setEta} hint={copy.etaHint} disabled={busy} />
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => setEta(isoToLocalInput(shiftEta(operation.eta, -2)))}>
            {copy.etaEarlier}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setEta(isoToLocalInput(shiftEta(operation.eta, 4)))}>
            {copy.etaLater}
          </Button>
        </div>
        <Button disabled={busy || newEta === undefined} aria-describedby={describedBy} onClick={() => newEta && void command.run({ command: { kind: "moveEta", operationId, eta: newEta }, force })}>
          {copy.etaSubmit}
        </Button>
        {eta !== "" && newEta === undefined ? <p className="text-xs text-danger">{copy.etaInvalid}</p> : null}
      </FormBlock>
      <FormBlock title={copy.milestoneTitle}>
        <SelectField label={copy.milestone} value={milestone} options={MILESTONE_OPTIONS} onChange={setMilestone} disabled={busy} />
        <Button disabled={busy} aria-describedby={describedBy} onClick={() => void command.run({ command: { kind: "fireMilestone", operationId, milestone }, force })}>
          {copy.milestoneSubmit}
        </Button>
      </FormBlock>
      <FormBlock title={copy.dispatchTitle}>
        <SelectField label={copy.dispatch} value={dispatch} options={DISPATCH_OPTIONS} onChange={setDispatch} hint={copy.dispatchHint} disabled={busy} />
        <Button
          disabled={busy}
          aria-describedby={describedBy}
          onClick={() => void command.run({ command: { kind: "emitDispatchStatus", operationId, ...dispatchChoice(dispatch) }, force })}
        >
          {copy.dispatchSubmit}
        </Button>
      </FormBlock>
      <div className="2xl:col-span-3">
        <ActionOutcome state={command.state} done={clockCopy.done.event} />
      </div>
    </div>
  );
}

export function OperationSection({ operations, gate }: { readonly operations: readonly WorldOperation[]; readonly gate: ControlGate }) {
  const [selected, setSelected] = useState<string>(() => operations[0]?.operationId ?? "");
  const gateId = useId();
  const operation = operations.find((candidate) => candidate.operationId === selected) ?? operations[0];
  const options = operations.map((candidate) => ({ value: candidate.operationId, label: copy.optionLabel(candidate.operationNumber, candidate.importerName ?? "—") }));

  return (
    <Section id="clock-operation" title={copy.title} description={copy.description}>
      {operation === undefined ? (
        <p className="text-sm text-slate">{copy.none}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <SelectField label={copy.select} value={operation.operationId} options={options} onChange={setSelected} className="min-w-72" />
          <GateNote id={gateId} gate={gate} />
          {/* Keyed by operation: switching operations starts its forms from that operation's ETA. */}
          <OperationForms key={operation.operationId} operation={operation} gate={gate} gateId={gateId} />
        </div>
      )}
    </Section>
  );
}
