// Fills the viewport overlay: runs `cfd_slice` / `cfd_streamlines`, fetches the stored file the transport names by hash, decodes it and
// publishes it to the flow view store. Read-only: nothing here changes the document.

import { useEffect } from 'react';
import { useStore } from '@ui/store';
import { useFlowViewStore, type LayerFeed } from '@ui/store/flowViewStore';
import { fetchCfdFile } from '@ui/services/cfdFiles';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';
import { parseSliceFile, parseStreamlinesFile } from '@ui/viewport/3d/cfd/cfdFiles';
import { callFlowTool, OFFLINE, type FlowOutcome } from './flowTransport';
import type { FlowCase } from './flowData';
import { rakeParams, sliceParams, type SliceAxis, type SliceField } from './flowQueries';

interface FlowLayers {
  readonly online: boolean;
  showSlice(choice: { axis: SliceAxis; field: SliceField; positionM: number | null }): void;
  traceStreamlines(count: number): void;
}

const refused = (reason: string): LayerFeed<never> => ({ status: 'refused', reason });

function fileHash(outcome: FlowOutcome): string | null {
  const file = isRecord(outcome.data) ? outcome.data['file'] : null;
  return isRecord(file) && typeof file['sha256'] === 'string' ? file['sha256'] : null;
}

/** The hash of the recorded result the query read (`data.resultsHash`). */
function resultsHashOf(outcome: FlowOutcome): string | null {
  return isRecord(outcome.data) && typeof outcome.data['resultsHash'] === 'string' ? outcome.data['resultsHash'] : null;
}

/** Drops the drawn layers once they no longer describe the case: another result was recorded (or it was deleted), or the result is stale. */
export function useDropStaleLayers(resultsHash: string | null, stale: boolean): void {
  const slice = useFlowViewStore((s) => s.slice);
  const streamlines = useFlowViewStore((s) => s.streamlines);
  const outdated = (feed: LayerFeed<{ readonly resultsHash: string }>): boolean =>
    feed.status === 'ready' && (stale || feed.value.resultsHash !== resultsHash);
  const dropSlice = outdated(slice);
  const dropStreamlines = outdated(streamlines);
  useEffect(() => {
    if (dropSlice) useFlowViewStore.getState().setSlice({ status: 'idle' });
    if (dropStreamlines) useFlowViewStore.getState().setStreamlines({ status: 'idle' });
  }, [dropSlice, dropStreamlines]);
}

/** Runs `tool`, then decodes the file it stored; the answer is a decoded value or the reason there is none. */
async function queryLayer<T>(
  tool: 'cfd_slice' | 'cfd_streamlines',
  params: Record<string, unknown>,
  decode: (bytes: Uint8Array) => T | string,
): Promise<{ value: T; summary: string; resultsHash: string } | { reason: string }> {
  const outcome = await callFlowTool(tool, params);
  if (!outcome.ok) return { reason: `${outcome.summary} ${outcome.remediation}`.trim() };
  const hash = fileHash(outcome);
  if (hash === null) return { reason: `${tool} returned no result file.` };
  const resultsHash = resultsHashOf(outcome);
  if (resultsHash === null) return { reason: `${tool} did not say which result it read.` };
  try {
    const decoded = decode(await fetchCfdFile(hash));
    return typeof decoded === 'string' ? { reason: decoded } : { value: decoded, summary: outcome.summary, resultsHash };
  } catch (err) {
    return { reason: errorMessage(err) };
  }
}

export function useFlowLayers(cfdCase: FlowCase): FlowLayers {
  const online = useStore((s) => s.liveStatus === 'connected');
  const { setSlice, setStreamlines } = useFlowViewStore.getState();
  const caseId = cfdCase.id;
  /** An answer is published only while the panel still shows the case it was asked for. */
  const current = (): boolean => useFlowViewStore.getState().caseId === caseId;

  return {
    online,
    showSlice: (choice) => {
      if (!online) return setSlice(refused(OFFLINE));
      setSlice({ status: 'loading' });
      void queryLayer('cfd_slice', sliceParams(cfdCase, choice), parseSliceFile).then((answer) => {
        if (current())
          setSlice(
            'value' in answer
              ? { status: 'ready', value: { caseId, resultsHash: answer.resultsHash, file: answer.value } }
              : refused(answer.reason),
          );
      });
    },
    traceStreamlines: (count) => {
      if (!online) return setStreamlines(refused(OFFLINE));
      setStreamlines({ status: 'loading' });
      void queryLayer('cfd_streamlines', rakeParams(cfdCase, count), parseStreamlinesFile).then((answer) => {
        if (current())
          setStreamlines(
            'value' in answer
              ? { status: 'ready', value: { caseId, resultsHash: answer.resultsHash, file: answer.value, summary: answer.summary } }
              : refused(answer.reason),
          );
      });
    },
  };
}
