import { useEffect, useState } from 'react'

// 서버가 내려준 timerEndsAt(ms) 기준 남은 시간 표시
export default function Timer({ endsAt }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!endsAt) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [endsAt])
  if (!endsAt) return null
  const left = Math.max(0, Math.ceil((endsAt - now) / 1000))
  return <span className="timer">⏳ {left}s</span>
}
