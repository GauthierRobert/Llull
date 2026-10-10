/**
 * @layer server/tests
 * Parse one named SSE frame (`event: <type>\ndata: <json>\n\n`) written by liveDocument.
 */
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { Response } from 'express';

interface ParsedSseFrame {
  event: string;
  data: Record<string, unknown>;
}

export function parseSseFrame(frame: string): ParsedSseFrame {
  const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
  if (eventLine === undefined || dataLine === undefined) {
    throw new Error(`Malformed SSE frame: ${JSON.stringify(frame)}`);
  }
  return {
    event: eventLine.slice('event: '.length),
    data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
  };
}

/**
 * Entity ids a frame makes present (MG5.1 protocol): snapshot → all entities of `document`;
 * command → ids the command creates when re-run through `execute` on `base` (default: empty).
 */
export function frameEntityIds(frame: string, base: CadDocument = createEmptyDocument()): string[] {
  const { event, data } = parseSseFrame(frame);
  if (event === 'snapshot') {
    const document = data['document'] as { entities: Record<string, unknown> };
    return Object.keys(document.entities);
  }
  const after = execute(base, data['name'] as string, data['params']).document;
  return after.order.filter((id) => base.entities[id] === undefined);
}

export type FakeRes = Response & { written: string[]; ended: boolean };

/** Minimal Express Response that records SSE writes (usable with `subscribeLive`). */
export function makeFakeRes(): FakeRes {
  const res = {
    written: [] as string[],
    ended: false,
    write(chunk: string): boolean {
      res.written.push(chunk);
      return true;
    },
    end(): void {
      res.ended = true;
    },
  };
  return res as unknown as FakeRes;
}
