/**
 * M4c of the assembly-scale pack: `.lld` modules (`use "file.lld" as ns with …`): typed params, namespaced aliases, exports, an own layer and
 * group per instance, DAG imports, SHA-256 embedded sources (VC-ASC-18 / 19).
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { sha256Hex } from '@lib/sha256';

const dir = new URL('../../../docs/design/08-assembly-scale/validation/plans/target_v2_modules/', import.meta.url);
/** The plan without what later milestones build: connection groups (M3) and the geometry-dependent `check max`. */
const plan = (file: string): string =>
  readFileSync(new URL(file, dir), 'utf8')
    .replace(/^\s*add_connection_group.*$/gm, '')
    .replace(/^check max.*$/gm, '');

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

const apply = (source: string, modules?: Record<string, string>, doc: CadDocument = createEmptyDocument()): CommandResult =>
  execute(doc, 'apply_design', modules === undefined ? { source } : { source, modules });
const code = (r: CommandResult): string | undefined => r.error?.code;

const POST = `module post(h: length = 10, n: int = 2) {
  fn dbl(x) = x * 2
  add_box base size=[10, 10, dbl(h)]
  add_box top size=[5, 5, n] on=base.top
  export base, top
}
`;
const USE_POST = 'use "post.lld" as p with h=3\n';

describe('engine plan (VC-ASC-18)', () => {
  const files = { 'fan.lld': plan('fan.lld'), 'stage.lld': plan('stage.lld') };
  let doc: CadDocument;
  let result: CommandResult;
  beforeAll(() => {
    result = apply(plan('engine.lld'), files);
    doc = result.document;
  });

  it('runs on the Manifold kernel as ONE design_source step with the modules embedded', () => {
    expect(result.error).toBeUndefined();
    expect(doc.featureHistory.map((s) => s.name)).toEqual(['design_source']);
    const embedded = (doc.featureHistory[0]?.params as { modules: { path: string; sha256: string; text: string }[] }).modules;
    expect(embedded.map((m) => m.path)).toEqual(['fan.lld', 'stage.lld']);
    expect(embedded.map((m) => m.sha256)).toEqual(embedded.map((m) => sha256Hex(m.text)));
  });

  it('namespaces the exported aliases and hides the rest', () => {
    const aliases = Object.keys((result.data as { aliases: Record<string, string[]> }).aliases);
    expect(aliases).toEqual(expect.arrayContaining(['fan.disk', 'fan.blade', 'fan.blades', 'hpc1.casing', 'hpc2.blades']));
    expect(aliases).not.toContain('fan.af');
    expect(aliases).not.toContain('hpc1.sec');
  });

  it('gives each instance its own layer and group', () => {
    const instances = (result.data as { moduleInstances: { ns: string; layerId: string; groupId: string; entities: number }[] })
      .moduleInstances;
    expect(instances.map((i) => i.ns)).toEqual(['fan', 'hpc1', 'hpc2']);
    for (const instance of instances) {
      expect(doc.layers[instance.layerId]?.name).toBe(instance.ns);
      expect(doc.groups[instance.groupId]?.name).toBe(instance.ns);
      expect(doc.groups[instance.groupId]?.memberIds).toHaveLength(instance.entities);
    }
    const fan = instances[0];
    expect(doc.entities[doc.groups[fan?.groupId ?? '']?.memberIds[0] ?? '']?.layerId).toBe(fan?.layerId);
  });

  it('replays from the embedded sources with no files (VC-ASC-19)', () => {
    const replayed = execute(doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(doc.entities));
    expect(replayed.document.layers).toEqual(doc.layers);
    expect(replayed.document.groups).toEqual(doc.groups);
    expect(replayed.document.order).toEqual(doc.order);
  });

  it('regenerates on set_parameter with identical ids and no stale layers', () => {
    const next = execute(doc, 'set_parameter', { name: 'fanR', expression: '860' });
    expect(next.error).toBeUndefined();
    expect(Object.keys(next.document.entities)).toEqual(Object.keys(doc.entities));
    expect(Object.keys(next.document.layers)).toEqual(Object.keys(doc.layers));
    expect(Object.keys(next.document.groups)).toEqual(Object.keys(doc.groups));
  });

  it('re-applying edited files reports DESIGN_MODULE_HASH_CHANGED; unchanged or omitted files do not', () => {
    const edited = apply(plan('engine.lld'), { ...files, 'fan.lld': `${files['fan.lld']}\n# edit` }, doc);
    expect(edited.error).toBeUndefined();
    expect(edited.summary).toContain('DESIGN_MODULE_HASH_CHANGED');
    expect((edited.data as { warnings: { path: string }[] }).warnings.map((w) => w.path)).toEqual(['fan.lld']);
    const same = apply(plan('engine.lld'), files, doc);
    expect(same.summary).not.toContain('DESIGN_MODULE_HASH_CHANGED');
    const omitted = apply(plan('engine.lld'), undefined, doc);
    expect(omitted.error).toBeUndefined();
    expect(omitted.summary).not.toContain('DESIGN_MODULE_HASH_CHANGED');
  });

  it('expand_design reports the module file of each line, with namespaced aliases', () => {
    const r = execute(doc, 'expand_design', {});
    const lines = (r.data as { lines: { alias: string | null; file: string | null }[] }).lines;
    expect(lines.some((l) => l.file === null)).toBe(false);
    expect(lines.filter((l) => l.file === 'fan.lld').map((l) => l.alias)).toContain('fan.disk');
    expect(lines.filter((l) => l.file === 'stage.lld')).not.toHaveLength(0);
  });
});

describe('module semantics', () => {
  it('typed params: defaults, units, shadowing of document params, module functions', () => {
    const r = apply(
      `param h = 99\n${USE_POST}use "post.lld" as q with h=2cm n=4\ncheck bbox of=p.base expect == [10, 10, 6]\ncheck bbox of=q.base expect == [10, 10, 40]`,
      { 'post.lld': POST },
    );
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain('2/2 checks pass');
    expect((r.data as { moduleInstances: unknown[] }).moduleInstances).toHaveLength(2);
  });

  it('anchors, indices and expressions reach namespaced aliases', () => {
    const r = apply(
      `${USE_POST}add_box c size=[1, 1, 1] on=p.top.top\nadd_box d size=[(if len(p.base) == 1 then 2 else 3), 1, 1]\ncheck bbox of=d expect == [2, 1, 1]\ncheck bbox of=p.top expect == [5, 5, 2]`,
      { 'post.lld': POST },
    );
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain('2/2 checks pass');
  });

  it('instances in a loop take placeholders; nested modules namespace twice', () => {
    const nested = `module pair() {\n  use "post.lld" as inner with h=1\n  add_box extra size=[1, 1, 1]\n  export extra, inner.base\n}\n`;
    const r = apply(
      `for i in 0..1 {\n  use "post.lld" as m{i}\n}\nuse "pair.lld" as pr\ncheck bbox of=pr.inner.base expect == [10, 10, 2]`,
      { 'post.lld': POST, 'pair.lld': nested },
    );
    expect(r.error).toBeUndefined();
    const aliases = Object.keys((r.data as { aliases: Record<string, string[]> }).aliases);
    expect(aliases).toEqual(expect.arrayContaining(['m0.base', 'm1.base', 'pr.extra', 'pr.inner.base']));
    expect(aliases).not.toContain('pr.inner.top');
    const names = (r.data as { moduleInstances: { ns: string }[] }).moduleInstances.map((i) => i.ns);
    expect(names).toEqual(['m0', 'm1', 'pr.inner', 'pr']);
  });

  it('one entity makes a layer but no group; none makes neither', () => {
    const single = apply('use "s.lld" as s', { 's.lld': 'module s() {\n  add_box one size=[1, 1, 1]\n  export one\n}\n' });
    const instance = (single.data as { moduleInstances: { layerId: string | null; groupId: string | null }[] }).moduleInstances[0];
    expect(instance?.layerId).not.toBeNull();
    expect(instance?.groupId).toBeNull();
    const none = apply('use "n.lld" as n\nadd_box b size=[1, 1, 1]', {
      'n.lld': 'module n() {\n  for i in 0..-1 {\n    add_box x size=[1, 1, 1]\n  }\n}\n',
    });
    expect((none.data as { moduleInstances: { layerId: string | null }[] }).moduleInstances[0]?.layerId).toBeNull();
  });
});

describe('refusals by name', () => {
  const refused = (source: string, modules: Record<string, string>, expected: string): void => {
    const r = apply(source, modules);
    expect(code(r), r.summary).toBe(`DESIGN_${expected}`);
    expect(r.document.featureHistory).toHaveLength(0);
  };

  it('missing, cyclic, deep and oversized modules', () => {
    refused(USE_POST, {}, 'MODULE_NOT_FOUND');
    expect(apply(USE_POST, { 'pots.lld': POST }).error?.remediation).toContain('pots.lld');
    const cycle = apply('use "a.lld" as a', {
      'a.lld': 'module a() {\n  use "b.lld" as b\n}\n',
      'b.lld': 'module b() {\n  use "a.lld" as a\n}\n',
    });
    expect(code(cycle)).toBe('DESIGN_MODULE_CYCLE');
    expect(cycle.summary).toContain('a.lld -> b.lld -> a.lld');
    const chain: Record<string, string> = {};
    for (let k = 0; k < 10; k++) chain[`m${k}.lld`] = `module m${k}() {\n  use "m${k + 1}.lld" as x\n}\n`;
    chain['m10.lld'] = 'module m10() {\n  add_box b size=[1, 1, 1]\n}\n';
    refused('use "m0.lld" as x', chain, 'MODULE_LIMIT');
    refused('use "big.lld" as b', { 'big.lld': `module big() {\n}\n${'#'.repeat(300_000)}` }, 'MODULE_LIMIT');
    const wide: Record<string, string> = {};
    let source = '';
    for (let k = 0; k < 65; k++) {
      wide[`w${k}.lld`] = 'module w() {\n  add_box b size=[1, 1, 1]\n}\n';
      source += `use "w${k}.lld" as w${k}\n`;
    }
    refused(source, wide, 'MODULE_LIMIT');
    expect(code(apply('for i in 0..299 {\n  use "post.lld" as m{i}\n}', { 'post.lld': POST }))).toMatch(/DESIGN_(LOOP|MODULE)_LIMIT/);
  });

  it('paths must be relative and stay inside the design folder', () => {
    for (const path of ['/etc/x.lld', '../x.lld', 'a/../../x.lld', 'x.txt', 'C:/x.lld', 'a\\\\b.lld', ''])
      expect(code(apply(`use "${path}" as x`, {})), path).toBe('DESIGN_MODULE_PATH');
    expect(code(apply(USE_POST, { '../post.lld': POST }))).toBe('DESIGN_MODULE_PATH');
    expect(apply('use "./sub//post.lld" as p', { 'sub/post.lld': POST }).error).toBeUndefined();
  });

  it('arguments: unknown, missing, repeated, non-integer, wrong shape', () => {
    const m = { 'm.lld': 'module m(a: length, n: int = 2) {\n  add_box b size=[a, 1, n]\n}\n' };
    refused('use "m.lld" as m with a=1 z=2', m, 'MODULE_PARAM');
    refused('use "m.lld" as m', m, 'MODULE_PARAM');
    refused('use "m.lld" as m with a=1 a=2', m, 'MODULE_PARAM');
    refused('use "m.lld" as m with a=1 n=1.5', m, 'MODULE_PARAM');
    refused('use "m.lld" as m with a=[1, 2]', m, 'MODULE_PARAM');
    expect(apply('use "m.lld" as m with a=2in', m).error).toBeUndefined();
  });

  it('namespaces are unique; exports are enforced', () => {
    refused(`${USE_POST}${USE_POST}`, { 'post.lld': POST }, 'MODULE_NAMESPACE');
    const hidden = apply('use "h.lld" as h\nadd_box c size=[1, 1, 1] on=h.secret.top', {
      'h.lld': 'module h() {\n  add_box secret size=[1, 1, 1]\n  add_box shown size=[1, 1, 1]\n  export shown\n}\n',
    });
    expect(code(hidden)).toBe('DESIGN_UNKNOWN_ANCHOR');
    refused('use "h.lld" as h', { 'h.lld': 'module h() {\n  add_box a size=[1, 1, 1]\n  export ghost\n}\n' }, 'UNKNOWN_ALIAS');
  });

  it('module files are shaped: one module block, no params / checks / design lines, no module in the root', () => {
    const file = (text: string): void => refused('use "h.lld" as h', { 'h.lld': text }, 'SYNTAX');
    file('add_box a size=[1, 1, 1]\n');
    file('module h() {\n}\nmodule k() {\n}\n');
    file('module h() {\n  param w = 1\n}\n');
    file('module h() {\n  add_box a size=[1, 1, 1]\n  check volume of=a expect == 1\n}\n');
    file('module h(a: color) {\n}\n');
    file('module h(a: int, a: int) {\n}\n');
    file('module h {\n}\n');
    file('module h() {\n  for i in 0..1 {\n    export a\n  }\n}\n');
    refused('module m() {\n}\nadd_box b size=[1, 1, 1]', {}, 'SYNTAX');
    refused('export a', {}, 'SYNTAX');
    refused('use fan as f', {}, 'SYNTAX');
    refused('use "a.lld" as 1x', {}, 'SYNTAX');
    refused('use "a.lld" as a oops', {}, 'SYNTAX');
    refused('for i in 0..1 {\n  module m() {\n  }\n}', {}, 'SYNTAX');
  });

  it('errors inside a module name its file; a tampered embedded copy is refused', () => {
    const r = apply('use "bad.lld" as b', { 'bad.lld': 'module bad() {\n  add_box a size=[1, 1\n}\n' });
    expect(code(r)).toBe('DESIGN_SYNTAX');
    expect(r.summary).toContain('[bad.lld]');
    const run = apply('use "bad.lld" as b', { 'bad.lld': 'module bad() {\n  add_box a size=[nope, 1, 1]\n}\n' });
    expect(run.summary).toContain('[bad.lld]');
    const params = apply(USE_POST, { 'post.lld': POST }).document.featureHistory[0]?.params as {
      modules: { path: string; sha256: string; text: string }[];
    };
    const forged = execute(createEmptyDocument(), 'design_source', {
      ...params,
      modules: [{ ...(params.modules[0] as object), text: POST.replace('10', '11') }],
    });
    expect(code(forged)).toBe('DESIGN_MODULE_HASH_CHANGED');
    expect(execute(createEmptyDocument(), 'design_source', params).error).toBeUndefined();
  });

  it('expand_design takes module files too', () => {
    const expand = (modules?: Record<string, string>): CommandResult =>
      execute(createEmptyDocument(), 'expand_design', modules === undefined ? { source: USE_POST } : { source: USE_POST, modules });
    expect(code(expand({ '/abs.lld': POST }))).toBe('DESIGN_MODULE_PATH');
    expect(code(expand())).toBe('DESIGN_MODULE_NOT_FOUND');
    expect(expand({ 'post.lld': POST }).error).toBeUndefined();
  });
});
