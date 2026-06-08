import { useState } from 'react'
import { socket } from '../socket'

const COLOR = { correct: '#22c55e', present: '#eab308', absent: '#6b7280' }

function Row({ guess }) {
  // guess.syllables: [[{jamo, slot, color}, ...], ...] 음절별
  return (
    <div className="wrow">
      {guess.syllables.map((syl, si) => (
        <div key={si} className="wsyl">
          {syl.map((c, ci) => (
            <span key={ci} className="wjamo" style={{ background: COLOR[c.color] }}>{c.jamo}</span>
          ))}
        </div>
      ))}
      <span className="wword">{guess.word}</span>
    </div>
  )
}

export default function Wordle({ state }) {
  const g = state.game
  const [text, setText] = useState('')
  const submit = (e) => {
    e.preventDefault()
    if (text.trim()) { socket.emit('action', { kind: 'guess', word: text }); setText('') }
  }

  return (
    <>
      <div className="card">
        <h3>🟩 {g.wordLen}글자 한글 워들 · {g.maxTries}회</h3>
        <div className="wboard">
          {(g.myBoard || []).map((guess, i) => <Row key={i} guess={guess} />)}
        </div>
        {state.phase === 'playing' && !g.myDone && (
          <form onSubmit={submit} className="chatform">
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={g.wordLen} placeholder={`${g.wordLen}글자`} />
            <button type="submit">제출</button>
          </form>
        )}
        {g.myDone && state.phase === 'playing' && <p className="muted">완료. 다른 플레이어 대기 중…</p>}
        <p className="muted" style={{ marginTop: '0.5rem' }}>
          🟩 위치 정확 · 🟨 다른 위치에 존재 · ⬜ 없음
        </p>
      </div>

      {/* 상대 진행 현황 */}
      <div className="card">
        <h3>진행 현황</h3>
        <ul className="players">
          {state.players.map((p) => (
            <li key={p.id}>
              {p.name} — {p.tries || 0}회 {p.solved ? '✅' : p.done ? '❌' : ''} {p.isWinner && '🏆'}
            </li>
          ))}
        </ul>
      </div>

      {state.phase === 'ended' && (
        <div className="card winner citizen">
          <h2>정답: {g.answer}</h2>
        </div>
      )}

      <div className="card log">
        <h3>진행 상황</h3>
        {(g.log || []).map((l, i) => <div key={i} className="logline">{l}</div>)}
      </div>
    </>
  )
}
