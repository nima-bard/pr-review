import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface Pending {
  resolve(content: Buffer | null): void;
  reject(err: Error): void;
}

const CACHE_LIMIT = 400;

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export class BlobReader {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queue: Pending[] = [];
  private readonly cache = new Map<string, Promise<Buffer | null>>();

  constructor(private readonly repo: string) {}

  read(rev: string, path: string): Promise<Buffer | null> {
    const spec = `${rev}:${path}`;
    const cached = this.cache.get(spec);
    if (cached) return cached;
    const pending = this.request(spec).then((content) => {
      if (content === null) this.cache.delete(spec);
      return content;
    });
    this.cache.set(spec, pending);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return pending;
  }

  async readText(rev: string, path: string): Promise<{ text: string; binary: boolean } | null> {
    const buf = await this.read(rev, path);
    if (buf === null) return null;
    if (isBinary(buf)) return { text: '', binary: true };
    return { text: buf.toString('utf8'), binary: false };
  }

  async readLines(rev: string, path: string): Promise<string[] | undefined> {
    const res = await this.readText(rev, path);
    if (!res || res.binary) return undefined;
    return splitLines(res.text);
  }

  forget(rev: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${rev}:`)) this.cache.delete(key);
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawn('git', ['cat-file', '--batch'], {
      cwd: this.repo,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    proc.on('exit', () => {
      this.proc = null;
      this.buffer = Buffer.alloc(0);
      for (const p of this.queue.splice(0)) p.reject(new Error('git cat-file exited'));
    });
    proc.on('error', (err) => {
      for (const p of this.queue.splice(0)) p.reject(err);
    });
    this.proc = proc;
    return proc;
  }

  private request(spec: string): Promise<Buffer | null> {
    if (spec.includes('\n')) return Promise.resolve(null);
    const proc = this.ensure();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      proc.stdin.write(`${spec}\n`);
    });
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const nl = this.buffer.indexOf(10);
      if (nl === -1) return;
      const header = this.buffer.subarray(0, nl).toString('utf8');
      if (/ (missing|ambiguous)$/.test(header)) {
        this.buffer = this.buffer.subarray(nl + 1);
        this.queue.shift()!.resolve(null);
        continue;
      }
      const size = Number(header.split(' ')[2]);
      if (!Number.isFinite(size)) {
        this.buffer = this.buffer.subarray(nl + 1);
        this.queue.shift()!.resolve(null);
        continue;
      }
      const end = nl + 1 + size;
      if (this.buffer.length < end + 1) return;
      const content = Buffer.from(this.buffer.subarray(nl + 1, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.queue.shift()!.resolve(content);
    }
  }
}

export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
