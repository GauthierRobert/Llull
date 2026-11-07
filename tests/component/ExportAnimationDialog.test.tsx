import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { SimulationData } from '@dynamics/sim/simulationReport';
import { ExportAnimationDialog } from '@ui/components/ExportAnimationDialog';
import { ExportAnimationButton } from '@ui/components/ExportAnimationButton';
import { TimelineDock } from '@ui/components/TimelineDock';
import { animationParams, defaultAnimationForm, videoLengthOf } from '@ui/services/animationExportModel';
import { useStore } from '@ui/store';
import { useAnimationExportStore } from '@ui/store/animationExportStore';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';

const SPIN = { mode: 'spin', speed: 1, axis: [0, 0, 1] } as const;

function spinningBox(): ReturnType<typeof createEmptyDocument> {
  const box = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  const id = box.affected[0] ?? '';
  return execute(box.document, 'animate', { targetId: id, ...SPIN }).document;
}

const field = (testId: string): HTMLElement => screen.getByTestId(testId);
const set = (testId: string, value: string): boolean => fireEvent.change(field(testId), { target: { value } });

let dispatched: Array<{ name: string; params: Record<string, unknown> }>;
let downloads: string[];

beforeEach(() => {
  dispatched = [];
  downloads = [];
  const original = useStore.getState().dispatch;
  useStore.setState({
    document: spinningBox(),
    liveStatus: 'disconnected',
    dispatch: (name, params, options) => {
      dispatched.push({ name, params: params as Record<string, unknown> });
      original(name, params, options);
    },
  });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:animation'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function openDialog(): void {
  render(
    <>
      <ExportAnimationButton />
      <ExportAnimationDialog />
    </>,
  );
  fireEvent.click(screen.getByTestId('export-animation-open'));
}

/** A small, fast film: 1 s at 5 fps. */
function shortFilm(format: string): void {
  set('export-animation-duration', '1');
  set('export-animation-fps', '5');
  set('export-animation-size', '640x360');
  set('export-animation-format', format);
}

describe('animation export form (param gathering)', () => {
  it('prefills the source the document can play and the transport run and speed', () => {
    const clips = defaultAnimationForm(spinningBox(), null);
    expect(clips.source).toBe('clips');
    const empty = defaultAnimationForm(createEmptyDocument(), null);
    expect(empty.source).toBe('simulation');
    expect(empty.playbackRate).toBe('0.833');
    const played = defaultAnimationForm(createEmptyDocument(), { duration: 0.06, speed: 0.01 });
    expect([played.duration, played.playbackRate]).toEqual(['0.06', '0.01']);
    expect(videoLengthOf(played)).toEqual({ frames: 181, seconds: 181 / 30 });
  });

  it('builds the save params exactly as typed, and a small preview with a contact sheet', () => {
    const form = {
      ...defaultAnimationForm(createEmptyDocument(), null),
      duration: '0.06',
      playbackRate: '0.01',
      fps: '30',
      orbit: true,
      turns: '2',
    };
    const save = animationParams(form, createEmptyDocument(), 'save');
    expect(save).toEqual({
      ok: true,
      params: {
        source: { kind: 'simulation', duration: 0.06, playbackRate: 0.01 },
        fps: 30,
        width: 1280,
        height: 720,
        camera: { view: 'iso', orbit: { turns: 2, loop: true } },
        overlays: { time: true, highlight: 'none' },
        format: 'mp4',
        quality: 'standard',
      },
    });
    const preview = animationParams(form, createEmptyDocument(), 'preview');
    expect(preview).toMatchObject({ ok: true, params: { width: 480, height: 270, format: 'frames', sheet: { every: 16 } } });
  });

  it('refuses nonsense before dispatching and takes revolute sweeps in degrees', () => {
    const base = defaultAnimationForm(createEmptyDocument(), null);
    expect(animationParams({ ...base, fps: '0' }, createEmptyDocument(), 'save')).toMatchObject({ ok: false });
    expect(animationParams({ ...base, duration: 'abc' }, createEmptyDocument(), 'save')).toMatchObject({ ok: false });
    expect(animationParams({ ...base, source: 'still' }, createEmptyDocument(), 'save')).toMatchObject({ ok: false });
    const sweep = animationParams({ ...base, source: 'sweep', target: '' }, createEmptyDocument(), 'save');
    expect(sweep).toEqual({ ok: false, message: 'Name the joint or parameter to sweep.' });
    const joint = { ...createEmptyDocument(), joints: { 'joint-1': { kind: 'revolute' } } } as unknown as ReturnType<
      typeof createEmptyDocument
    >;
    const turned = animationParams({ ...base, source: 'sweep', target: 'joint-1', start: '0', end: '180', pingPong: false }, joint, 'save');
    expect(turned).toMatchObject({ ok: true, params: { source: { kind: 'sweep', end: Math.PI, pingPong: false } } });
  });
});

describe('Export animation dialog', () => {
  it('opens from the transport bar of a played simulation and shows its state, prefilled', () => {
    useDynamicsPlaybackStore.setState({
      result: { duration: 4 } as unknown as SimulationData,
      cursorTime: 1.5,
      playing: false,
      speed: 0.25,
    });
    render(
      <>
        <TimelineDock times={[0, 4]}>{() => null}</TimelineDock>
        <ExportAnimationDialog />
      </>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('timeline-export'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(field('export-animation-transport')).toHaveTextContent('paused at 1.5 s of 4 s, 0.25× speed');
    expect(useAnimationExportStore.getState().open).toBe(true);
  });

  it('Preview dispatches render_animation as a small frame sequence with a sheet and shows the contact sheet', async () => {
    openDialog();
    shortFilm('apng');
    fireEvent.click(field('export-animation-preview-button'));
    const sheet = await screen.findByTestId('export-animation-sheet', undefined, { timeout: 20_000 });
    expect(sheet.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(dispatched.map((call) => call.name)).toEqual(['render_animation']);
    expect(dispatched[0]?.params).toMatchObject({
      source: { kind: 'clips', duration: 1 },
      fps: 5,
      width: 480,
      height: 270,
      format: 'frames',
      sheet: { every: 1 },
    });
    expect(downloads).toEqual([]);
    // a text label cannot be drawn without a font: the command's warning is shown, not hidden
    expect(screen.getAllByTestId('export-animation-warning')[0]).toHaveTextContent('MOV_OVERLAY_TEXT_SKIPPED');
    // changing a parameter drops the stale preview
    set('export-animation-fps', '6');
    expect(screen.queryByTestId('export-animation-sheet')).toBeNull();
  }, 30_000);

  it('Save dispatches the chosen format at the chosen size and hands the file to the Save dialog', async () => {
    openDialog();
    shortFilm('apng');
    fireEvent.click(field('export-animation-save'));
    await waitFor(() => expect(downloads).toEqual(['animation.apng']), { timeout: 20_000 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.params).toMatchObject({
      source: { kind: 'clips', duration: 1 },
      fps: 5,
      width: 640,
      height: 360,
      format: 'apng',
      overlays: { time: true, highlight: 'none' },
    });
    expect(field('export-animation-notice')).toHaveTextContent('animation.apng is ready');
    expect(field('export-animation-length')).toHaveTextContent('6 frames');
  }, 30_000);

  it('shows the command refusal (no video encoder here) and saves nothing', async () => {
    openDialog();
    shortFilm('mp4');
    fireEvent.click(field('export-animation-save'));
    const error = await screen.findByTestId('export-animation-error');
    expect(error).toHaveTextContent(/NATIVE_TOOL_MISSING/);
    expect(downloads).toEqual([]);
    expect(dispatched[0]?.params).toMatchObject({ format: 'mp4', quality: 'standard' });
  });

  it('does not dispatch when a number is wrong, and says which', () => {
    openDialog();
    set('export-animation-fps', '90');
    fireEvent.click(field('export-animation-save'));
    expect(field('export-animation-error')).toHaveTextContent('whole number from 1 to 60');
    expect(dispatched).toEqual([]);
  });

  it('disables both buttons while a render runs, then closes with Escape', async () => {
    openDialog();
    shortFilm('mp4');
    fireEvent.click(field('export-animation-save'));
    expect(field('export-animation-save')).toBeDisabled();
    expect(field('export-animation-preview-button')).toBeDisabled();
    await screen.findByTestId('export-animation-error');
    expect(field('export-animation-save')).not.toBeDisabled();
    act(() => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
