import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dopl.doil.me 루트에서 서빙. prod에선 nginx가 /auth·/profile·/socket.io를 dopl 서버로 프록시.
// dev에선 vite가 localhost:3100(dopl 서버)로 프록시.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://localhost:3100',
      '/profile': 'http://localhost:3100',
      '/socket.io': { target: 'http://localhost:3100', ws: true },
    },
  },
});
