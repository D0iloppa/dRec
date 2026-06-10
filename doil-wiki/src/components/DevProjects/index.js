import React, { useState, useEffect } from 'react';

const DEV_API_BASE = 'https://www.doil.me/api/dev';

const PROJECTS = [
  {
    key: 'saigon_rider',
    name: 'SaigonRider',
    url: 'https://saigon.doil.me',
    summaryUrl: `${DEV_API_BASE}/summary/saigon_rider`,
    gitUrl: 'https://github.com/D0iloppa/saigon_rider',
    icon: '🏍️',
  },
  {
    key: 'oh_no',
    name: 'oh!NO',
    url: 'https://ohno.doil.me',
    summaryUrl: `${DEV_API_BASE}/summary/oh_no`,
    gitUrl: 'https://github.com/D0iloppa/oh-no',
    icon: '📓',
  },
];

function miniBar(done, wip, plan, total) {
  if (!total) return '··········';
  const d = Math.round((done / total) * 10);
  const w = Math.round((wip / total) * 10);
  const p = 10 - d - w;
  return (
    <span>
      <span style={{ color: '#34d399' }}>{'█'.repeat(Math.max(0, d))}</span>
      <span style={{ color: '#fbbf24' }}>{'▓'.repeat(Math.max(0, w))}</span>
      <span style={{ color: '#374151' }}>{'·'.repeat(Math.max(0, p))}</span>
    </span>
  );
}

function ProjectCard({ project }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetch(project.summaryUrl)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setData)
      .catch(() => setErr(true));
  }, [project.summaryUrl]);

  const rawCtx = data?.context || {};
  const ctx = {};
  for (const [k, v] of Object.entries(rawCtx)) {
    ctx[k] = typeof v === 'object' && v !== null ? v : { value: v, status: '⏸' };
  }
  const f = data?.features || {};
  const t = data?.todos || {};
  const fTotal = Object.values(f).reduce((a, b) => a + b, 0);
  const tTotal = Object.values(t).reduce((a, b) => a + b, 0);
  const fDone = f.DONE || 0;
  const tDone = t.DONE || 0;

  return (
    <div className="dev-project-card">
      <div className="dev-project-header">
        <span className="dev-project-icon">{project.icon}</span>
        <a href={project.url} className="dev-project-name" target="_blank" rel="noopener noreferrer">
          {project.name}
        </a>
        {project.gitUrl && (
          <a href={project.gitUrl} className="dev-git-link" target="_blank" rel="noopener noreferrer" title="GitHub">⎇</a>
        )}
        {err && <span className="dev-offline"> ✕ offline</span>}
        {!data && !err && <span className="dev-loading"> ···</span>}
      </div>

      {data && (
        <div className="dev-project-body">
          {(() => {
            const bv = ctx.blocker?.value;
            const hasBlocker = bv && bv !== '없음' && bv !== 'none';
            return hasBlocker
              ? <div className="dev-blocker">{ctx.blocker.status} {bv}</div>
              : <div className="dev-blocker dev-blocker-clear">✓ no blocker</div>;
          })()}
          <div className="dev-ctx-row">
            <span className="dev-label">sprint</span>
            <span className="dev-value">{ctx.current_sprint?.status} {ctx.current_sprint?.value || '—'}</span>
          </div>
          <div className="dev-ctx-row">
            <span className="dev-label">focus </span>
            <span className="dev-value">{ctx.current_focus?.status} {ctx.current_focus?.value || '—'}</span>
          </div>
          <div className="dev-ctx-row">
            <span className="dev-label">next  </span>
            <span className="dev-value dev-dim">{ctx.next_milestone?.value || '—'}</span>
          </div>
          <div className="dev-bars">
            <div className="dev-bar-row">
              <span className="dev-label">feat</span>
              {miniBar(fDone, f.IN_PROGRESS || 0, f.PLANNED || 0, fTotal)}
              <span className="dev-dim"> {fDone}/{fTotal}</span>
            </div>
            <div className="dev-bar-row">
              <span className="dev-label">todo</span>
              {miniBar(tDone, t.IN_PROGRESS || 0, t.TODO || 0, tTotal)}
              <span className="dev-dim"> {tDone}/{tTotal}</span>
              {(t.BLOCKED || 0) > 0 && (
                <span className="dev-blocked"> [{t.BLOCKED} blocked]</span>
              )}
            </div>
          </div>
          <div className="dev-deploy">
            <span className="dev-dim">deploy</span> {ctx.last_deploy?.value || '—'}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DevProjects() {
  return (
    <div className="dev-terminal">
      <div className="dev-titlebar">
        <span className="dev-dot" style={{ background: '#ff5f57' }} />
        <span className="dev-dot" style={{ background: '#febc2e' }} />
        <span className="dev-dot" style={{ background: '#28c840' }} />
        <span className="dev-titlebar-label">doil@dev — project status</span>
      </div>
      <div className="dev-terminal-body">
        <div className="dev-prompt-line">
          <span className="dev-prompt">$</span>
          <span className="dev-cmd"> doil status --all</span>
        </div>
        <div className="dev-projects-grid">
          {PROJECTS.map(p => <ProjectCard key={p.key} project={p} />)}
        </div>
        <div className="dev-cursor-line">
          <span className="dev-prompt">$</span>
          <span className="dev-cursor"> ▊</span>
        </div>
      </div>
    </div>
  );
}
