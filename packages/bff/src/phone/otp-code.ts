// The six-digit code inside the transcript of Meta's verification call. Transcribe writes digits
// ("1 2 3 4 5 6", "123-456") or words, in English or Spanish ("one two three", "cuatro cinco seis");
// Meta reads the code more than once. Every run of digits that is the code, or the code repeated, is
// a candidate; the most frequent candidate wins, so one misheard repetition does not.

export const OTP_LENGTH = 6;

const WORDS: Readonly<Record<string, string>> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  cero: "0", uno: "1", un: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9",
};

/** Digits of one token, or `undefined` when the token is not a number. */
function digitsOf(token: string): string | undefined {
  if (/^\d+$/.test(token)) return token;
  return WORDS[token];
}

/** Runs of consecutive number tokens, each joined into one string of digits. */
export function digitRuns(transcript: string): string[] {
  const tokens = transcript
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d)[-.,](?=\d)/g, "$1 ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
  const runs: string[] = [];
  let current = "";
  for (const token of tokens) {
    const digits = digitsOf(token);
    if (digits !== undefined) {
      current += digits;
      continue;
    }
    if (current !== "") runs.push(current);
    current = "";
  }
  if (current !== "") runs.push(current);
  return runs;
}

/** The codes a run holds: itself when it has six digits, or its chunks when it is the same code repeated. */
function candidatesOf(run: string): string[] {
  if (run.length < OTP_LENGTH || run.length % OTP_LENGTH !== 0) return [];
  const chunks = run.match(new RegExp(`\\d{${OTP_LENGTH}}`, "g")) ?? [];
  return chunks.every((chunk) => chunk === chunks[0]) ? chunks : [];
}

/** The code read in `transcript`, or `undefined` when no run is a six-digit code. */
export function extractOtp(transcript: string): string | undefined {
  const counts = new Map<string, number>();
  for (const run of digitRuns(transcript)) for (const code of candidatesOf(run)) counts.set(code, (counts.get(code) ?? 0) + 1);
  let best: string | undefined;
  for (const [code, count] of counts) if (best === undefined || count > (counts.get(best) ?? 0)) best = code;
  return best;
}
