import { io } from 'socket.io-client'

// 안정적 playerId — 새로고침/재접속 시에도 자리 복구에 사용
function getPlayerId() {
  let id = localStorage.getItem('doil-pid')
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random())
    localStorage.setItem('doil-pid', id)
  }
  return id
}

export const playerId = getPlayerId()

// 같은 오리진의 /games 네임스페이스. 서버 Socket.IO path는 /sb/socket.io.
export const socket = io('/games', {
  path: '/sb/socket.io',
  autoConnect: true,
  transports: ['websocket', 'polling'],
})

// 방 코드 보관(재접속용)
export const saveRoom = (code) => localStorage.setItem('doil-room', code || '')
export const lastRoom = () => localStorage.getItem('doil-room') || ''
export const clearRoom = () => localStorage.removeItem('doil-room')
