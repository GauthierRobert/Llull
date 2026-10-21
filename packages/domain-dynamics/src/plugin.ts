/** Rigid-body dynamics plugin: commands join the `assembly` toolset; the physics engine itself is the injected `PhysicsEngine` port of core. */

import type { CadPlugin } from '@core/plugins/plugin';
import { dynamicsCommands } from './commands/catalog';

export const dynamicsPlugin: CadPlugin = { name: 'dynamics', toolset: 'assembly', commands: dynamicsCommands };
