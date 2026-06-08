import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 이 앱은 https://www.doil.me/sb/app 아래에서 서빙된다.
// base를 맞춰야 빌드된 에셋(js/css) 경로가 /sb/app/ 기준으로 생성된다.
// https://vite.dev/config/
export default defineConfig({
  base: '/sb/app/',
  plugins: [react()],
  // 로컬 개발(vite dev) 시 소켓을 doil-sb(3000)로 프록시한다.
  // doil-sb를 호스트 3000 포트로 접근 가능하게 띄운 상태여야 한다.
  server: {
    proxy: {
      '/sb/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
