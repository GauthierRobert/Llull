import { z } from '@core/commands/schema';

const SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** ISO-8601 UTC like 2026-11-02T09:30:00Z naming a real instant (2026-02-31 and 25:00 are refused). */
export const isIsoUtc = (text: string): boolean => {
  if (!SHAPE.test(text)) return false;
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text.slice(0, 10);
};

/** The `at` param of a host-stamped human act: ISO-8601 UTC naming a real instant. */
export const isoUtc = z.string().refine(isIsoUtc, 'must be ISO-8601 UTC like 2026-11-02T09:30:00Z naming a real date and time');
