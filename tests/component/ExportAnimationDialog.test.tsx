import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { SimulationData } from '@dynamics/sim/simulationReport';
import { ExportAnimationDialog } from '@ui/components/ExportAnimationDialog';
import { ExportAnimationButton } from '@ui/components/ExportAnimationButton';
import { TimelineDock } from '@ui/components/TimelineDock';
import { renderAnimation, videoFileOf } from '@ui/services/animationExport';
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
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
const originalDispatch = useStore.getState().dispatch;

/** A 1x1 PNG: the dialog only base64-decodes and displays files; the real render is exercised once, tiny, in the last describe. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TEXT_WARNING = { code: 'MOV_OVERLAY_TEXT_SKIPPED', message: 'the time label needs a font' };

/** Answers like render_animation does (same `data` shape, asserted against the real command below) without rendering frames. */
function cannedRender(
  params: Record<string, unknown>,
  options: { onResult?: (r: { summary: string; changed: boolean }) => void } | undefined,
): void {
  const format = params['format'];
  if (format === 'mp4') {
    options?.onResult?.({ summary: 'render_animation refused: NATIVE_TOOL_MISSING — no video encoder (ffmpeg) found', changed: false });
    return;
  }
  const fileName = format === 'frames' ? 'sheet.png' : `animation.${String(format)}`;
  useStore.setState({
    lastMeasure: { command: 'render_animation', data: { files: [{ fileName, base64: PIXEL }], warnings: [TEXT_WARNING] } },
  });
  options?.onResult?.({ summary: 'rendered', changed: false });
}

beforeEach(() => {
  dispatched = [];
  downloads = [];
  useStore.setState({
    document: spinningBox(),
    liveStatus: 'disconnected',
    dispatch: (name, params, options) => {
      dispatched.push({ name, params: params as Record<string, unknown> });
      cannedRender(params as Record<string, unknown>, options);
    },
  });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:animation'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
  useStore.setState({ dispatch: originalDispatch });
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

/** A tiny film: 0.4 s at 5 fps = 3 frames. */
function shortFilm(format: string): void {
  set('export-animation-duration', '0.4');
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
    const sheet = await screen.findByTestId('export-animation-sheet');
    expect(sheet.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(dispatched.map((call) => call.name)).toEqual(['render_animation']);
    expect(dispatched[0]?.params).toMatchObject({
      source: { kind: 'clips', duration: 0.4 },
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
  });

  it('Save dispatches the chosen format at the chosen size and hands the file to the Save dialog', async () => {
    openDialog();
    shortFilm('apng');
    fireEvent.click(field('export-animation-save'));
    await waitFor(() => expect(downloads).toEqual(['animation.apng']));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.params).toMatchObject({
      source: { kind: 'clips', duration: 0.4 },
      fps: 5,
      width: 640,
      height: 360,
      format: 'apng',
      overlays: { time: true, highlight: 'none' },
    });
    expect(field('export-animation-notice')).toHaveTextContent('animation.apng was sent to the Save dialog');
    expect(field('export-animation-length')).toHaveTextContent('3 frames');
  });

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

  it('says what the command would refuse: too many frames, too long, too many orbit turns', () => {
    openDialog();
    set('export-animation-duration', '700');
    expect(field('export-animation-length')).toHaveTextContent('at most 600 s');
    set('export-animation-duration', '100');
    expect(field('export-animation-length')).toHaveTextContent('3001 frames: at most 1800');
    fireEvent.click(field('export-animation-save'));
    expect(field('export-animation-error')).toHaveTextContent('at most 1800');
    expect(dispatched).toEqual([]);
    set('export-animation-duration', '1');
    fireEvent.click(field('export-animation-orbit'));
    set('export-animation-turns', '101');
    expect(field('export-animation-length')).toHaveTextContent('Orbit turns are at most 100');
  });
});

/** A render the test finishes by hand: dispatch stores its callback instead of running the command. */
function deferRender(): { finish: (files: Array<{ fileName: string; base64: string }>) => void } {
  let pending: (() => void) | null = null;
  let files: Array<{ fileName: string; base64: string }> = [];
  useStore.setState({
    dispatch: (name, params, options) => {
      dispatched.push({ name, params: params as Record<string, unknown> });
      pending = () => {
        useStore.setState({ lastMeasure: { command: 'render_animation', data: { files, warnings: [] } } });
        options?.onResult?.({ summary: 'ok', changed: false });
      };
    },
  });
  return {
    finish: (result) => {
      files = result;
      act(() => pending?.());
    },
  };
}

describe('a render that outlives its form', () => {
  it('an edit during a preview drops the old sheet instead of showing it under the new form', async () => {
    openDialog();
    const render = deferRender();
    fireEvent.click(field('export-animation-preview-button'));
    set('export-animation-fps', '6');
    render.finish([{ fileName: 'sheet.png', base64: 'AAAA' }]);
    await Promise.resolve();
    expect(screen.queryByTestId('export-animation-sheet')).toBeNull();
    expect(field('export-animation-preview-button')).not.toBeDisabled();
  });

  it('shows the sheet when the form did not change', async () => {
    openDialog();
    const render = deferRender();
    fireEvent.click(field('export-animation-preview-button'));
    render.finish([{ fileName: 'sheet.png', base64: 'AAAA' }]);
    expect((await screen.findByTestId('export-animation-sheet')).getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(useStore.getState().lastMeasure).toBeNull();
  });

  it('closing the dialog during a save downloads nothing', async () => {
    openDialog();
    const render = deferRender();
    set('export-animation-format', 'apng');
    fireEvent.click(field('export-animation-save'));
    fireEvent.click(screen.getByRole('button', { name: 'Close export animation' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    render.finish([{ fileName: 'animation.apng', base64: 'AAAA' }]);
    await Promise.resolve();
    expect(downloads).toEqual([]);
  });

  it('a finished save is sent to the Save dialog and worded as such', async () => {
    openDialog();
    const render = deferRender();
    set('export-animation-format', 'gif');
    fireEvent.click(field('export-animation-save'));
    render.finish([{ fileName: 'animation.gif', base64: 'AAAA' }]);
    await waitFor(() => expect(downloads).toEqual(['animation.gif']));
    expect(field('export-animation-notice')).toHaveTextContent('sent to the Save dialog');
  });
});

describe('other sources and entry points', () => {
  it('a joint sweep is typed in degrees and dispatched in radians', () => {
    const base = spinningBox();
    useStore.setState({
      document: { ...base, joints: { 'joint-1': { kind: 'revolute' } }, jointOrder: ['joint-1'] } as unknown as typeof base,
    });
    useStore.setState({ document: { ...useStore.getState().document, animations: {} } });
    openDialog();
    expect(field('export-animation-source')).toHaveValue('sweep');
    set('export-animation-target', ' joint-1 ');
    set('export-animation-end', '180');
    const render = deferRender();
    fireEvent.click(field('export-animation-save'));
    render.finish([]);
    expect(dispatched[0]?.params).toMatchObject({ source: { kind: 'sweep', mode: 'joint', target: 'joint-1', start: 0, end: Math.PI } });
  });

  it('orbit and still: the orbit camera is gathered, a still without orbit is refused', () => {
    openDialog();
    fireEvent.click(field('export-animation-orbit'));
    set('export-animation-turns', '2');
    set('export-animation-source', 'still');
    fireEvent.click(field('export-animation-save'));
    expect(dispatched[0]?.params).toMatchObject({ source: { kind: 'still', duration: 4 }, camera: { orbit: { turns: 2, loop: true } } });
    fireEvent.click(field('export-animation-orbit'));
    fireEvent.click(field('export-animation-save'));
    expect(field('export-animation-error')).toHaveTextContent('needs the orbit camera');
  });
});

describe('the real command behind the canned dispatch', () => {
  it('render_animation renders a tiny film and returns the files and warnings the dialog reads', async () => {
    useStore.setState({ dispatch: originalDispatch });
    const preview = await renderAnimation({
      source: { kind: 'clips', duration: 0.2 },
      fps: 5,
      width: 64,
      height: 64,
      format: 'frames',
      sheet: { every: 1 },
    });
    expect(preview.ok && preview.files.map((file) => file.fileName)).toContain('sheet.png');
    const film = await renderAnimation({ source: { kind: 'clips', duration: 0.2 }, fps: 5, width: 64, height: 64, format: 'apng' });
    expect(film.ok && videoFileOf(film.files)?.fileName).toBe('animation.apng');
  });
});
