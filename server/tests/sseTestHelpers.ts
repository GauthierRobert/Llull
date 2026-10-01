/**
 * @layer server/tests
 * Parse one named SSE frame (`event: <type>\ndata: <json>\n\n`) written by liveDocument.
 */
export interface ParsedSseFrame {
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

/** Entity ids a frame makes present: snapshot → all entities; patch → added entities. */
export function frameEntityIds(frame: string): string[] {
  const { event, data } = parseSseFrame(frame);
  if (event === 'snapshot') return Object.keys(data['entities'] as Record<string, unknown>);
  const delta = data['entities'] as { added: Record<string, unknown> };
  return Object.keys(delta.added);
}
