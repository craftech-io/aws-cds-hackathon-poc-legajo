// Plays the hero conversation once over its schedule (schedule.ts): a requestAnimationFrame clock that
// only advances while the hero is in view and the tab is visible, and resumes where it stopped. With
// reduced motion or paused animations it never starts and the frame is the final one; "Repetir la
// conversación" plays it again from the start.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConversationFrame, type ScriptLine, conversationSchedule, finalFrame, frameAt } from "./schedule";

function sameFrame(a: ConversationFrame, b: ConversationFrame): boolean {
  return a.shown === b.shown && a.done === b.done && a.pending?.index === b.pending?.index && a.pending?.phase === b.pending?.phase && a.pending?.chars === b.pending?.chars;
}

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export interface Playback {
  readonly frame: ConversationFrame;
  replay(): void;
}

export function usePlayback(lines: readonly ScriptLine[], animate: boolean, inView: boolean): Playback {
  const schedule = useMemo(() => conversationSchedule(lines), [lines]);
  const [frame, setFrame] = useState<ConversationFrame>(() => (animate ? frameAt(schedule, lines, 0) : finalFrame(lines)));
  const elapsed = useRef(0);
  const [round, setRound] = useState(0);
  const tabVisible = useTabVisible();
  const running = animate && inView && tabVisible && !frame.done;

  useEffect(() => {
    if (!animate) setFrame(finalFrame(lines));
  }, [animate, lines]);

  useEffect(() => {
    if (!running) return;
    const resumedAt = performance.now();
    const base = elapsed.current;
    let handle = 0;
    const tick = (now: number) => {
      elapsed.current = base + (now - resumedAt);
      const next = frameAt(schedule, lines, elapsed.current);
      setFrame((current) => (sameFrame(current, next) ? current : next));
      if (!next.done) handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [running, schedule, lines, round]);

  const replay = useCallback(() => {
    elapsed.current = 0;
    setFrame(frameAt(schedule, lines, 0));
    setRound((value) => value + 1);
  }, [schedule, lines]);

  return { frame: animate ? frame : finalFrame(lines), replay };
}
