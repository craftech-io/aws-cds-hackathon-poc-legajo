// What each step of the tour shows (tour-steps.ts): the render of docs/landing-spec.md §7.3, built
// with the product's components and texts (the importer's phone, the supplier's email thread, the
// reader's result, the milestones, the guardrail and the approval). When the step becomes active its
// short sequence plays once (≤ 1.5 s); with reduced motion or paused animations it is in its final
// state from the start. Pieces that appear later keep their room from the start, so the scale that
// FitToSlot picks does not change while the sequence plays.
import { STORY, conversation } from "./conversations";
import { EmailThread } from "./EmailThread";
import { useLandingCopy } from "./lang";
import { useSequence } from "./motion/hooks";
import { ApprovalCard, DeferralNote, EscalationCard, EtaTable, OwnerLine, ReaderCard } from "./SceneVisuals";
import type { TourStepId } from "./tour-steps";
import { WhatsAppPhone } from "./WhatsAppPhone";

interface StepVisualProps {
  readonly id: TourStepId;
  /** Play the step's sequence now (active, in view, and motion allowed). */
  readonly play: boolean;
  /**
   * The phone-screen composition of the carousel: only the pieces the step's text talks about, the
   * secondary card first, so the whole step reads on one screen once FitToSlot has scaled it.
   */
  readonly compact?: boolean;
}

/** Stages of each step's sequence; the final stage is the static state. */
const STAGES: Readonly<Record<TourStepId, number>> = { request: 0, delegate: 2, supplier: 0, reader: 1, owner: 1, eta: 1, escalation: 2, approval: 1 };

interface PhoneProps {
  readonly id: Parameters<typeof conversation>[0];
  /** The slice of the thread the step shows. */
  readonly from?: number;
  readonly upTo?: number;
  /** Messages shown so far (the rest keep their room). */
  readonly revealed?: number;
}

function Phone({ id, from = 0, upTo, revealed, compact }: PhoneProps & { readonly compact: boolean }) {
  const { hero } = useLandingCopy();
  const thread = conversation(id);
  // The carousel drops the caption: the phone's own header already says "simulator" and "fictitious".
  return <WhatsAppPhone conversation={thread} messages={thread.messages.slice(from, upTo)} firmName={STORY.firmName} caption={compact ? undefined : hero.phoneCaption} {...(revealed === undefined ? {} : { revealed })} />;
}

const PAIR = "grid items-start gap-4 xl:grid-cols-2";
const STACK = "flex flex-col gap-4";

export function StepVisual({ id, play, compact = false }: StepVisualProps) {
  const stage = useSequence(play, STAGES[id]);
  switch (id) {
    case "request":
      return <Phone compact={compact} id="request" />;
    case "delegate": {
      // The tap that delegates is in the hero and in step 1's buttons: the stage starts at the question
      // it triggers, the carousel at the confirmed contact.
      const from = compact ? 2 : 1;
      const phone = <Phone compact={compact} id="delegate" from={from} {...(stage === 0 ? { revealed: 1 } : {})} />;
      const note = <DeferralNote stage={stage} note="supplier" />;
      return compact ? (
        <div className={STACK}>
          {note}
          {phone}
        </div>
      ) : (
        <div className={PAIR}>
          {phone}
          {note}
        </div>
      );
    }
    case "supplier":
      return <EmailThread ids={["request", "reply"]} compact={compact} />;
    case "reader":
      return <ReaderCard stage={stage} />;
    case "owner":
      return (
        <div className={STACK}>
          <OwnerLine stage={stage} />
          {compact ? (
            <Phone compact={compact} id="noAction" />
          ) : (
            <div className={PAIR}>
              <EmailThread ids={["correction"]} />
              <Phone compact={compact} id="noAction" />
            </div>
          )}
        </div>
      );
    case "eta":
      return (
        <div className={compact ? STACK : PAIR}>
          <EtaTable stage={stage} />
          <Phone compact={compact} id="eta" />
        </div>
      );
    case "escalation":
      return compact ? (
        <div className={STACK}>
          <EscalationCard stage={stage} />
          <Phone compact={compact} id="question" upTo={2} />
        </div>
      ) : (
        <div className={PAIR}>
          <Phone compact={compact} id="question" />
          <EscalationCard stage={stage} />
        </div>
      );
    case "approval":
      return (
        <div className={compact ? STACK : PAIR}>
          <ApprovalCard stage={stage} />
          {/* The carousel keeps the notice of the approval; the stage also shows the arrival of version 2. */}
          <Phone compact={compact} id="approval" from={compact ? 1 : 0} upTo={2} />
        </div>
      );
  }
}
