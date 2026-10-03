// `conversation` router (docs/tool-catalog.md "Procedimientos de la consola"; FL-067, FL-068, FL-070):
// the firm takes the conversation with the importer, writes to it and gives it back to the agent, over
// the direct handlers of services/conversation-control with the caller the principal stands for.
//
//   take     `control = BROKER`: the agent stops writing to the importer of this operation
//   send     free text inside the importer's 24-hour window, or one of the firm's templates outside it;
//            the handler enqueues `OUTBOUND_SEND` and the worker runs it through the outbound pipeline
//   release  `control = AGENT` and `AGENT_TURN(BROKER_RELEASED)`
import { ConversationControlInput, ConversationSendInput } from "@legajo/shared";
import { runDirect } from "./console-services";
import { firmProcedure, router } from "./trpc";

export const conversationRouter = router({
  take: firmProcedure.input(ConversationControlInput).mutation(({ ctx, input }) => runDirect(ctx, "take_conversation", input)),
  send: firmProcedure.input(ConversationSendInput).mutation(({ ctx, input }) => runDirect(ctx, "broker_send", input)),
  release: firmProcedure.input(ConversationControlInput).mutation(({ ctx, input }) => runDirect(ctx, "release_conversation", input)),
});
