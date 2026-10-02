// The timing of the landing's motion as pure functions (docs/landing-spec.md §4.4 and §4.5), so the
// hooks only run a clock over them and motion.test.ts can check the numbers: the hero conversation
// writes itself once in at most 12 s, a counter eases from 0 to its value in 1.2 s, and with reduced
// motion (or "Pausar animaciones") everything is in its final state from the first frame.

/** Cadence of the hero conversation. */
export const CADENCE = {
  /** Before the first message, once the hero is on screen. */
  startDelayMs: 400,
  /** "Escribiendo" before a message of the firm. */
  typingMs: 900,
  /** The tapped button lights up before the importer's bubble. */
  tapHighlightMs: 200,
  /** A free text of the importer is written character by character, capped per message. */
  charMs: 28,
  maxWritingMs: 1_200,
  /** Between two messages. */
  pauseMs: 1_400,
  /** The whole conversation never takes longer. */
  maxTotalMs: 12_000,
} as const;

export const COUNTER_MS = 1_200;

/** One line of the script: a message of the firm, a tap of the importer on a button, or the importer's own text. */
export interface ScriptLine {
  readonly kind: "firm" | "tap" | "text";
  readonly text: string;
}

export type BeatPhase = "typing" | "highlight" | "writing";

/** What happens before line `index` appears: its lead-in phase and when the line itself shows. */
export interface Beat {
  readonly index: number;
  readonly phase: BeatPhase;
  readonly startMs: number;
  readonly showAtMs: number;
}

export interface Schedule {
  readonly beats: readonly Beat[];
  readonly totalMs: number;
}

function leadIn(line: ScriptLine): { readonly phase: BeatPhase; readonly ms: number } {
  if (line.kind === "firm") return { phase: "typing", ms: CADENCE.typingMs };
  if (line.kind === "tap") return { phase: "highlight", ms: CADENCE.tapHighlightMs };
  return { phase: "writing", ms: Math.min(CADENCE.maxWritingMs, line.text.length * CADENCE.charMs) };
}

/** The timeline of a conversation: each line's lead-in and the moment it shows, a pause between lines. */
export function conversationSchedule(lines: readonly ScriptLine[]): Schedule {
  let at: number = CADENCE.startDelayMs;
  const beats = lines.map((line, index) => {
    const lead = leadIn(line);
    const startMs = index === 0 ? at : at + CADENCE.pauseMs;
    const beat: Beat = { index, phase: lead.phase, startMs, showAtMs: startMs + lead.ms };
    at = beat.showAtMs;
    return beat;
  });
  return { beats, totalMs: at };
}

export interface ConversationFrame {
  /** How many lines are fully shown. */
  readonly shown: number;
  /** The line being led in, with its phase and, while writing, how many characters are out. */
  readonly pending?: { readonly index: number; readonly phase: BeatPhase; readonly chars: number };
  readonly done: boolean;
}

/** What the conversation shows `elapsedMs` after it started. */
export function frameAt(schedule: Schedule, lines: readonly ScriptLine[], elapsedMs: number): ConversationFrame {
  const shown = schedule.beats.filter((beat) => beat.showAtMs <= elapsedMs).length;
  const next = schedule.beats[shown];
  if (!next || elapsedMs < next.startMs) return { shown, done: shown === lines.length };
  const length = lines[next.index]?.text.length ?? 0;
  const progress = (elapsedMs - next.startMs) / Math.max(1, next.showAtMs - next.startMs);
  const chars = next.phase === "writing" ? Math.min(length, Math.floor(progress * length)) : 0;
  return { shown, pending: { index: next.index, phase: next.phase, chars }, done: false };
}

/** The final frame: every line shown (reduced motion, paused animations, or the end of the play). */
export function finalFrame(lines: readonly ScriptLine[]): ConversationFrame {
  return { shown: lines.length, done: true };
}

export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

/** A counter's value `elapsedMs` after it started counting from 0 to `target`. */
export function counterAt(target: number, elapsedMs: number, durationMs: number = COUNTER_MS): number {
  if (elapsedMs >= durationMs) return target;
  return Math.round(target * easeOutCubic(elapsedMs / durationMs));
}
