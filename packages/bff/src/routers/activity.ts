// `activity` router (docs/tool-catalog.md `record_activity`): the console's 30-second heartbeat while a
// person has a dossier open. It adds observed console seconds to the dossier's KPI row in its world (a
// secondary metric, labelled observed) and writes no audit row per beat.
import { RecordActivityInput } from "../services/operations-admin/record-activity";
import { runDirect } from "./console-services";
import { firmProcedure, router } from "./trpc";

export const activityRouter = router({
  heartbeat: firmProcedure.input(RecordActivityInput).mutation(({ ctx, input }) => runDirect(ctx, "record_activity", input)),
});
