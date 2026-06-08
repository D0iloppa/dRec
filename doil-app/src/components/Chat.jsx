import { useState } from 'react'
import { socket } from '../socket'

export default function Chat({ chat }) {
  const [text, setText] = useState('')
  const send = (e) => {
    e.preventDefault()
    if (!text.trim()) return
    socket.emit('chat', { text })
    setText('')
  }
  return (
    <div className="card chat">
      <h3>채팅</h3>
      <div className="chatlog">
        {chat.map((c, i) => (
          <div key={i} className="chatline">
            <b>{c.name}</b> {c.text}
          </div>
        ))}
        {chat.length === 0 && <div className="muted">아직 메시지가 없습니다.</div>}
      </div>
      <form onSubmit={send} className="chatform">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="메시지…" />
        <button type="submit">전송</button>
      </form>
    </div>
  )
}
