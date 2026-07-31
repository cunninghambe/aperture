import { contextBridge, ipcRenderer } from 'electron';
import type { VaultEntryPublic, VaultState } from '@shared/types';
import type { Profile } from '@vault/profile';

/**
 * Preload for the vault window only.
 *
 * This is the one preload in Aperture that exposes a plaintext-returning
 * method (`reveal`). It is loaded exclusively by the vault window, which the
 * agent cannot address and which is excluded from screen capture. The main
 * process additionally verifies the sender on every one of these channels, so
 * knowing a channel name is not sufficient to call it.
 */
const api = {
  status: (): Promise<{ exists: boolean; state: VaultState }> =>
    ipcRenderer.invoke('vaultui:status'),

  create: (passphrase: string): Promise<void> =>
    ipcRenderer.invoke('vaultui:create', passphrase),
  unlock: (passphrase: string): Promise<boolean> =>
    ipcRenderer.invoke('vaultui:unlock', passphrase),
  lock: (): Promise<void> => ipcRenderer.invoke('vaultui:lock'),

  list: (): Promise<VaultEntryPublic[]> => ipcRenderer.invoke('vaultui:list'),
  add: (spec: { origin: string; username: string; password: string }): Promise<string> =>
    ipcRenderer.invoke('vaultui:add', spec),
  update: (id: string, patch: Record<string, string>): Promise<boolean> =>
    ipcRenderer.invoke('vaultui:update', id, patch),
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('vaultui:delete', id),

  /** Human-initiated reveal. Never called from anywhere but a click. */
  reveal: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('vaultui:reveal', id),
  generate: (length: number): Promise<string> =>
    ipcRenderer.invoke('vaultui:generate', length),

  totp: (id: string): Promise<{ code: string; secondsRemaining: number } | null> =>
    ipcRenderer.invoke('vaultui:totp', id),
  setTotp: (id: string, secret: string): Promise<boolean> =>
    ipcRenderer.invoke('vaultui:set-totp', id, secret),

  telemetryGet: (): Promise<{
    enabled: boolean; dsn: string; sent: number; dropped: number;
  }> => ipcRenderer.invoke('vaultui:telemetry-get'),
  telemetrySave: (enabled: boolean, dsn: string): Promise<void> =>
    ipcRenderer.invoke('vaultui:telemetry-save', enabled, dsn),

  profileGet: (): Promise<Profile | null> => ipcRenderer.invoke('vaultui:profile-get'),
  profileSave: (p: Profile): Promise<void> =>
    ipcRenderer.invoke('vaultui:profile-save', p),

  attachments: (): Promise<
    { id: string; label: string; filename: string; kind: string; sizeKb: number }[]
  > => ipcRenderer.invoke('vaultui:attachments'),
  attachmentAdd: (
    label: string,
    kind: string,
  ): Promise<{ id: string; label: string; filename: string } | null> =>
    ipcRenderer.invoke('vaultui:attachment-add', label, kind),
  attachmentRemove: (id: string): Promise<void> =>
    ipcRenderer.invoke('vaultui:attachment-remove', id),

  notionGet: (): Promise<{ configured: boolean; inboxPageId: string }> =>
    ipcRenderer.invoke('vaultui:notion-get'),
  notionSave: (token: string, inboxPageId: string): Promise<boolean> =>
    ipcRenderer.invoke('vaultui:notion-save', token, inboxPageId),
  notionTest: (): Promise<{ ok: boolean; detail: string }> =>
    ipcRenderer.invoke('vaultui:notion-test'),

  /** Opens a link in the OS browser. The vault window never navigates. */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('vaultui:open-external', url),
};

contextBridge.exposeInMainWorld('vault', api);

export type VaultApi = typeof api;
