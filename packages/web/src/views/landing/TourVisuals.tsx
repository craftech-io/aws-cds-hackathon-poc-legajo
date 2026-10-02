// What each step of the tour shows (tour-steps.ts): the render of docs/landing-spec.md §7.3, built
// with the product's components and texts (the importer's phone, the supplier's email thread, the
// reader's result, the milestones, the guardrail and the approval). When the step becomes active its
// short sequence plays once (≤ 1.5 s); with reduced motion or paused animations it is in its final
// state from the start.
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
  /** A smaller phone, so a carousel step fits a phone's screen with its text. */
  readonly compact?: boolean;
}

/** Stages of each step's sequence; the final stage is the static state. */
const STAGES: Readonly<Record<TourStepId, number>> = { request: 0, delegate: 2, supplier: 0, reader: 1, owner: 1, eta: 1, escalation: 2, approval: 1 };

function Phone({ id, compact, upTo }: { readonly id: Parameters<typeof conversation>[0]; readonly compact: boolean; readonly upTo?: number }) {
  const { hero } = useLandingCopy();
  const thread = conversation(id);
  return <WhatsAppPhone conversation={thread} messages={upTo === undefined ? thread.messages : thread.messages.slice(0, upTo)} firmName={STORY.firmName} caption={hero.phoneCaption} size={compact ? "compact" : "stage"} />;
}

const PAIR = "grid items-start gap-4 xl:grid-cols-2";

export function StepVisual({ id, play, compact = false }: StepVisualProps) {
  const stage = useSequence(play, STAGES[id]);
  switch (id) {
    case "request":
      return <Phone id="request" compact={compact} />;
    case "delegate":
      return (
        <div className={PAIR}>
          <Phone id="delegate" compact={compact} upTo={stage === 0 ? 1 : undefined} />
          <DeferralNote stage={stage} note="supplier" />
        </div>
      );
    case "supplier":
      return <EmailThread ids={["request", "reply"]} />;
    case "reader":
      return <ReaderCard stage={stage} />;
    case "owner":
      return (
        <div className="flex flex-col gap-4">
          <OwnerLine stage={stage} />
          <div className={PAIR}>
            <EmailThread ids={["correction"]} />
            <Phone id="noAction" compact={compact} />
          </div>
        </div>
      );
    case "eta":
      return (
        <div className={PAIR}>
          <EtaTable stage={stage} />
          <Phone id="eta" compact={compact} />
        </div>
      );
    case "escalation":
      return (
        <div className={PAIR}>
          <Phone id="question" compact={compact} />
          <EscalationCard stage={stage} />
        </div>
      );
    case "approval":
      return (
        <div className={PAIR}>
          <ApprovalCard stage={stage} />
          <Phone id="approval" compact={compact} upTo={1} />
        </div>
      );
  }
}
