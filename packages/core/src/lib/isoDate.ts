/** The reason `text` is not a calendar date `YYYY-MM-DD`, or null. */
export function isoDateProblem(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return `'${text}' is not a date as YYYY-MM-DD`;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? null : `'${text}' is not a calendar date`;
}
