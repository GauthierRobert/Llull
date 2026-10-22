/** Reference data of the 03 WRP validation pack (docs/design/03-wrap-emboss/validation) for the native tests. */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const pack = path.resolve(__dirname, '../../docs/design/03-wrap-emboss/validation');

/** The `value` of a case of expected_results.json. */
export function expected(vc: string): unknown {
  const all = JSON.parse(readFileSync(path.join(pack, 'expected_results.json'), 'utf8')) as {
    cases: Array<{ vc: string; value: unknown }>;
  };
  const found = all.cases.find((entry) => entry.vc === vc);
  if (found === undefined) throw new Error(`no case ${vc}`);
  return found.value;
}

/** A data/<name>.json dataset of the pack. */
export function dataset<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(pack, 'data', `${name}.json`), 'utf8')) as T;
}
