// "Nueva operación" (FL-005): the firm brings an operation from the customs platform (PlatformMock)
// by its number; the BFF creates the dossier with its three documents and its five milestones, and
// the console opens it. A number the platform does not know, or one already in the world, is said in
// words, not as an error code.
import { OperationNumber } from "@legajo/shared";
import { type FormEvent, useId, useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Drawer } from "../../components/Drawer";
import { ERROR_CLASS, FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { useSession } from "../../context/SessionContext";
import { useRouter } from "../../lib/router";
import { useAction } from "../../lib/use-remote";
import { dossierPath } from "../../routes";
import { createOperation } from "./api";
import { operationsCopy } from "./copy";

const text = operationsCopy.create;

interface NewOperationDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function NewOperationDrawer({ open, onClose }: NewOperationDrawerProps) {
  const { trpc } = useSession();
  const { navigate } = useRouter();
  const [number, setNumber] = useState("");
  const [touched, setTouched] = useState(false);
  const action = useAction((operationNumber: string) => createOperation(trpc, operationNumber));
  const id = useId();
  const valid = OperationNumber.safeParse(number.trim()).success;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!valid) return;
    const operationId = await action.run(number.trim());
    if (operationId !== undefined) navigate(dossierPath(operationId));
  };

  const error = action.state.status === "error" ? action.state.error : undefined;
  const known = error?.kind === "notFound" ? text.notFound : error?.kind === "conflict" ? text.conflict : undefined;

  return (
    <Drawer open={open} title={text.title} onClose={onClose} closeLabel={text.close}>
      <form className="space-y-4" onSubmit={(event) => void submit(event)} noValidate>
        <p className="text-sm text-slate">{text.lead}</p>
        <label htmlFor={id} className={LABEL_CLASS}>
          {text.number}
          <input
            id={id}
            name="operationNumber"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            className={FIELD_CLASS}
            value={number}
            aria-invalid={touched && !valid ? true : undefined}
            onChange={(event) => setNumber(event.target.value)}
          />
          <span className={HINT_CLASS}>{text.numberHint}</span>
          {touched && !valid ? <span className={ERROR_CLASS}>{text.invalid}</span> : null}
        </label>
        {known ? <Callout tone="warning">{known}</Callout> : error ? <ApiErrorNotice error={error} /> : null}
        <Button type="submit" busy={action.state.status === "running"}>
          {action.state.status === "running" ? text.working : text.submit}
        </Button>
      </form>
    </Drawer>
  );
}
