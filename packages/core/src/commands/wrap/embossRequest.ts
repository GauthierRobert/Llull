import type { CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import type { FaceRefInput, FaceSession, PlacementInput, ResolvedChart } from './faceSession';

export interface EmbossGrid {
  readonly countX: number;
  readonly countY: number;
  readonly pitchX: number;
  readonly pitchY: number;
}

export interface EmbossRequest {
  readonly id: string;
  readonly face: FaceRefInput;
  readonly profileIds: readonly string[];
  readonly mode: 'emboss' | 'deboss' | 'scribe' | 'engrave';
  readonly depth?: number | undefined;
  readonly placement?: PlacementInput | undefined;
  readonly maxLengthStrain?: number | undefined;
  readonly fitTolerance?: number | undefined;
  readonly toolWidth?: number | undefined;
  readonly grid?: EmbossGrid | undefined;
  /** `pull`: walls parallel to `pullDirection` (the mould-friendly form), optionally tilted by `draftDeg`; default `normal` (walls normal to the face). */
  readonly walls?: 'normal' | 'pull' | undefined;
  readonly pullDirection?: Vec3 | undefined;
  readonly draftDeg?: number | undefined;
  /** More faces of the chain the sketch runs over (adjacent plane / cylinder faces, unfolded across their shared edges). */
  readonly chain?: readonly FaceRefInput[] | undefined;
}

export type EmbossFail = (code: string, message: string, paths: string[], ids?: readonly string[]) => CommandResult;

export interface EmbossCall {
  readonly doc: CadDocument;
  readonly command: string;
  readonly params: EmbossRequest;
  readonly session: FaceSession;
  readonly resolved: ResolvedChart;
  readonly fail: EmbossFail;
  readonly engrave: boolean;
  readonly scribe: boolean;
  readonly pulled: boolean;
  readonly cutting: boolean;
  readonly depth: number;
  readonly tolerance: number;
}
