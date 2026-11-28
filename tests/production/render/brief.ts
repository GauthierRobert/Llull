import type { RenderIntent } from './intent';

/** The visualisation job as the lead engineer hands it over: every value the criteria check is in it. */
export function renderBrief(intent: RenderIntent): string {
  const library = intent.library.map(
    (entry) =>
      `  - "${entry.material}": library appearance ${entry.appearance}${entry.color !== undefined ? ` in ${entry.color}` : ''}, worn by every ${entry.categories.join(' / ')} element.`,
  );
  return [
    `# ${intent.title}`,
    '',
    'The issued pipe-rack model (job desmet-pipe-rack) is open. Units: millimetres. Do not change the model geometry.',
    '',
    '## Appearance library',
    '- Set up the office appearance library as materials (density 7850 kg/m3) and give every element of the rack its appearance:',
    ...library,
    '',
    '## Light',
    `- Site in Ghent: latitude ${intent.site.latitudeDeg}, longitude ${intent.site.longitudeDeg}, ${intent.site.dateTime} (the computed sun), and a clear sky environment (turbidity 3).`,
    '',
    '## Deliverables (path-traced with render_realistic, all at the same settings)',
    `- ${intent.width} x ${intent.height} px, ${intent.samples} samples per pixel, seed ${intent.seed}, denoised, zoom ${intent.zoom} over the framing of the whole model, deterministic CPU renders, marked as illustrations.`,
    `- Six views: ${intent.views.join(', ')} (framed on the whole model), each as PNG and scene-linear EXR.`,
    `- A turntable of ${intent.turntable.frames} PNG frames at equal azimuth steps around the model, view direction (cos a, sin a, ${intent.turntable.elevation}) for a = k x 360 / ${intent.turntable.frames} degrees, k = 0..${intent.turntable.frames - 1}.`,
  ].join('\n');
}
