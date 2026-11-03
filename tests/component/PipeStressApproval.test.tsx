import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { humanGatePayload } from '@core/model/humanGate';
import { useStore } from '@ui/store';
import { PipeStressPanel } from '@ui/panels/pipeStress/PipeStressPanel';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';
import { anchorAt, baseDoc, cases, conditioned, withModel, withPipe } from '../unit/plant/stress/m3Fixtures';

function recordedModel(): string {
  const { doc, id: pipeId } = withPipe(
    baseDoc(),
    [
      [0, 0, 3000],
      [6000, 0, 3000],
      [6000, 3000, 3000],
    ],
    168.3,
    { dn: 150 },
  );
  const { doc: modelled, id } = withModel(doc, [pipeId]);
  const set = conditioned(
    modelled,
    id,
    { installTempC: 20, temperatures: [{ name: 'T1', tempC: 207.5 }], wallMm: 7.11 },
    { thermal: { meanCtePerK: 1.2e-5 } },
  );
  const anchored = anchorAt(anchorAt(set, id, pipeId, 0), id, pipeId, 9000);
  const list = [
    { name: 'L1', type: 'SUS', basic: ['W'] },
    { name: 'L2', type: 'OPE', basic: ['W', 'T1'] },
    {
      name: 'L3',
      type: 'EXP',
      combine: [
        { case: 'L2', factor: 1 },
        { case: 'L1', factor: -1 },
      ],
    },
  ];
  useStore.getState().setDocument(cases(anchored, id, list));
  localDispatch('record_pipe_stress_results', { modelId: id });
  return id;
}

beforeEach(() => {
  resetStore();
  useStore.setState({ liveStatus: 'disconnected' });
});

describe('PipeStressPanel approval signature', () => {
  it('signs the exact act payload and dispatches approve_pipe_stress with the signature object and an ISO at', async () => {
    let signed: { payloadSha256?: string; act?: string } = {};
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/signing/keys'))
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [{ keyId: 'k-1', userId: 'u-1', name: 'J. Example', trusted: true }] }), { status: 200 }),
        );
      signed = JSON.parse(String(init?.body)) as typeof signed;
      return Promise.resolve(
        new Response(
          JSON.stringify({ signature: { alg: 'Ed25519', keyId: 'k-1', publicKey: 'a'.repeat(64), signature: 'b'.repeat(128) } }),
          { status: 200 },
        ),
      );
    });
    const modelId = recordedModel();
    const recorded = useStore.getState().document.plant?.stress?.models[modelId]?.recorded;
    const dispatch = vi.fn();
    useStore.setState({ dispatch });
    render(<PipeStressPanel />);
    fireEvent.click(screen.getByTestId('stress-approve'));
    await screen.findByText(/J. Example/);
    fireEvent.change(screen.getByTestId('sign-passphrase'), { target: { value: 'a long passphrase' } });
    fireEvent.click(screen.getByTestId('sign-confirm'));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    const [name, params] = dispatch.mock.calls[0] as [string, { modelId: string; confirmation: Record<string, unknown>; at: string }];
    expect(name).toBe('approve_pipe_stress');
    expect(params.modelId).toBe(modelId);
    expect(typeof params.confirmation).toBe('object');
    expect(params.confirmation).toMatchObject({ alg: 'Ed25519', keyId: 'k-1' });
    expect(params.confirmation).not.toEqual({ verified: true });
    const nonce = params.confirmation['nonce'];
    expect(typeof nonce).toBe('string');
    expect(params.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(signed.payloadSha256).toBe(
      humanGatePayload(
        'plant:approve_pipe_stress',
        [modelId],
        { inputHash: recorded?.inputHash, resultHash: recorded?.resultHash },
        nonce as string,
      ),
    );
    vi.unstubAllGlobals();
  });
});
