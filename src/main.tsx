import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@ui/App';
import { AppErrorBoundary } from '@ui/components/AppErrorBoundary';
import '@fontsource/hanken-grotesk/latin-400.css';
import '@fontsource/hanken-grotesk/latin-500.css';
import '@fontsource/hanken-grotesk/latin-600.css';
import '@fontsource/hanken-grotesk/latin-700.css';
import '@fontsource/dm-mono/latin-400.css';
import '@fontsource/dm-mono/latin-500.css';
import '@ui/styles/index.css';
import { installDefaultPlugins } from '@app/plugins';
import { setGeometryKernel } from '@core/geometry/kernel';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createManifoldMeshEngine } from '@kernel-manifold/manifoldMeshEngine';
import { useKernelStatusStore } from '@ui/store/kernelStatus';

// Renderer kernel: Manifold (WASM, in-process) runs the commands this renderer executes itself (local mode while
// the backend restarts, read-only queries, panel analyses). Exact B-rep work runs in the local backend (LLULL_KERNEL).
// Injected asynchronously: first render never blocks; commands no-op until it resolves (L9). Retired in LC1 step 5.
createManifoldKernel()
  .then((kernel) => {
    setGeometryKernel(kernel);
    useKernelStatusStore.getState().setStatus('ready');
  })
  .catch((e: unknown) => {
    console.error('Manifold kernel init failed', e);
    useKernelStatusStore.getState().setStatus('failed');
  });

// Mesh modelling (07 MSH): the same WASM serves the mesh-engine port (hull, Minkowski, offset, wrap, mesh booleans); without it those ops refuse cleanly.
createManifoldMeshEngine()
  .then(setMeshProcessingEngine)
  .catch((e: unknown) => console.error('Manifold mesh engine init failed', e));

installDefaultPlugins();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found.');

createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
