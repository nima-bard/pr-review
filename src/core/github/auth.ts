import { execFile } from 'node:child_process';

export class GhTokenProvider {
  private token: Promise<string> | undefined;

  constructor(
    private readonly host: string,
    private readonly staticToken?: string,
    private readonly fallback?: () => Promise<string | null>,
  ) {}

  get(): Promise<string> {
    if (this.staticToken) return Promise.resolve(this.staticToken);
    this.token ??= new Promise<string>((resolve, reject) => {
      execFile('gh', ['auth', 'token', '--hostname', this.host], { timeout: 10_000 }, (err, stdout) => {
        if (!err && stdout.trim() !== '') {
          resolve(stdout.trim());
          return;
        }
        void (this.fallback?.() ?? Promise.resolve(null)).then((token) => {
          if (token) resolve(token);
          else reject(new Error(`Not signed in to GitHub CLI for ${this.host}. Run \`gh auth login --hostname ${this.host}\`, or sign in under Settings.`));
        }, reject);
      });
    }).catch((err: unknown) => {
      this.token = undefined;
      throw err;
    });
    return this.token;
  }

  invalidate(): void {
    this.token = undefined;
  }
}
