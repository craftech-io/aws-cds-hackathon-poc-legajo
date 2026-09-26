// `account` router (docs/tool-catalog.md, docs/architecture.md §10, FL-079): who the session is, the
// name of its firm and, for a judge, whether another session used the same judge world in the last 2
// real hours (asked once per sign-in by the shell, packages/web/src/lib/console-api.ts). The
// judge world keeps the last session that acted on it (`CLOCK#JUDGE#<firmId>.lastSession`); a
// different `origin_jti` inside the window gets the fixed notice of docs/design-brief.md §7.1, which
// neither blocks nor offers a reset. The sign-in records this session as the last one, and every
// later call of the session keeps it fresh (judge-activity.ts, from `firmProcedure`).
import { judgeClockId } from "@legajo/shared";
import type { Principal } from "../auth/principal";
import { isSignInFresh } from "../auth/principal";
import type { Connector } from "../connector/index";
import type { Clock } from "../domain/world-state";
import { markJudgeActivity, sessionIdOf } from "./judge-activity";
import { firmProcedure, router } from "./trpc";

/** Another session within this many real milliseconds of its last action gets the notice. */
export const OTHER_SESSION_WINDOW_MS = 2 * 60 * 60_000;

export interface OtherSession {
  /** Last real instant the other session acted on the world. */
  readonly lastActiveAtReal: string;
  readonly minutesAgo: number;
}

/** The notice for `sessionId` given the clock's last session, or `null`. */
export function otherSessionOf(clock: Pick<Clock, "lastSession">, sessionId: string, realNow: Date): OtherSession | null {
  const last = clock.lastSession;
  if (last === undefined || last.originJti === sessionId) return null;
  const elapsed = realNow.getTime() - Date.parse(last.lastActiveAtReal);
  if (elapsed < 0 || elapsed >= OTHER_SESSION_WINDOW_MS) return null;
  return { lastActiveAtReal: last.lastActiveAtReal, minutesAgo: Math.floor(elapsed / 60_000) };
}

/** Reads the judge world, answers the notice and records this session as the last one. */
export async function touchJudgeSession(data: Connector, principal: Principal, realNow: Date): Promise<{ worldReady: boolean; otherSession: OtherSession | null }> {
  const clockId = judgeClockId(principal.firmId);
  const clock = await data.world.findClock(clockId);
  if (clock === undefined) return { worldReady: false, otherSession: null };
  const otherSession = otherSessionOf(clock, sessionIdOf(principal), realNow);
  await markJudgeActivity(data, clock, principal, realNow, 0);
  return { worldReady: true, otherSession };
}

export const accountRouter = router({
  session: firmProcedure.query(async ({ ctx }) => {
    const { principal } = ctx;
    const realNow = ctx.deps.wallClock();
    const firm = await ctx.deps.connector.firms.findFirm(principal.firmId);
    const base = {
      firm: firm === undefined ? null : { firmId: firm.firmId, name: firm.name, kind: firm.kind },
      firmId: principal.firmId,
      role: principal.role,
      isJudge: principal.isJudge,
      brokerId: principal.brokerId ?? null,
      recentLogin: isSignInFresh(principal, realNow),
      // Judges keep a permanent password and no TOTP (docs/architecture.md §10).
      canChangePassword: !principal.isJudge,
      canSetUpMfa: !principal.isJudge,
    };
    if (!principal.isJudge) return { ...base, worldReady: true, otherSession: null };
    return { ...base, ...(await touchJudgeSession(ctx.deps.connector, principal, realNow)) };
  }),
});
