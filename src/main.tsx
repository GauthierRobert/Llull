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
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { useKernelStatusStore } from '@ui/store/kernelStatus';
import { installBrowserLibraries } from '@ui/services/browserLibraries';

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

installDefaultPlugins();
installBrowserLibraries();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found.');

createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
