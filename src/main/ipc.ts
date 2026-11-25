import { ipcMain } from 'electron';
import { API_METHODS, type Api, type InvokeMethods } from '../shared/ipc';

export function registerIpc(handlers: Pick<Api, InvokeMethods>): void {
  for (const method of API_METHODS) {
    const fn = handlers[method] as (...args: unknown[]) => Promise<unknown>;
    ipcMain.handle(`api:${method}`, (_event, ...args: unknown[]) => fn(...args));
  }
}
