// "Reiniciar la demo de este mundo" (FL-087, `clock.reset`): only a broker or a guest, once every 10
// real minutes per world, and always after an explicit confirmation, because it throws away everything
// that happened in the world. It is not gated by the busy world: a reset is the way out of a stuck one.
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Section } from "../../components/Section";
import { usePrincipal } from "../../context/SessionContext";
import type { ClockDetail } from "./clock-api";
import { resetGate } from "./clock-model";
import { clockCopy } from "./copy";
import { ActionOutcome } from "./parts";
import { useClockCommand } from "./use-clock-command";

const copy = clockCopy.reset;

export function ResetSection({ detail }: { readonly detail: ClockDetail }) {
  const principal = usePrincipal();
  const command = useClockCommand();
  const [confirming, setConfirming] = useState(false);
  const reasonId = useId();
  const gate = resetGate(detail, principal.role);
  const running = command.state.status === "running";

  const reset = async () => {
    await command.run({ command: { kind: "reset" } });
    setConfirming(false);
  };

  return (
    <Section id="clock-reset" title={copy.title} description={copy.description}>
      <div className="flex flex-col gap-3">
        {confirming ? (
          <Callout
            tone="warning"
            title={copy.confirmTitle}
            action={
              <>
                <Button variant="danger" busy={running} onClick={() => void reset()}>
                  {copy.confirm}
                </Button>
                <Button variant="secondary" disabled={running} onClick={() => setConfirming(false)}>
                  {copy.cancel}
                </Button>
              </>
            }
          >
            {copy.confirmLead}
          </Callout>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="danger"
              disabled={!gate.allowed || running}
              aria-describedby={gate.allowed ? undefined : reasonId}
              onClick={() => {
                command.reset();
                setConfirming(true);
              }}
            >
              {copy.open}
            </Button>
            {gate.allowed ? null : (
              <span id={reasonId} className="text-sm text-slate">
                {gate.reason}
              </span>
            )}
          </div>
        )}
        <ActionOutcome state={command.state} done={copy.done} />
      </div>
    </Section>
  );
}
