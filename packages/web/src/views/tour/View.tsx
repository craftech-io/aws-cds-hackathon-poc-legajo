// "Recorrido guiado" (docs/design-brief.md §15), the shell's side panel, open from the start for a
// guest: the 10 steps of steps.ts over the story of operation 4471, in Spanish or English. The current
// step is the first with a move still to do; each button calls the console's own procedures, the
// buttons that change the world wait for a quiet one (the shell's poll of `clock.get` says when), and
// the hours of "Qué mirar" come from the pending timers of 4471 that `tour.steps` answers. Progress is kept per world
// and epoch in sessionStorage, so "Reiniciar demo" starts the tour again.
import { useCallback, useEffect, useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Callout } from "../../components/Callout";
import { FilterPills } from "../../components/FilterPills";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote, useWorldClock } from "../../context/WorldClockContext";
import { useRouter } from "../../lib/router";
import { dataOf, useAction } from "../../lib/use-remote";
import { isBusy } from "../../lib/world-clock";
import { CONSOLE_PREFIX, dossierPath } from "../../routes";
import { clockDetailOf } from "../clock/clock-api";
import { fetchThreads } from "../simulator/simulator-api";
import { LANG_LABELS, TOUR_TEXTS } from "./copy";
import { StepCard } from "./StepCard";
import { TOUR_STEPS, type TourLang, type TourMove, type TourStep } from "./steps";
import { TOUR_OPERATION_MISSING, fetchTourContext, findTourOperation, runTourAction } from "./tour-api";
import { currentStepIndex, glossFor, isStepDone, moveKey, parseProgress, progressKey } from "./tour-model";

const LANG_KEY = "legajo.tour.lang";
const LANG_OPTIONS = (["es", "en"] as const).map((value) => ({ value, label: LANG_LABELS[value] }));

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // A tab without storage keeps the progress in memory only.
  }
}

/** Done moves of this world and epoch, kept across views and reloads of the tab. */
function useProgress(key: string | undefined): [ReadonlySet<string>, (done: string) => void, () => void] {
  const [progress, setProgress] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setProgress(key === undefined ? new Set() : parseProgress(readStorage(key)));
  }, [key]);
  const mark = useCallback(
    (done: string) =>
      setProgress((current) => {
        const next = new Set(current).add(done);
        if (key !== undefined) writeStorage(key, JSON.stringify([...next]));
        return next;
      }),
    [key],
  );
  const restart = useCallback(() => {
    setProgress(new Set());
    if (key !== undefined) writeStorage(key, "[]");
  }, [key]);
  return [progress, mark, restart];
}

export default function View() {
  const { trpc } = useSession();
  const { snapshot, refresh } = useWorldClock();
  const { navigate } = useRouter();
  const [lang, setLang] = useState<TourLang>(() => (readStorage(LANG_KEY) === "en" ? "en" : "es"));
  const detail = clockDetailOf(snapshot);
  const [progress, mark, restart] = useProgress(detail ? progressKey(detail.clockId, detail.worldEpoch) : undefined);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const index = selected ?? currentStepIndex(progress);
  const step = TOUR_STEPS[index] ?? TOUR_STEPS[0];
  const threads = useLiveRemote(step?.glossOf ? "tour:simulator.threads" : null, (signal) => fetchThreads(trpc, signal));
  const tour = useLiveRemote("tour:steps", (signal) => fetchTourContext(trpc, signal));
  const texts = TOUR_TEXTS[lang];

  const goTo = useCallback(
    async (target: TourStep) => {
      if (target.view !== "dossier") {
        navigate(`${CONSOLE_PREFIX}/${target.view}`);
        return;
      }
      const operation = await findTourOperation(trpc);
      navigate(operation ? dossierPath(operation.operationId) : `${CONSOLE_PREFIX}/operations`);
    },
    [navigate, trpc],
  );

  const action = useAction(async ({ target, moveIndex, move }: { target: TourStep; moveIndex: number; move: TourMove }) => {
    if (move.action.kind === "open") await goTo(target);
    else {
      try {
        await runTourAction(trpc, move.action);
      } finally {
        refresh();
        tour.refresh();
      }
    }
    mark(moveKey(target, moveIndex));
    setSelected(undefined);
    return true;
  });

  const changeLang = (value: TourLang) => {
    setLang(value);
    writeStorage(LANG_KEY, value);
  };

  if (step === undefined) return null;
  const failure = action.state.status === "error" ? action.state.error : undefined;
  const missing = failure?.reason === TOUR_OPERATION_MISSING;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <FilterPills label={texts.lang} options={LANG_OPTIONS} value={lang} onChange={changeLang} variant="segmented" />
        <button type="button" className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-semibold text-slate underline hover:bg-mist" onClick={restart}>
          {texts.restart}
        </button>
      </div>
      <p className="text-sm text-slate">{texts.intro}</p>
      <nav aria-label={texts.steps}>
        <ol className="flex flex-wrap gap-1">
          {TOUR_STEPS.map((candidate, position) => (
            <li key={candidate.id}>
              <button
                type="button"
                aria-current={position === index ? "step" : undefined}
                aria-label={`${candidate.number}. ${candidate.title[lang]}`}
                title={candidate.title[lang]}
                className={`size-11 rounded-full text-sm font-semibold ${position === index ? "bg-navy text-white" : isStepDone(candidate, progress) ? "bg-success-soft text-success" : "bg-mist text-navy"}`}
                onClick={() => setSelected(position)}
              >
                {candidate.number}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <StepCard
        step={step}
        lang={lang}
        clock={detail}
        times={dataOf(tour.state)}
        progress={progress}
        busy={snapshot === undefined || isBusy(snapshot)}
        running={action.state.status === "running"}
        gloss={glossFor(dataOf(threads.state)?.threads, step.glossOf)}
        onMove={(target, moveIndex, move) => void action.run({ target, moveIndex, move })}
        onGoTo={(target) => void goTo(target)}
      />
      {missing ? <Callout tone="warning" title={texts.noOperation} /> : failure ? <ApiErrorNotice error={failure} /> : null}
    </div>
  );
}
