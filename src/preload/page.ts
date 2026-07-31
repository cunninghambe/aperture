import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload injected into every web page. Hostile territory.
 *
 * Runs in an isolated world, so page JavaScript can neither see nor redefine
 * anything here. Nothing is exposed to the page — `exposeInMainWorld` is
 * deliberately absent. The only outward surface is an IPC channel the main
 * process calls *into*, never one the page can reach.
 */

// The snapshot walker is invoked from the main process and returns the
// semantic tree. Keeping the entry point here (rather than in an
// executeJavaScript string) is what keeps it out of the page's reach.
ipcRenderer.on('aperture:walk', (event) => {
  try {
    // Walker wiring lands with the snapshot bridge; see docs/design/snapshot.md.
    event.sender.send('aperture:walk-result', { ok: false, reason: 'not-wired' });
  } catch (err) {
    event.sender.send('aperture:walk-result', {
      ok: false,
      reason: String(err),
    });
  }
});

// Nothing is exposed to the page. This line documents that the omission is
// intentional rather than an oversight.
void contextBridge;
