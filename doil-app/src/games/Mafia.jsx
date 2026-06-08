import { socket } from '../socket'

const ROLE = { mafia: '🔪 마피아', doctor: '💉 의사', police: '🔍 경찰', citizen: '🧑 시민' }

export default function Mafia({ state }) {
  const g = state.game
  const me = state.players.find((p) => p.id === state.myId)
  const alive = me?.alive !== false
  const others = state.players.filter((p) => p.id !== state.myId && p.alive !== false)
  const act = (kind, targetId) => socket.emit('action', { kind, targetId })

  return (
    <>
      {g.myRole && (
        <div className={`role role-${g.myRole}`}>
          내 역할: <b>{ROLE[g.myRole]}</b>
          {!alive && <span className="dead"> · 사망</span>}
        </div>
      )}

      {state.phase === 'night' && alive && (
        <div className="card">
          {['mafia', 'doctor', 'police'].includes(g.myRole) ? (
            <>
              <h3>
                {g.myRole === 'mafia' && '🌙 제거할 대상 선택'}
                {g.myRole === 'doctor' && '🌙 살릴 대상 선택'}
                {g.myRole === 'police' && '🌙 조사할 대상 선택'}
              </h3>
              <div className="targets">
                {others.map((p) => (
                  <button key={p.id} onClick={() => act('night', p.id)}>
                    {p.name}{g.myRole === 'mafia' && p.role === 'mafia' ? ' (동료)' : ''}
                  </button>
                ))}
              </div>
              {g.policeResult && (
                <p className="result">
                  🔍 {g.policeResult.name} 님은 {g.policeResult.isMafia ? '마피아입니다!' : '마피아가 아닙니다.'}
                </p>
              )}
            </>
          ) : (
            <p className="muted">밤입니다. 특수 역할이 행동 중…</p>
          )}
        </div>
      )}

      {state.phase === 'day' && alive && (
        <div className="card">
          <h3>☀️ 처형할 사람에게 투표</h3>
          <div className="targets">
            {others.map((p) => (
              <button key={p.id} onClick={() => act('vote', p.id)}>{p.name}</button>
            ))}
          </div>
        </div>
      )}

      {state.phase === 'ended' && (
        <div className={`card winner ${g.winner}`}>
          <h2>{g.winner === 'mafia' ? '🔪 마피아 승리' : '🧑 시민 승리'}</h2>
          <ul className="players">
            {state.players.map((p) => (
              <li key={p.id}>{p.name} — {ROLE[p.role]} {p.alive === false && '💀'}</li>
            ))}
          </ul>
        </div>
      )}

      <Log log={g.log} />
    </>
  )
}

function Log({ log = [] }) {
  return (
    <div className="card log">
      <h3>진행 상황</h3>
      {log.map((l, i) => <div key={i} className="logline">{l}</div>)}
    </div>
  )
}
