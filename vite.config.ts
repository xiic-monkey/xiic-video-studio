import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'es2021', sourcemap: true },
  test: {
    // 默认仍是 node 环境（domain/store 测试不需要 DOM）；
    // 需要渲染组件的测试文件用文件头 `// @vitest-environment jsdom` 单独声明。
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
