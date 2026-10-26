/** The hostile-input table: every reader of untrusted text or bytes, grouped by family (`tests/helpers/hostile/*`). */
import type { HostileReader } from './hostile/types';
import { AEC_READERS } from './hostile/aecReaders';
import { AERO_READERS } from './hostile/aeroReaders';
import { CAE_READERS } from './hostile/caeReaders';
import { CORE_READERS } from './hostile/coreReaders';
import { EXCHANGE_READERS } from './hostile/exchangeReaders';
import { MESH_READERS } from './hostile/meshReaders';
import { XML_READERS } from './hostile/xmlReaders';

export type { HostileReader } from './hostile/types';

export const HOSTILE_READERS: readonly HostileReader[] = [
  ...XML_READERS,
  ...MESH_READERS,
  ...EXCHANGE_READERS,
  ...CAE_READERS,
  ...AERO_READERS,
  ...AEC_READERS,
  ...CORE_READERS,
];
