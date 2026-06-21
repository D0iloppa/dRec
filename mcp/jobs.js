'use strict';

// 긴 dRec 작업(전사+화자분리+회의록, 수 분)을 dobis 워커 턴 밖에서 돌리기 위한 인메모리 잡 러너.
// process_audio / finish_session 은 즉시 job_id 를 반환하고, 실제 처리는 백그라운드에서 진행한다.
// → 워커가 한 MCP 호출에 수 분간 묶이지 않아 워치독(무응답 종료)·세션 만료 문제를 피한다.
// job 은 이 MCP 프로세스(=현재 claude 세션) 메모리에만 존재하며 drec_job_status 로 폴링한다.

const jobs = new Map(); // job_id → { id, label, status, result, error }
let _seq = 0;

// label: 잡 종류(process_audio 등), fn: 실제 작업을 수행하는 async 함수
function startJob(label, fn) {
  const id = `${label}-${++_seq}`;
  const rec = { id, label, status: 'running', result: null, error: null };
  jobs.set(id, rec);
  Promise.resolve()
    .then(fn)
    .then((result) => { rec.status = 'done'; rec.result = result; })
    .catch((err) => { rec.status = 'error'; rec.error = err.message || String(err); });
  return id;
}

function getJob(id) {
  const rec = jobs.get(id);
  if (!rec) return { id, status: 'unknown', error: 'no such job' };
  return { id: rec.id, status: rec.status, result: rec.result, error: rec.error };
}

module.exports = { startJob, getJob };
