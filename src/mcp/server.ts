import { createServer, type Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import * as z from 'zod';
import type { TabManager } from '@main/tabs.js';
import { registerBrowserTools } from './tools.js';

/**
 * The in-browser MCP server.
 *
 * Aperture is a browser you are already running, so Claude Code cannot spawn
 * it over stdio — it attaches to a live browser over Streamable HTTP on
 * loopback. That is the whole premise: the agent works in *your* browser, with
 * your sessions and your containers, and you can watch it happen.
 *
 * Two security notes that are specific to shipping this inside a browser:
 *
 *   1. DNS rebinding is a live attack here, not a formality. A page you visit
 *      can resolve its own domain to 127.0.0.1 and start talking to this
 *      server as if it were same-origin — from inside the very browser the
 *      server controls. Host and Origin validation is what stops that, so it
 *      is not optional and not configurable.
 *
 *   2. A bearer token, regenerated per launch, gates every request. Localhost
 *      is not an authentication boundary on a multi-user or multi-process box.
 */

export interface McpHandle {
  url: string;
  token: string;
  close: () => Promise<void>;
}

const PORT = 8817;

export async function startMcpServer(
  getTabs: () => TabManager | null,
  getWindow: () => import('electron').BaseWindow | null = () => null,
): Promise<McpHandle> {
  const token = randomBytes(24).toString('base64url');

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'aperture', version: '0.1.0' });
    registerBrowserTools(server, getTabs, getWindow);
    return server;
  });

  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const http: HttpServer = createServer((req, res) => {
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;

    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // GET /metrics — process metadata, behind the same bearer, same loopback
    // bind, after the same rebinding checks. Deliberately BELOW the auth gate:
    // pid and per-process memory are not secrets, but they are also not for
    // any page that talks its way onto this port.
    //
    // WHY IT SHIPS IN THE PRODUCT AND NOT ONLY IN THE BENCH. Wave 2's input
    // path wedged for forty minutes and the root cause is permanently
    // undecidable because nothing recorded what the process tree was doing —
    // the leading hypothesis, a GPU process crash and relaunch, would have
    // been a single pid change in this reply. It costs nothing when nobody
    // polls it, it is read-only, and the next wedge may happen under a human's
    // use rather than the bench's. docs/design/tier3.md §2.2.
    //
    // No page data crosses this endpoint: `getAppMetrics` returns Electron's
    // own per-process array (type, pid, cpu, memory) and nothing else. The
    // array is passed through verbatim so a consumer reading only the fields
    // it knows keeps working when Electron adds one.
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/metrics') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          pid: process.pid,
          uptimeS: Math.round(process.uptime()),
          metrics: app.getAppMetrics(),
        }),
      );
      return;
    }

    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    // Bind to loopback explicitly. Binding 0.0.0.0 would expose control of the
    // user's logged-in browser to the local network.
    http.listen(PORT, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${PORT}/mcp`,
    token,
    close: async () => {
      await handler.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

export { z };
