import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'es2021', sourcemap: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'], restoreMocks: true },
});
