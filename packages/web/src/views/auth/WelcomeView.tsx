// `/welcome`, "Preparando tu mundo" (docs/landing-spec.md §8.5, ADR-0015 §4; FL-105, FL-109 to
// FL-111, FL-132). The rules live in welcome-model.ts; this screen runs its effects: one
// `account.ensureWorld` per visit, `account.world` every 2 s while it is being created, the token refresh
// that brings the firm into the id token, and the minute-by-minute retry of a full demo while the tab is
// in sight. The world's lifetime is always at the foot, from guest-limits.ts.
import { GUEST_WORLD_IDLE_HOURS, GUEST_WORLD_MAX_AGE_HOURS } from "@legajo/shared/guest-limits";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { Redirect } from "../../lib/router";
import { CONSOLE_HOME, LOGIN_PATH, WELCOME_PATH } from "../../routes";
import { EXTERNAL_LINK, contactHref } from "../landing/links";
import { AuthLangProvider, useAuthLang } from "./AuthLang";
import { AuthLayout } from "./AuthLayout";
import { ErrorNote, NoticeNote, StepHeading } from "./form-parts";
import { quotaMessage, quotaOfRefusal } from "./quota";
import { accessFailureOf, ensureWorld, fetchWorld } from "./signup-api";
import { INITIAL_WELCOME, WELCOME_TIMING, type WelcomeEffect, type WelcomeState, onEnsure, onFailure, onRetry, onRetryTimer, onWorld } from "./welcome-model";

const ACTION = "inline-flex min-h-11 items-center justify-center rounded-pill px-5 py-2.5 text-base font-semibold";

function useWelcome(onReady: () => void) {
  const { trpc } = useSession();
  const [state, setState] = useState<WelcomeState>(INITIAL_WELCOME);
  const current = useRef(state);
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);

  const apply = useCallback(
    (step: { readonly state: WelcomeState; readonly effect: WelcomeEffect }) => {
      if (!alive.current) return;
      current.current = step.state;
      setState(step.state);
      window.clearTimeout(timer.current);
      const fail = (error: unknown) => {
        const failure = accessFailureOf(error);
        apply(onFailure(current.current, failure.kind === "quota" ? quotaOfRefusal(failure.data) : undefined));
      };
      const readWorld = () =>
        fetchWorld(trpc)
          .then((world) => apply(onWorld(current.current, world.state, Date.now())))
          .catch(fail);
      switch (step.effect) {
        case "ensure":
          void ensureWorld(trpc)
            .then((answer) => apply(onEnsure(current.current, answer.state, Date.now())))
            .catch(fail);
          break;
        case "poll":
          timer.current = window.setTimeout(() => void readWorld(), WELCOME_TIMING.pollMs);
          break;
        case "retryLater":
          timer.current = window.setTimeout(() => apply(onRetryTimer(current.current, document.visibilityState === "visible")), WELCOME_TIMING.capacityRetryMs);
          break;
        case "refresh":
          onReady();
          break;
        case "none":
          break;
      }
    },
    [trpc, onReady],
  );

  // The first read of this visit; a run that was cleaned up (React's double effects) never acts.
  useEffect(() => {
    let active = true;
    alive.current = true;
    void fetchWorld(trpc)
      .then((world) => {
        if (active) apply(onWorld(current.current, world.state, Date.now()));
      })
      .catch((error: unknown) => {
        if (!active) return;
        const failure = accessFailureOf(error);
        apply(onFailure(current.current, failure.kind === "quota" ? quotaOfRefusal(failure.data) : undefined));
      });
    return () => {
      active = false;
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, [trpc, apply]);

  return { state, retry: () => apply(onRetry()) };
}

function WelcomeScreen() {
  const { copy } = useAuthLang();
  const { refreshSession, signOut } = useSession();
  const [opened, setOpened] = useState<"console" | "failed" | undefined>(undefined);
  // The refreshed id token has to name the firm: without it the console would send the guest back here.
  const onReady = useCallback(() => {
    void refreshSession().then((principal) => setOpened(principal?.firmId ? "console" : "failed"));
  }, [refreshSession]);
  const { state: welcome, retry } = useWelcome(onReady);
  if (opened === "console") return <Redirect to={CONSOLE_HOME} />;
  const state: WelcomeState = opened === "failed" && welcome.screen.kind === "ready" ? { ...welcome, screen: { kind: "failed" } } : welcome;

  const signOutButton = (
    <button type="button" onClick={signOut} className={`${ACTION} border border-rule text-ink hover:border-ink-muted`}>
      {copy.welcome.signOut}
    </button>
  );
  const retryButton = (
    <button
      type="button"
      onClick={() => {
        setOpened(undefined);
        retry();
      }}
      className={`${ACTION} bg-harbor-950 text-foam hover:bg-harbor-800`}
    >
      {copy.welcome.retry}
    </button>
  );
  const talk = (placement: "welcome-capacity" | "welcome-failed", text: string) => (
    <a href={contactHref(placement)} {...EXTERNAL_LINK} className={`${ACTION} bg-signal text-harbor-950 hover:bg-foam`}>
      {text}
      <span className="sr-only"> {copy.layout.newTab}</span>
    </a>
  );

  let body;
  switch (state.screen.kind) {
    case "loading":
    case "preparing":
    case "ready":
      body = (
        <>
          <StepHeading title={copy.welcome.title} lead={copy.welcome.lead} />
          {state.screen.kind === "preparing" && state.screen.expired ? <NoticeNote>{copy.welcome.expired(GUEST_WORLD_IDLE_HOURS, GUEST_WORLD_MAX_AGE_HOURS)}</NoticeNote> : null}
          <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-pill bg-rule">
            <div className="h-full w-1/3 rounded-pill bg-signal motion-safe:animate-pulse" />
          </div>
          <p role="status" className="text-sm font-semibold text-ink">
            {copy.welcome.preparing}
          </p>
          <section aria-labelledby="welcome-includes" className="rounded-card bg-manifest px-4 py-3">
            <h2 id="welcome-includes" className="text-sm font-semibold text-ink">
              {copy.welcome.includesTitle}
            </h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
              {copy.welcome.includes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </>
      );
      break;
    case "capacity":
      body = (
        <>
          <StepHeading title={copy.welcome.capacity.title} lead={copy.welcome.capacity.lead} />
          <p className="text-sm text-ink-muted">{copy.welcome.capacity.note}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {retryButton}
            {talk("welcome-capacity", copy.welcome.capacity.talk)}
            {signOutButton}
          </div>
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <StepHeading title={copy.welcome.failed.title} lead={copy.welcome.failed.lead} />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {retryButton}
            {talk("welcome-failed", copy.welcome.failed.talk)}
            {signOutButton}
          </div>
        </>
      );
      break;
    case "quota":
      body = (
        <>
          <StepHeading title={copy.welcome.title} />
          <ErrorNote>{quotaMessage(copy, state.screen.quota)}</ErrorNote>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {retryButton}
            {signOutButton}
          </div>
        </>
      );
      break;
  }

  return (
    <div className="space-y-5">
      {body}
      <p className="border-t border-rule pt-4 text-xs text-ink-muted">{copy.welcome.ttl(GUEST_WORLD_IDLE_HOURS, GUEST_WORLD_MAX_AGE_HOURS)}</p>
    </div>
  );
}

export function WelcomeView() {
  const { state } = useSession();
  if (state.status === "loading") return null;
  if (state.status !== "authenticated") return <Redirect to={`${LOGIN_PATH}?returnTo=${encodeURIComponent(WELCOME_PATH)}`} />;
  if (!state.principal.isGuest) return <Redirect to={CONSOLE_HOME} />;
  return (
    <AuthLangProvider title="welcome">
      <AuthLayout>
        <WelcomeScreen />
      </AuthLayout>
    </AuthLangProvider>
  );
}
