import { useState } from 'react'
import { socket } from '../socket'

export default function Liar({ state }) {
  const g = state.game
  const [guess, setGuess] = useState('')
  const isHost = state.hostId === state.myId
  const others = state.players.filter((p) => p.id !== state.myId)
  const vote = (targetId) => socket.emit('action', { kind: 'vote', targetId })
  const submitGuess = () => guess.trim() && socket.emit('action', { kind: 'liarGuess', word: guess })

  return (
    <>
      <div className={`role ${g.role === 'liar' ? 'role-mafia' : ''}`}>
        주제: <b>[{g.category}]</b>
        {g.role === 'liar' ? (
          <div>당신은 <b>🤥 라이어</b>입니다. 제시어를 모른 채 들키지 마세요!</div>
        ) : (
          <div>제시어: <b>{g.word}</b> (라이어를 찾으세요)</div>
        )}
      </div>

      {state.phase === 'describe' && (
        <div className="card">
          <h3>🗣️ 토론</h3>
          <p className="muted">채팅으로 제시어를 (라이어는 아는 척) 설명하세요. 시간이 끝나면 투표로 넘어갑니다.</p>
          {isHost && (
            <button onClick={() => socket.emit('action', { kind: 'next' })}>투표 시작</button>
          )}
        </div>
      )}

      {state.phase === 'vote' && (
        <div className="card">
          <h3>🗳️ 라이어 지목</h3>
          <div className="targets">
            {others.map((p) => (
              <button key={p.id} onClick={() => vote(p.id)}>{p.name}</button>
            ))}
          </div>
        </div>
      )}

      {state.phase === 'liarGuess' && (
        <div className="card">
          {g.role === 'liar' ? (
            <>
              <h3>😈 역전 기회! 제시어를 맞혀보세요</h3>
              <input value={guess} onChange={(e) => setGuess(e.target.value)} placeholder="제시어 입력" />
              <button onClick={submitGuess}>제출</button>
            </>
          ) : (
            <p className="muted">라이어가 지목되었습니다. 라이어가 제시어를 추리 중…</p>
          )}
        </div>
      )}

      {state.phase === 'ended' && (
        <div className={`card winner ${g.winner === 'liar' ? 'mafia' : 'citizen'}`}>
          <h2>{g.winner === 'liar' ? '🤥 라이어 승리' : '🧑 시민 승리'}</h2>
          <p>제시어: <b>{g.word}</b> / 라이어: <b>{g.liarName}</b></p>
        </div>
      )}

      <div className="card log">
        <h3>진행 상황</h3>
        {(g.log || []).map((l, i) => <div key={i} className="logline">{l}</div>)}
      </div>
    </>
  )
}
