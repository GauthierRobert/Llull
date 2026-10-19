import '@testing-library/jest-dom/vitest';
import { installDefaultPlugins } from '@app/plugins';
import { setGeometryKernel } from '@core/geometry/kernel';
import { setGeometryQueryEngine } from '@core/geometry/geometryQueries';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { setMaterialLibraryProvider } from '@core/commands/libraryPort';

installDefaultPlugins();
// The `node` project shares modules across files: start every file from the same process defaults as a fresh import.
setGeometryKernel(null);
setPhysicsEngine(null);
setGeometryQueryEngine(null);
setMaterialLibraryProvider(null);
