import type { Api } from '../shared/ipc';

declare global {
  interface Window {
    api: Api;
  }
}

export const api: Api = window.api;

export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
