import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // 카메라(getUserMedia)는 https 또는 localhost에서만 동작합니다.
    // 로컬 개발은 localhost라 문제 없고, 다른 기기에서 테스트하려면 https가 필요해요.
  },
});
