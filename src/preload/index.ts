import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { API_METHODS, type Api, type MenuAction } from '../shared/ipc';
import type { PrEvent } from '../shared/model';

const invokers = Object.fromEntries(
  API_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.invoke(`api:${method}`, ...args)]),
) as unknown as Omit<Api, 'onPrEvent' | 'onMenu' | 'onOpenPr' | 'takePendingLinks'>;

const api: Api = {
  ...invokers,
  onPrEvent(listener) {
    const handler = (_event: IpcRendererEvent, payload: PrEvent) => listener(payload);
    ipcRenderer.on('pr:event', handler);
    return () => {
      ipcRenderer.off('pr:event', handler);
    };
  },
  onMenu(listener) {
    const handler = (_event: IpcRendererEvent, action: MenuAction) => listener(action);
    ipcRenderer.on('menu', handler);
    return () => {
      ipcRenderer.off('menu', handler);
    };
  },
  onOpenPr(listener) {
    const handler = (_event: IpcRendererEvent, input: string) => listener(input);
    ipcRenderer.on('open-pr', handler);
    return () => {
      ipcRenderer.off('open-pr', handler);
    };
  },
  takePendingLinks: () => ipcRenderer.invoke('links:take') as Promise<string[]>,
};

contextBridge.exposeInMainWorld('api', api);
