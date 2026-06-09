import { socket } from '../socket'

export default function Quiz({ state }) {
  const g = state.game
  const answer = (value) => socket.emit('action', { kind: 'answer', value })

  return (
    <>
      <div className="role">
        라운드 {g.round}/{g.total} · 내 IQ <b>{g.myIq ?? '-'}</b>
        {g.myIqDelta ? <span> ({g.myIqDelta > 0 ? '+' : ''}{g.myIqDelta})</span> : null}
        {!g.myAlive && <span className="dead"> · 탈락(관전)</span>}
      </div>

      {state.phase === 'playing' && g.stage === 'answer' && g.question && (
        <div className="card">
          {g.question.category && <p className="muted">[{g.question.category}]</p>}
          <h3 className="qtext">{g.question.text}</h3>
          {g.myAlive ? (
            g.myAnswer == null ? (
              <div className="oxbtns">
                <button className="ox-o" onClick={() => answer(true)}>⭕</button>
                <button className="ox-x" onClick={() => answer(false)}>❌</button>
              </div>
            ) : (
              <p className="muted">응답: {g.myAnswer ? '⭕ O' : '❌ X'} — 다른 참가자 대기…</p>
            )
          ) : (
            <p className="muted">탈락하여 관전 중…</p>
          )}
        </div>
      )}

      {state.phase === 'playing' && g.stage === 'reveal' && g.reveal && (
        <div className="card">
          <h3>정답: {g.reveal.answer ? '⭕ O' : '❌ X'}</h3>
          {g.reveal.wipe ? (
            <p>전원 오답! 아무도 탈락하지 않았습니다.</p>
          ) : (
            <p className="dead">탈락: {g.reveal.eliminatedNames.join(', ') || '없음'}</p>
          )}
        </div>
      )}

      {state.phase === 'ended' && (
        <div className="card winner citizen">
          <h2>🏆 생존: {(g.winnerNames || []).join(', ') || '없음'}</h2>
          <ul className="players">
            {[...state.players]
              .sort((a, b) => (b.iq || 0) - (a.iq || 0))
              .map((p) => (
                <li key={p.id}>
                  {p.name} — IQ {p.iq ?? '-'} {p.alive === false && '†'}
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="card log">
        <h3>진행 상황</h3>
        {(g.log || []).map((l, i) => <div key={i} className="logline">{l}</div>)}
      </div>
    </>
  )
}
