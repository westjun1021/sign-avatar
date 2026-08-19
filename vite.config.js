import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

// [임시 · 검증용] 브라우저 콘솔을 파일로 받아내는 dev 전용 싱크.
// devAutoload.js 가 POST 로 보내는 줄을 그대로 append 한다. 검증 끝나면 이 플러그인,
// devAutoload.js, App.jsx 의 훅 호출, public/fmc/ 를 통째로 지우면 원상복구된다.
const DEVLOG = 'C:/Users/tjwns/AppData/Local/Temp/claude/C--dev-sign-avatar/4f70a52d-eb82-4eb5-9905-802007762210/scratchpad/devlog.txt';

function devLogSink() {
  return {
    name: 'dev-log-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__devlog', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (body === '__RESET__') fs.writeFileSync(DEVLOG, '');
          else fs.appendFileSync(DEVLOG, body + '\n');
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devLogSink()],
  server: {
    host: true,
    // 카메라(getUserMedia)는 https 또는 localhost에서만 동작합니다.
    // 로컬 개발은 localhost라 문제 없고, 다른 기기에서 테스트하려면 https가 필요해요.
  },
});
