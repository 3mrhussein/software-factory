// Data source. Two modes, chosen automatically:
//   live   — served by `factory-cli serve`: /api/state + Server-Sent Events
//   static — any static server (python3 -m http.server): reads config.json,
//            jobs/index.json and job.json files directly, polling.
import { useState, useEffect, useRef, useCallback } from './h.js';
import { candidateFiles } from './model.js';

const ROOT = '../';
const POLL_MS = 2000;

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (/text\/html/.test(type)) return null; // static servers' 404 pages
  return res.text();
}

function parseBacklog(md) {
  return (md || '').split('\n').map((l) => l.match(/^\s*- \[( |x|X)\] (.+?)\s*$/)).filter(Boolean).map((m, line) => {
    const [text, job] = m[2].split(/\s+→\s+/);
    return { line, done: m[1] !== ' ', text: text.trim(), job: job ? job.trim() : null };
  });
}

async function loadStatic() {
  const [config, index, backlog] = await Promise.all([
    getJSON(`${ROOT}config.json`),
    getJSON(`${ROOT}jobs/index.json`).catch(() => ({ jobs: [] })),
    getText(`${ROOT}backlog.md`),
  ]);
  const jobs = await Promise.all(index.jobs.map((id) => getJSON(`${ROOT}jobs/${id}/job.json`).catch((e) => ({ id, invalid: e.message }))));
  return { server: false, repo: config.project?.name || 'repository', config, jobs, backlog: parseBacklog(backlog), at: new Date().toISOString() };
}

export function useFactoryState() {
  const [state, setState] = useState(null);
  const [mode, setMode] = useState('connecting');
  const [error, setError] = useState(null);
  const modeRef = useRef('connecting');

  const refresh = useCallback(async () => {
    try {
      let s;
      if (modeRef.current !== 'static') {
        try {
          s = await getJSON(`${ROOT}api/state`);
        } catch (e) {
          if (modeRef.current === 'connecting') modeRef.current = 'static';
          else throw e;
        }
      }
      if (!s) s = await loadStatic();
      setState(s);
      setError(null);
      return s;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, []);

  useEffect(() => {
    let es = null;
    let timer = null;
    let cancelled = false;
    const poll = (m) => {
      modeRef.current = m;
      setMode(m);
      timer = setInterval(refresh, POLL_MS);
    };
    refresh().then((s) => {
      if (cancelled) return;
      if (s && s.server && 'EventSource' in window) {
        modeRef.current = 'live';
        es = new EventSource(`${ROOT}api/events`);
        es.addEventListener('change', refresh);
        es.addEventListener('hello', () => setMode('live'));
        es.onerror = () => {
          // Server gone or proxy without SSE support: degrade to polling.
          es.close();
          es = null;
          if (!cancelled && !timer) poll('polling');
        };
        setMode('live');
      } else poll(modeRef.current === 'static' ? 'static' : 'polling');
    });
    return () => {
      cancelled = true;
      if (es) es.close();
      if (timer) clearInterval(timer);
    };
  }, [refresh]);

  return { state, mode, error, refresh, server: Boolean(state && state.server) };
}

export async function listFiles(job, server) {
  if (server) {
    try {
      return (await getJSON(`${ROOT}api/jobs/${encodeURIComponent(job.id)}/files`)).files;
    } catch { /* fall through */ }
  }
  return candidateFiles(job);
}

export function readFile(job, path, server) {
  return server
    ? getText(`${ROOT}api/jobs/${encodeURIComponent(job.id)}/file?path=${encodeURIComponent(path)}`)
    : getText(`${ROOT}jobs/${job.id}/${path}`);
}

export async function readDiff(job, server) {
  if (server) {
    try {
      return await getJSON(`${ROOT}api/jobs/${encodeURIComponent(job.id)}/diff`);
    } catch { /* fall through */ }
  }
  const [diff, stat] = await Promise.all([getText(`${ROOT}jobs/${job.id}/diff.patch`), getText(`${ROOT}jobs/${job.id}/diffstat.txt`)]);
  return { diff: diff || '', stat: stat || '', live: false };
}

export async function addBacklogItem(text) {
  const res = await fetch(`${ROOT}api/backlog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
}

export async function removeBacklogItem(index) {
  const res = await fetch(`${ROOT}api/backlog/${index}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
}

// QC data: live from the server (filtered by range), or the snapshot that
// `factory-cli qc index` writes for static hosting.
export function useQc({ server, since, version, enabled = true }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = server
      ? getJSON(`${ROOT}api/qc${since ? `?since=${since}` : ''}`)
      : Promise.all([getJSON(`${ROOT}qc/report.json`), getJSON(`${ROOT}qc/index.json`).catch(() => ({ assessments: [], proposals: [], journal: [] }))])
        .then(([r, index]) => ({ ...r, index, since: null, snapshot: true }));
    load.then((d) => alive && (setData(d), setError(null))).catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [server, since, version, enabled]);
  return { data, error };
}

export function readQcFile(path, server) {
  return server ? getText(`${ROOT}api/qc/file?path=${encodeURIComponent(path)}`) : getText(`${ROOT}qc/${path}`);
}
