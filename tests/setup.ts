import '@testing-library/jest-dom/vitest';
import { installDefaultPlugins } from '@app/plugins';
import { setGeometryKernel } from '@core/geometry/kernel';
import { setGeometryQueryEngine } from '@core/geometry/geometryQueries';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { setMaterialLibraryProvider } from '@core/commands/libraryPort';
import { setFontProvider } from '@core/commands/fontPort';

installDefaultPlugins();
// The `node` project shares modules across files: start every file from the same process defaults as a fresh import.
setGeometryKernel(null);
setPhysicsEngine(null);
setGeometryQueryEngine(null);
setMeshProcessingEngine(null);
setMaterialLibraryProvider(null);
setFontProvider(null);
