import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => ({
  // Demo production builds target GitHub Pages at /SiliconScope-AI/.
  // Dev server always uses '/' so Playwright and local dev are unaffected.
  base: command === 'build' && mode === 'demo' ? '/SiliconScope-AI/' : '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/dashboard': 'http://localhost:3000',
    },
  },
}))
