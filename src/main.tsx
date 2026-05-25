import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@ui/App';
import '@ui/styles.css';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@ui/geometry/manifoldKernel';

// Inject the Manifold geometry kernel asynchronously so WASM init does not
// block the first render. Boolean commands no-op gracefully until the kernel
// resolves (architecture L9 / SOLID S5).
createManifoldKernel()
  .then(setGeometryKernel)
  .catch((e: unknown) => console.error('Manifold kernel init failed', e));

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found.');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
