import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@ui/App';
import { AppErrorBoundary } from '@ui/components/AppErrorBoundary';
import '@fontsource/geist-sans/latin-300.css';
import '@fontsource/geist-sans/latin-400.css';
import '@fontsource/geist-sans/latin-500.css';
import '@fontsource/geist-sans/latin-600.css';
import '@fontsource/geist-sans/latin-700.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-500.css';
import '@fontsource/geist-mono/latin-600.css';
import '@ui/styles/index.css';
import { installDefaultPlugins } from '@app/plugins';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { parseKernelChoice } from '@core/geometry/kernelChoice';

// Kernel selection: Manifold by default (fast, no large WASM asset); ?kernel=occt swaps in OCC
// (dev/power-user toggle, opt-in only). OCC carries a 63 MB WASM binary (~800–1000 ms cold init),
// so it is lazy-imported and injected asynchronously: the first render is never blocked and
// commands no-op gracefully until the kernel resolves (architecture L9 / SOLID S5).
const useOcct =
  typeof window !== 'undefined' &&
  parseKernelChoice(new URLSearchParams(window.location.search).get('kernel')) === 'occt';

function installManifoldKernel(): void {
  createManifoldKernel()
    .then(setGeometryKernel)
    .catch((e: unknown) => console.error('Manifold kernel init failed', e));
}

if (useOcct) {
  import('@ui/geometry/occtKernelBrowser')
    .then(({ createBrowserOcctKernel }) => createBrowserOcctKernel())
    .then(setGeometryKernel)
    .catch((e: unknown) => {
      console.warn('OCC kernel init failed — falling back to Manifold', e);
      installManifoldKernel();
    });
} else {
  installManifoldKernel();
}

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
