// Top-level routing and session guard (docs/landing-spec.md D-01, D-03). The landing (`/`) and the
// access screens render for anyone and travel in this chunk; the console (`/app/*`) loads lazily
// (console-routes.tsx), so a visitor of the landing never downloads it, except an idle-time prefetch
// when a session is already open. A guest whose token names no firm yet has no live world: it waits
// on `/welcome`. `/?signedOut=1` adds the sign-out notice above the landing.
import { Suspense, lazy, useEffect } from "react";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { useSession } from "./context/SessionContext";
import { copy } from "./copy/console";
import { Redirect, useRouter } from "./lib/router";
import { FORGOT_PATH, FORGOT_RESET_PATH, LANDING_PATH, LOGIN_PATH, SIGNUP_PATH, SIGNUP_VERIFY_PATH, WELCOME_PATH } from "./routes";
import { ForgotView, ResetView } from "./views/auth/ForgotView";
import { LoginView } from "./views/auth/LoginView";
import { needsWorld } from "./views/auth/session";
import { SignedOutNotice } from "./views/auth/SignedOutNotice";
import { SignupView } from "./views/auth/SignupView";
import { VerifyView } from "./views/auth/VerifyView";
import { WelcomeView } from "./views/auth/WelcomeView";
import { LandingView } from "./views/landing/LandingView";

const loadConsole = () => import("./console-routes");
const ConsoleRoutes = lazy(loadConsole);

/** With a session open, fetch the console while the browser is idle (D-03). */
function usePrefetchConsole(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return;
    const idle = window.requestIdleCallback?.bind(window);
    if (idle) {
      const handle = idle(() => void loadConsole());
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(() => void loadConsole(), 2_000);
    return () => window.clearTimeout(timer);
  }, [signedIn]);
}

export function App() {
  const { path } = useRouter();
  const { state } = useSession();
  usePrefetchConsole(state.status === "authenticated");

  switch (path) {
    case LANDING_PATH:
      return (
        <>
          <SignedOutNotice />
          <LandingView />
        </>
      );
    case SIGNUP_PATH:
      return <SignupView />;
    case SIGNUP_VERIFY_PATH:
      return <VerifyView />;
    case LOGIN_PATH:
      return <LoginView />;
    case FORGOT_PATH:
      return <ForgotView />;
    case FORGOT_RESET_PATH:
      return <ResetView />;
    case WELCOME_PATH:
      return <WelcomeView />;
  }
  if (state.status === "loading") return <FullScreenMessage title={copy.app.loading} />;
  if (state.status !== "authenticated") return <Redirect to={`${LOGIN_PATH}?returnTo=${encodeURIComponent(path)}`} />;
  if (needsWorld(state.principal)) return <Redirect to={WELCOME_PATH} />;

  return (
    <Suspense fallback={<FullScreenMessage title={copy.app.loading} />}>
      <ConsoleRoutes />
    </Suspense>
  );
}
