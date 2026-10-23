import { normalizeContactPhone } from "../imports/phone";

export const MAX_OPT_OUT_NUMBERS = 5000;

export type OptOutRejection = { line: number; value: string; message: string };
export type ParsedOptOutInput = {
  numbers: string[];
  duplicates: number;
  rejected: OptOutRejection[];
  tooMany: boolean;
};

/** Accepts one number per line, or numbers separated by commas, semicolons, or tabs. */
export function parseOptOutInput(text: string, defaultCountry?: string): ParsedOptOutInput {
  const seen = new Set<string>();
  const rejected: OptOutRejection[] = [];
  let duplicates = 0;
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((line, index) => {
    for (const raw of line.split(/[,;\t]/)) {
      const value = raw.trim();
      if (!value) continue;
      const result = normalizeContactPhone(value, defaultCountry);
      if (!result.ok) {
        rejected.push({ line: index + 1, value: value.slice(0, 40), message: result.message });
      } else if (seen.has(result.e164)) {
        duplicates += 1;
      } else {
        seen.add(result.e164);
      }
    }
  });
  const numbers = [...seen];
  return { numbers, duplicates, rejected, tooMany: numbers.length > MAX_OPT_OUT_NUMBERS };
}
