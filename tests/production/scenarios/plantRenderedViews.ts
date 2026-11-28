import type { Scenario } from '../contract';
import { renderedViewCriteria } from '../criteria/renderedViews';
import { renderBrief } from '../render/brief';
import { renderIntent } from '../render/intent';
import { renderScript } from '../render/script';

/**
 * Visualisation job on the issued pipe rack (RV1 §7 V6): the office appearance library, site sun and sky, six rendered views and a
 * 12-frame turntable, graded on the issued files (independent PNG / EXR readers). render_realistic needs llull-compute (pathtrace), so the
 * in-process run skips it (`hostTools`) and `npm run production:scripted` runs it where the binary exists.
 */
export const plantRenderedViews: Scenario = {
  id: 'plant-rendered-views',
  title: renderIntent.title,
  client: 'Desmet',
  startsFrom: 'desmet-pipe-rack',
  brief: renderBrief(renderIntent),
  script: renderScript(renderIntent),
  hostTools: ['render_realistic'],
  criteria: renderedViewCriteria(renderIntent),
  // apply_appearance / assign_material are refused on building-plugin solids (derivation guard) and the elements' own material
  // (S355 ...) never reaches render_realistic: the plant renders in its default colours.
  knownIssues: { scripted: ['appearance-coverage'], ui: [] },
  agentBaseline: 0.6,
};
