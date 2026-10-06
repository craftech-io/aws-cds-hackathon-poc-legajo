// "Escribir al importador" (FL-068): the firm's message goes to the BFF, which queues it
// (`OUTBOUND_SEND`) and the worker sends it through the same outbound pipeline as the agent's, with
// the contact policy in front. The console offers what WhatsApp allows: free text within 24 hours of
// the importer's last message, approved templates outside that window (CP-WA-24H), nothing but the
// approval and dispatch notices once the dossier is approved (CP-APPROVED-SCOPE).
import { type FormEvent, useId, useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Drawer } from "../../components/Drawer";
import { SelectField } from "../../components/SelectField";
import { ERROR_CLASS, FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { dossierCopy } from "./copy";
import { BROKER_TEMPLATES, BROKER_TEXT_MAX, type BrokerTemplate, type ComposerMode } from "./dossier-model";
import { useDossierAction } from "./use-dossier-action";

const text = dossierCopy.conversation;

interface ComposerDrawerProps {
  readonly operationId: string;
  readonly mode: ComposerMode;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function ComposerDrawer({ operationId, mode, onClose, onDone }: ComposerDrawerProps) {
  const action = useDossierAction(onDone);
  const [message, setMessage] = useState("");
  const [template, setTemplate] = useState<BrokerTemplate>(BROKER_TEMPLATES[0]);
  const [touched, setTouched] = useState(false);
  const textId = useId();
  const running = action.state.status === "running";
  const empty = mode === "FREE_TEXT" && message.trim() === "";

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (empty) return;
    const done = await action.run(mode === "FREE_TEXT" ? { type: "sendText", operationId, text: message.trim() } : { type: "sendTemplate", operationId, template });
    if (done) setMessage("");
  };

  let body;
  if (mode === "APPROVED_SCOPE" || mode === "TAKE_FIRST") {
    body = <Callout tone="neutral">{mode === "APPROVED_SCOPE" ? text.approvedScope : text.takeHint}</Callout>;
  } else {
    body = (
      <form className="space-y-4" onSubmit={(event) => void send(event)} noValidate>
        {mode === "FREE_TEXT" ? (
          <label htmlFor={textId} className={LABEL_CLASS}>
            {text.text}
            <textarea
              id={textId}
              rows={5}
              maxLength={BROKER_TEXT_MAX}
              className={FIELD_CLASS}
              value={message}
              aria-invalid={touched && empty ? true : undefined}
              onChange={(event) => setMessage(event.target.value)}
            />
            <span className={HINT_CLASS}>{text.textHint(BROKER_TEXT_MAX)}</span>
            {touched && empty ? <span className={ERROR_CLASS}>{text.empty}</span> : null}
          </label>
        ) : (
          <>
            <Callout tone="warning">{text.windowClosed}</Callout>
            <SelectField<BrokerTemplate> label={text.template} value={template} options={BROKER_TEMPLATES.map((value) => ({ value, label: text.templates[value] }))} onChange={setTemplate} />
          </>
        )}
        {action.state.status === "error" ? <ApiErrorNotice error={action.state.error} /> : null}
        {action.state.status === "done" ? <Callout tone="success">{text.sent}</Callout> : null}
        <Button type="submit" busy={running}>
          {running ? text.sending : text.send}
        </Button>
      </form>
    );
  }

  return (
    <Drawer open title={text.title} onClose={onClose} closeLabel={dossierCopy.close}>
      {body}
    </Drawer>
  );
}
