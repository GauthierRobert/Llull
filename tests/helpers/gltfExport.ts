import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';

/** `export_gltf` on `doc`, its JSON text parsed as the caller's glTF shape `T`. */
export function parsedGltf<T>(doc: CadDocument, params: Record<string, unknown> = {}): T {
  return JSON.parse((execute(doc, 'export_gltf', params).data as { text: string }).text) as T;
}
