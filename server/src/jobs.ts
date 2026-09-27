import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { HOME } from './env.js';
import { TERMUX, shellCmd, wrap, type Target, type WrapOpts } from './targets.js';

export type JobStatus = 'running' | 'done' | 'failed' | 'killed';

export interface JobMeta {
  id: string;
  title: string;
  command: string;
  status: JobStatus;
  code: number | null;
  startedAt: number;
  endedAt: number | null;
}

interface Job extends JobMeta {
  output: string;
  proc: ChildProcess | null;
}

const MAX_OUTPUT = 512 * 1024;
const MAX_JOBS = 30;

const jobs = new Map<string, Job>();
const listeners = new Set<WebSocket>();

function meta(j: Job): JobMeta {
  const { output: _o, proc: _p, ...m } = j;
  return m;
}

function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const ws of listeners) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function prune() {
  if (jobs.size <= MAX_JOBS) return;
  for (const j of jobs.values()) {
    if (j.status !== 'running') {
      jobs.delete(j.id);
      if (jobs.size <= MAX_JOBS) break;
    }
  }
}

function append(job: Job, chunk: string) {
  job.output += chunk;
  if (job.output.length > MAX_OUTPUT) job.output = job.output.slice(-MAX_OUTPUT);
  broadcast({ type: 'out', id: job.id, data: chunk });
}

export function startJob(
  title: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): JobMeta {
  const job: Job = {
    id: crypto.randomBytes(6).toString('hex'),
    title,
    command: [cmd, ...args].join(' '),
    status: 'running',
    code: null,
    startedAt: Date.now(),
    endedAt: null,
    output: '',
    proc: null,
  };
  jobs.set(job.id, job);
  prune();
  broadcast({ type: 'job', job: meta(job) });
  append(job, `$ ${job.command}\n`);

  const proc = spawn(cmd, args, {
    cwd: opts.cwd ?? HOME,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.proc = proc;
  proc.stdout.setEncoding('utf8').on('data', (d: string) => append(job, d));
  proc.stderr.setEncoding('utf8').on('data', (d: string) => append(job, d));

  const finish = (code: number | null, errMsg?: string) => {
    if (job.status !== 'running') return;
    if (errMsg) append(job, `\n${errMsg}\n`);
    job.code = code;
    job.status = code === 0 ? 'done' : 'failed';
    job.endedAt = Date.now();
    job.proc = null;
    append(job, `\n[çıkış kodu: ${code ?? '-'}]\n`);
    broadcast({ type: 'job', job: meta(job) });
  };
  proc.on('error', (e) => finish(127, `Başlatılamadı: ${e.message}`));
  proc.on('close', (code, signal) => {
    if (signal && job.status === 'running') {
      job.status = 'killed';
      job.code = null;
      job.endedAt = Date.now();
      job.proc = null;
      append(job, `\n[sonlandırıldı: ${signal}]\n`);
      broadcast({ type: 'job', job: meta(job) });
      return;
    }
    finish(code);
  });

  return meta(job);
}

/** Hedef ortamda (Termux ya da distro) iş başlatır. */
export function startJobIn(t: Target, title: string, cmd: string, args: string[], opts: WrapOpts = {}): JobMeta {
  const w = wrap(t, cmd, args, opts);
  const label = t.kind === 'distro' ? `[${t.name}] ${title}` : title;
  return startJob(label, w.cmd, w.args, { cwd: w.cwd, env: w.env });
}

/** Kabuk komutu olarak iş başlatır (kısayollar için). */
export function startShellJob(title: string, command: string, cwd?: string, t: Target = TERMUX): JobMeta {
  const [sh, args] = shellCmd(t, command);
  return startJobIn(t, title, sh, args, { cwd });
}

export function listJobs(): JobMeta[] {
  return [...jobs.values()].map(meta).sort((a, b) => b.startedAt - a.startedAt);
}

export function getJob(id: string) {
  const j = jobs.get(id);
  return j ? { ...meta(j), output: j.output } : null;
}

export function killJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j?.proc) return false;
  j.proc.kill('SIGTERM');
  setTimeout(() => j.proc?.kill('SIGKILL'), 3000);
  return true;
}

export function removeJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status === 'running') return false;
  jobs.delete(id);
  broadcast({ type: 'removed', id });
  return true;
}

export function addJobListener(ws: WebSocket) {
  listeners.add(ws);
  ws.send(JSON.stringify({ type: 'list', jobs: listJobs() }));
  ws.on('close', () => listeners.delete(ws));
}
