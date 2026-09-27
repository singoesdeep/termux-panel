import { execFile } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Bir komutu çalıştırır; hata fırlatmaz, çıkış kodunu döndürür. */
export function run(
  cmd: string,
  args: string[] = [],
  opts: { timeout?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout ?? 30_000,
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || (err && !stdout ? err.message : '') });
      },
    );
  });
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
