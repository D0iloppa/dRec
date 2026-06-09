// 인게임 렌더. ox-quiz는 Phaser 씬으로 렌더(브리지). 다른 게임은 추후 씬 추가.
import type { Socket } from 'socket.io-client';
import type { RoomState } from '@dopl/protocol';
import PhaserStage, { PHASER_TYPES } from './PhaserStage';

export default function GameStage({ socket, room }: { socket: Socket; room: RoomState }) {
  if (PHASER_TYPES.includes(room.type)) {
    const g = room.game as any;
    return (
      <>
        <PhaserStage socket={socket} room={room} />
        <div className="card log">
          <h3>진행</h3>
          {(g.log || []).map((l: string, i: number) => (
            <div key={i} className="logline">{l}</div>
          ))}
        </div>
      </>
    );
  }
  return <div className="card muted">이 게임의 화면은 아직 준비 중입니다. (type: {room.type})</div>;
}
