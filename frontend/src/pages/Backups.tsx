// 녹음 백업 관리 — 이 기기(IndexedDB)에 남은 모든 녹음 백업을 한곳에서 확인·정리한다.
// 안전 원칙: 자동 삭제 없음. 일괄 승인은 '검토 대기 + 서버 길이 일치'인 항목만, 그 외 삭제는 항상 확인을 거친다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { HardDrive, Play, Download, Upload, CheckCircle2, Trash2, AlertTriangle, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import {
  estimateStorage, isPendingReview, listLocal, loadFull, localRec, LocalSummary, probeDuration, purgeLocal, saveBlobs,
  StorageEstimateInfo, useLocalRec,
} from '../localRec';
import { useUploader } from '../uploader';
import { dialog } from '../ui/dialog';
import { fmtBytes } from '../components/format';
import {
  approveAndPurge, BackupCompare, purgeIncomplete, REUPLOAD_CONFIRM, StateBadge, verdict, VerdictBadge, Verdict,
} from '../components/backupCommon';

interface Server { title: string; durationSec: number | null; hasAudio: boolean }

const serverIdOf = (m: LocalSummary) => m.serverId ?? m.id;

export default function Backups() {
  const version = useLocalRec((s) => s.version);
  const uploads = useUploader((u) => u.byId);
  const [items, setItems] = useState<LocalSummary[] | null>(null);
  const [est, setEst] = useState<StorageEstimateInfo | null>(null);
  const [servers, setServers] = useState<Record<number, Server | null>>({}); // null = 서버에 회의 없음
  const [localSecs, setLocalSecs] = useState<Record<number, number | null>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [playing, setPlaying] = useState<{ id: number; urls: string[]; idx: number } | null>(null);
  const cache = useRef(new Map<number, Blob[]>());

  useEffect(() => {
    let alive = true;
    listLocal()
      .then((l) => { if (alive) setItems(l.filter((m) => m.id !== localRec.activeId && (m.fullParts > 0 || m.slices > 0))); })
      .catch(() => { if (alive) setItems([]); });
    estimateStorage().then((e) => { if (alive) setEst(e); });
    return () => { alive = false; };
  }, [version]);

  // 서버 정보(제목·길이) + 기기 백업 실제 길이를 항목마다 순서대로 채운다(무거운 측정이라 한 번에 하나씩).
  useEffect(() => {
    if (!items) return;
    let alive = true;
    (async () => {
      for (const m of items) {
        if (!alive) return;
        if (!(serverIdOf(m) in servers)) {
          const s = await api.getMeeting(serverIdOf(m))
            .then((d) => ({ title: d.title, durationSec: d.audio_duration_sec ?? null, hasAudio: !!d.has_audio }))
            .catch(() => null);
          if (!alive) return;
          setServers((p) => ({ ...p, [serverIdOf(m)]: s }));
        }
        if (!(m.id in localSecs) && m.fullParts > 0) {
          let sec: number | null = null;
          try {
            const bs = await loadFull(m.id);
            cache.current.set(m.id, bs);
            const ds = await Promise.all(bs.map((b) => probeDuration(b)));
            if (ds.length && ds.every((d) => d != null)) sec = ds.reduce<number>((s, d) => s + (d ?? 0), 0);
          } catch { /* 측정 실패 — 기록된 녹음 시간으로 대체 */ }
          if (!alive) return;
          setLocalSecs((p) => ({ ...p, [m.id]: sec }));
        }
      }
    })();
    return () => { alive = false; };
    // servers/localSecs 는 캐시 — 변경으로 다시 돌 필요 없음
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useEffect(() => () => { playing?.urls.forEach((u) => URL.revokeObjectURL(u)); }, [playing]);

  const info = useCallback((m: LocalSummary) => {
    const srv = servers[serverIdOf(m)];
    const loaded = serverIdOf(m) in servers;
    const approx = localSecs[m.id] == null && m.recordedMs ? m.recordedMs / 1000 : null;
    const localDur = localSecs[m.id] ?? approx;
    const up = uploads[serverIdOf(m)];
    const busy = up?.phase === 'uploading' || up?.phase === 'converting';
    const v: Verdict = !loaded ? { kind: 'unknown', warn: '' }
      : srv === null ? { kind: 'missing', warn: '서버에 이 회의가 없습니다. 백업을 지우면 음성을 되살릴 수 없습니다.' }
      : verdict(localDur, srv.hasAudio ? srv.durationSec : null, srv.hasAudio, busy);
    return { srv, approx, localDur, busy, v, measuring: m.id in localSecs === false };
  }, [servers, localSecs, uploads]);

  async function blobsOf(m: LocalSummary): Promise<Blob[]> {
    let bs = cache.current.get(m.id);
    if (!bs) { bs = await loadFull(m.id); cache.current.set(m.id, bs); }
    return bs;
  }

  async function play(m: LocalSummary) {
    if (playing?.id === m.id) { setPlaying(null); return; }
    const bs = await blobsOf(m);
    setPlaying({ id: m.id, urls: bs.map((b) => URL.createObjectURL(b)), idx: 0 });
  }

  async function save(m: LocalSummary) {
    const bs = await blobsOf(m);
    if (!bs.length) return;
    const r = await saveBlobs(serverIdOf(m), bs);
    if (r === 'gesture') toast('저장 준비가 됐습니다. "파일로 저장"을 한 번 더 눌러 주세요');
  }

  async function reupload(m: LocalSummary) {
    if (!(await dialog.confirm(REUPLOAD_CONFIRM.title, REUPLOAD_CONFIRM.text, REUPLOAD_CONFIRM.ok))) return;
    const bs = await blobsOf(m);
    if (bs.length) useUploader.getState().start(serverIdOf(m), bs, { localId: m.id });
  }

  const toggle = (id: number) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const list = items ?? [];
  const sel = list.filter((m) => selected.has(m.id));
  const safe = sel.filter((m) => isPendingReview(m) && info(m).v.kind === 'match'); // 일괄 승인 가능: 검토 대기 + 길이 일치
  const allSelected = list.length > 0 && sel.length === list.length;

  async function bulkApprove() {
    if (!safe.length) return;
    const skipped = sel.length - safe.length;
    const ok = await dialog.confirm(
      `${safe.length}건을 승인하고 삭제할까요?`,
      `서버 음성 길이가 기기 백업과 일치하는 검토 대기 항목만 삭제합니다.${skipped ? ` 나머지 ${skipped}건은 건드리지 않습니다.` : ''} 삭제 후에는 되돌릴 수 없습니다.`,
      '승인하고 삭제',
    );
    if (!ok) return;
    for (const m of safe) await purgeLocal(m.id);
    setSelected(new Set());
    toast.success(`${safe.length}건의 기기 백업을 삭제했습니다`);
  }

  async function bulkDelete() {
    if (!sel.length) return;
    const risky = sel.filter((m) => !isPendingReview(m) || info(m).v.kind !== 'match').length;
    const ok = await dialog.confirmGuarded(
      `선택한 ${sel.length}건을 삭제할까요?`,
      risky
        ? `업로드 미완료이거나 서버 길이가 확인·일치되지 않은 백업이 ${risky}건 포함되어 있습니다. 삭제하면 해당 음성 원본을 되살릴 수 없습니다.`
        : '삭제 후에는 되돌릴 수 없습니다.',
      '삭제',
    );
    if (!ok) return;
    for (const m of sel) await purgeLocal(m.id);
    setSelected(new Set());
    toast.success(`${sel.length}건을 삭제했습니다`);
  }

  const total = list.reduce((s, m) => s + m.fullBytes, 0);
  const review = list.filter(isPendingReview).length;
  const pct = est && est.quota ? Math.min(100, (est.usage / est.quota) * 100) : null;

  return (
    <div className="page">
      <h1 className="bk-page-title"><HardDrive size={22} /> 음성 백업</h1>
      <p className="bk-lead">이 기기에 남아 있는 음성 원본입니다. 서버 결과를 확인하고 승인하기 전까지 자동으로 지워지지 않습니다.</p>

      <section className="bk-usage">
        <div className="bk-usage-row">
          <span><b>{list.length}</b>건 · {fmtBytes(total)}</span>
          {review > 0 && <span className="bk-badge review">{review}건 검토 대기</span>}
          {list.length - review > 0 && <span className="bk-badge incomplete">{list.length - review}건 업로드 미완료</span>}
        </div>
        {est && (
          <>
            <div className={`bk-meter${est.low ? ' low' : ''}`}><div style={{ width: `${pct ?? 0}%` }} /></div>
            <div className="bk-sub">앱 저장 공간 {fmtBytes(est.usage)} / {fmtBytes(est.quota)} 사용{est.low ? ' · 공간이 부족합니다. 검토가 끝난 백업을 정리하세요' : ''}</div>
          </>
        )}
      </section>

      {items === null && <div className="bk-empty">불러오는 중…</div>}
      {items !== null && list.length === 0 && (
        <div className="bk-empty">
          <HardDrive size={28} />
          <div>기기에 남은 음성 백업이 없습니다</div>
          <div className="bk-sub">기록을 마치면 업로드 후 이곳에 검토 대기로 보관됩니다.</div>
        </div>
      )}

      {list.length > 0 && (
        <div className="bk-toolbar">
          <label className="bk-check">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((m) => m.id)))} />
            {sel.length ? `${sel.length}건 선택` : '전체 선택'}
          </label>
          <div className="bk-toolbar-actions">
            <button className="bk-btn ok" onClick={bulkApprove} disabled={!safe.length} title="검토 대기이면서 서버 길이가 일치하는 항목만">
              <CheckCircle2 size={14} /> 선택 승인·삭제{safe.length ? ` (${safe.length})` : ''}
            </button>
            <button className="bk-btn danger" onClick={bulkDelete} disabled={!sel.length}><Trash2 size={14} /> 선택 삭제</button>
          </div>
        </div>
      )}

      <div className="bk-list">
        {list.map((m) => {
          const { srv, approx, localDur, busy, v, measuring } = info(m);
          const pending = isPendingReview(m);
          const sid = serverIdOf(m);
          return (
            <article key={m.id} className={`bk-card row${v.warn ? ' warn' : ''}${selected.has(m.id) ? ' sel' : ''}`}>
              <header className="bk-head">
                <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} aria-label="선택" />
                <div className="bk-title-wrap">
                  <Link className="bk-title" to={`/m/${sid}`}>{srv?.title || m.title || `회의 #${m.id}`} <ExternalLink size={12} /></Link>
                  <div className="bk-sub">{new Date(m.createdAt).toLocaleString('ko-KR')}{m.slices > 0 ? ` · 미전송 조각 ${m.slices}개` : ''}</div>
                </div>
                <div className="bk-badges"><StateBadge meta={m} />{pending && <VerdictBadge kind={v.kind} />}</div>
              </header>
              <BackupCompare
                meta={m} localDur={localDur} approx={approx != null && localSecsNull(localDur, approx)} measuring={measuring}
                serverDur={srv?.hasAudio ? srv.durationSec : null} serverHasAudio={!!srv?.hasAudio} kind={v.kind}
              />
              {v.warn && <div className="bk-warn"><AlertTriangle size={14} /> <span>{v.warn}</span></div>}
              {playing?.id === m.id && (
                <div className="bk-player">
                  {playing.urls.length > 1 && (
                    <div className="bk-gens">
                      {playing.urls.map((_, i) => (
                        <button key={i} className={i === playing.idx ? 'on' : ''} onClick={() => setPlaying({ ...playing, idx: i })}>구간 {i + 1}</button>
                      ))}
                    </div>
                  )}
                  <audio key={playing.urls[playing.idx]} src={playing.urls[playing.idx]} controls autoPlay playsInline />
                </div>
              )}
              <div className="bk-actions">
                <button onClick={() => void play(m)}><Play size={14} /> {playing?.id === m.id ? '재생 닫기' : '재생'}</button>
                <button onClick={() => void save(m)}><Download size={14} /> 파일로 저장</button>
                <button onClick={() => void reupload(m)} disabled={busy}><Upload size={14} /> {busy ? '업로드 중…' : '다시 업로드'}</button>
                {pending ? (
                  <button className="bk-btn ok" onClick={() => void approveAndPurge(m, v.warn)} disabled={busy}>
                    <CheckCircle2 size={14} /> 승인 → 삭제
                  </button>
                ) : (
                  <button className="bk-btn danger" onClick={() => void purgeIncomplete(m)} disabled={busy}><Trash2 size={14} /> 삭제</button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

// 실측 길이가 없고 기록 시간(approx)으로 대체했을 때만 '≈' 표시
function localSecsNull(localDur: number | null, approx: number | null): boolean {
  return localDur !== null && localDur === approx;
}
