// "Mover el tiempo": advance to a chosen simulated hour (`clock.advanceTo`) and the live clock
// (`clock.setRunning`, 30 real minutes). "Avanzar al próximo evento", "+1 h" and "+1 día" live in
// the simulated-time bar of the shell, which this view carries too.
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { isoToLocalInput, localInputToIso } from "../../lib/local-datetime";
import type { ClockDetail } from "./clock-api";
import { type ControlGate, isValidAdvanceTarget } from "./clock-model";
import { clockCopy } from "./copy";
import { ActionOutcome, DateTimeField, GateNote } from "./parts";
import { useClockCommand } from "./use-clock-command";

const copy = clockCopy.move;

export function MoveSection({ detail, gate }: { readonly detail: ClockDetail; readonly gate: ControlGate }) {
  const command = useClockCommand();
  const [target, setTarget] = useState(() => isoToLocalInput(detail.simNow));
  const [done, setDone] = useState<string>(clockCopy.done.moved);
  const gateId = useId();
  const toSim = localInputToIso(target);
  const valid = isValidAdvanceTarget(detail.simNow, toSim);
  const running = detail.mode === "RUNNING";
  const busy = gate.disabled || command.state.status === "running";
  const describedBy = gate.reason === undefined ? undefined : gateId;

  const advance = () => {
    if (!valid) return;
    setDone(clockCopy.done.moved);
    void command.run({ command: { kind: "advanceTo", toSim }, force: gate.force });
  };
  const toggleLive = () => {
    setDone(running ? clockCopy.done.paused : clockCopy.done.running);
    void command.run({ command: { kind: "setRunning", running: !running } });
  };

  return (
    <Section id="clock-move" title={copy.title} description={copy.description}>
      <div className="flex flex-col gap-4">
        <GateNote id={gateId} gate={gate} />
        <div className="flex flex-wrap items-end gap-3">
          <DateTimeField label={copy.advanceTo} value={target} onChange={setTarget} hint={copy.advanceToHint} disabled={busy} />
          <Button disabled={busy || !valid} aria-describedby={describedBy} onClick={advance}>
            {copy.advanceToSubmit}
          </Button>
        </div>
        {target !== "" && !valid && !busy ? <p className="text-xs text-danger">{copy.invalidTarget}</p> : null}
        <div className="flex flex-wrap items-center gap-3 border-t border-mist pt-4">
          <Button variant="secondary" disabled={command.state.status === "running"} onClick={toggleLive}>
            {running ? copy.pause : copy.live}
          </Button>
          <span className="text-xs text-slate">{copy.liveHint}</span>
        </div>
        <ActionOutcome state={command.state} done={done} />
      </div>
    </Section>
  );
}
