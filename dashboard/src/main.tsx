import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const root = createRoot(document.getElementById('root')!);

// At build time, Vite replaces import.meta.env.VITE_DEMO_MODE with a literal.
// When VITE_DEMO_MODE !== 'true', Rollup's dead-code elimination removes the
// entire demo import chain from the production bundle.
async function bootstrap() {
  if (import.meta.env.VITE_DEMO_MODE === 'true') {
    const { default: DemoApp } = await import('./demo/DemoApp');
    root.render(
      <StrictMode>
        <DemoApp />
      </StrictMode>,
    );
  } else {
    const { default: App } = await import('./App');
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}

bootstrap();
