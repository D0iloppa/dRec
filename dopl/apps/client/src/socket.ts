import { io, type Socket } from 'socket.io-client';

// /games 네임스페이스에 JWT로 연결 (path는 서버와 동일 /socket.io)
export function connectGame(token: string): Socket {
  return io('/games', {
    path: '/socket.io',
    auth: { token },
    transports: ['websocket', 'polling'],
  });
}
