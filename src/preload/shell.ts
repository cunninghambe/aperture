import { contextBridge, ipcRenderer } from 'electron';
import type { Container, TabId, TabInfo, VaultEntryPublic, VaultState } from '@shared/types';

/**
 * Preload for the browser chrome UI. This is the trusted surface — it drives
 * tabs, containers, and the vault UI.
 *
 * Nothing here returns secret material. `vault.list` returns public entry
 * metadata; there is deliberately no method that resolves a password, because
 * a method that exists can be called, and the chrome UI runs code that could
 * in principle be influenced by page-derived strings (titles, favicons).
 */
const api = {
  tabs: {
    list: (): Promise<TabInfo[]> => ipcRenderer.invoke('tabs:list'),
    create: (url?: string): Promise<TabId> => ipcRenderer.invoke('tabs:create', url),
    close: (id: TabId): Promise<void> => ipcRenderer.invoke('tabs:close', id),
    activate: (id: TabId): Promise<void> => ipcRenderer.invoke('tabs:activate', id),
    navigate: (id: TabId, url: string): Promise<void> =>
      ipcRenderer.invoke('tabs:navigate', id, url),
    back: (id: TabId): Promise<void> => ipcRenderer.invoke('tabs:back', id),
    forward: (id: TabId): Promise<void> => ipcRenderer.invoke('tabs:forward', id),
    reload: (id: TabId): Promise<void> => ipcRenderer.invoke('tabs:reload', id),
    stop: (id: TabId): Promise<void> => ipcRenderer.invoke('tabs:stop', id),
    onChanged: (cb: (tabs: TabInfo[], activeId: TabId | null) => void): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: { tabs: TabInfo[]; activeId: TabId | null },
      ): void => cb(payload.tabs, payload.activeId);
      ipcRenderer.on('tabs:changed', listener);
      return () => ipcRenderer.removeListener('tabs:changed', listener);
    },
  },

  containers: {
    list: (): Promise<Container[]> => ipcRenderer.invoke('containers:list'),
  },

  privacy: {
    stats: (): Promise<{ blocked: number }> => ipcRenderer.invoke('privacy:stats'),
  },

  vault: {
    state: (): Promise<VaultState> => ipcRenderer.invoke('vault:state'),
    lock: (): Promise<void> => ipcRenderer.invoke('vault:lock'),
    /** Opens the vault window. Unlocking happens there, not here. */
    open: (): Promise<void> => ipcRenderer.invoke('vault:open'),
  },

  capture: (): Promise<{ destination: string; location: string }> =>
    ipcRenderer.invoke('capture:page'),

  agent: {
    /** Fires when the agent acts, so the human can watch it work. */
    onActivity: (cb: (entry: { tool: string; detail: string; at: number }) => void): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        entry: { tool: string; detail: string; at: number },
      ): void => cb(entry);
      ipcRenderer.on('agent:activity', listener);
      return () => ipcRenderer.removeListener('agent:activity', listener);
    },
  },
};

contextBridge.exposeInMainWorld('aperture', api);

export type ApertureApi = typeof api;
