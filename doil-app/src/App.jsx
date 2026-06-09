import { useEffect, useState } from 'react'
import { socket, playerId, saveRoom, lastRoom, clearRoom } from './socket'
import Timer from './components/Timer'
import Chat from './components/Chat'
import Mafia from './games/Mafia'
import Liar from './games/Liar'
import Wordle from './games/Wordle'
import Quiz from './games/Quiz'
import './App.css'

const VIEWS = { mafia: Mafia, liar: Liar, wordle: Wordle, quiz: Quiz }
const PHASE_LABEL = {
  lobby: '대기실', night: '🌙 밤', day: '☀️ 낮',
  describe: '🗣️ 토론', vote: '🗳️ 투표', liarGuess: '😈 추리', playing: '진행 중', ended: '종료',
}

export default function App() {
  const [games, setGames] = useState([])
  const [type, setType] = useState('mafia')
  const [name, setName] = useState(localStorage.getItem('doil-name') || '')
  const [joinCode, setJoinCode] = useState('')
  const [state, setState] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    socket.on('games', setGames)
    socket.on('state', (s) => { setState(s); saveRoom(s.code) })
    socket.on('errorMsg', (m) => { setError(m); setTimeout(() => setError(''), 3000) })

    // 재접속 복구
    const tryRejoin = () => {
      const code = lastRoom()
      if (code) socket.emit('rejoin', { code, playerId }, (res) => { if (!res?.ok) clearRoom() })
    }
    socket.on('connect', tryRejoin)
    if (socket.connected) tryRejoin()

    return () => {
      socket.off('games'); socket.off('state'); socket.off('errorMsg'); socket.off('connect', tryRejoin)
    }
  }, [])

  const remember = () => localStorage.setItem('doil-name', name)
  const createRoom = () => {
    if (!name.trim()) return setError('닉네임을 입력하세요.')
    remember()
    socket.emit('createRoom', { type, name, playerId }, (res) => { if (!res?.ok) setError(res?.error) })
  }
  const joinRoom = () => {
    if (!name.trim()) return setError('닉네임을 입력하세요.')
    remember()
    socket.emit('joinRoom', { code: joinCode, name, playerId }, (res) => { if (!res?.ok) setError(res?.error) })
  }
  const leave = () => { clearRoom(); setState(null) }

  // ---------- 로비 ----------
  if (!state) {
    return (
      <main className="app">
        <h1>🎮 doil 게임</h1>
        <p className="muted">서버가 진행을 맡는 실시간 멀티 게임</p>
        {error && <div className="error">{error}</div>}

        <div className="card">
          <h3>게임 선택</h3>
          <div className="gamepick">
            {games.map((gm) => (
              <button
                key={gm.type}
                className={type === gm.type ? 'sel' : ''}
                onClick={() => setType(gm.type)}
              >
                {gm.label}
                <small>{gm.minPlayers}~{gm.maxPlayers}명</small>
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <input placeholder="닉네임" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={createRoom}>방 만들기</button>
        </div>
        <div className="card">
          <input
            placeholder="방 코드 (예: AB12)"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            maxLength={4}
          />
          <button onClick={joinRoom}>입장</button>
        </div>
      </main>
    )
  }

  // ---------- 방 / 게임 ----------
  const GameView = VIEWS[state.type]
  const isHost = state.hostId === state.myId
  const meta = games.find((gm) => gm.type === state.type)

  return (
    <main className="app">
      <header className="bar">
        <span>{meta?.label || state.type} · <b>{state.code}</b></span>
        <span>
          {PHASE_LABEL[state.phase] || state.phase}
          {' '}<Timer endsAt={state.timerEndsAt} />
        </span>
      </header>
      {error && <div className="error">{error}</div>}

      {/* 참가자 + 대기실 시작 */}
      {state.phase === 'lobby' && (
        <div className="card">
          <h3>참가자 ({state.players.length})</h3>
          <ul className="players">
            {state.players.map((p) => (
              <li key={p.id} className={p.connected ? '' : 'off'}>
                {p.name} {p.isHost && '👑'} {!p.connected && '(연결 끊김)'}
              </li>
            ))}
          </ul>
          {isHost ? (
            <button onClick={() => socket.emit('start')}>
              게임 시작 ({meta?.minPlayers}명 이상)
            </button>
          ) : (
            <p className="muted">호스트가 시작하기를 기다리는 중…</p>
          )}
          <button className="leave" onClick={leave}>나가기</button>
        </div>
      )}

      {/* 게임 진행 화면 */}
      {state.phase !== 'lobby' && GameView && <GameView state={state} />}

      {/* 참가자 목록(게임 중) */}
      {state.phase !== 'lobby' && (
        <div className="card">
          <h3>참가자</h3>
          <ul className="players">
            {state.players.map((p) => (
              <li key={p.id} className={p.connected ? '' : 'off'}>
                {p.name} {p.isHost && '👑'}
                {p.alive === false && ' 💀'}
                {!p.connected && ' (끊김)'}
              </li>
            ))}
          </ul>
          {state.phase === 'ended' && <button className="leave" onClick={leave}>로비로</button>}
        </div>
      )}

      <Chat chat={state.chat} />
    </main>
  )
}
