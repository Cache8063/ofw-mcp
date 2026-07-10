#!/usr/bin/env node
// Streamable-HTTP entry point. Same MCP server (tools, auth, cache) as the
// stdio entry (src/index.ts) — only the transport differs. Used to run ofw-mcp
// as a network-reachable service (e.g. behind caddy-tailscale on the homelab)
// instead of being spawned over stdio by a local desktop client.
//
// SECURITY: this binds 127.0.0.1 only. It performs NO authentication of its
// own — it MUST sit behind a reverse proxy that gates access (e.g. Caddy with
// tailscale_auth restricted to a single identity). Do not expose the port
// directly; anything that can reach it can drive your OFW account.
//
// This file is an entry point (like index.ts) and is excluded from unit
// coverage — its logic is exercised by the deploy smoke test.

// Suppress node:sqlite's ExperimentalWarning (same shim as index.ts; the cache
// backend triggers it on first tool call).
const originalEmit = process.emit.bind(process);
type EmitFn = (event: string | symbol, ...args: unknown[]) => boolean;
(process.emit as EmitFn) = function (event: string | symbol, ...args: unknown[]): boolean {
  if (event === 'warning') {
    const w = args[0] as { name?: string; message?: string } | undefined;
    if (w?.name === 'ExperimentalWarning' && /SQLite/i.test(w.message ?? '')) {
      return false;
    }
  }
  return (originalEmit as EmitFn)(event, ...args);
};

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createMcpServer } from '@chrischall/mcp-utils';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME, SERVER_VERSION, SERVER_BANNER, serverDeps, toolRegistrars } from './registrars.js';

const HOST = '127.0.0.1';
const PORT = (() => {
  const raw = process.env.OFW_HTTP_PORT;
  const n = raw ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 7330;
})();
const MCP_PATH = '/mcp';

// One transport per MCP session, keyed by the session id the SDK mints on
// initialize. A fresh McpServer is built per session so concurrent clients
// don't share protocol state; they share the module-singleton OFW client
// (serverDeps), i.e. one auth/token lifecycle for the account.
const transports = new Map<string, StreamableHTTPServerTransport>();

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // POST: either a new session (initialize) or a message on an existing one.
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    let transport: StreamableHTTPServerTransport | undefined =
      sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (!isInitializeRequest(body)) {
        sendJsonError(res, 400, 'No valid session; expected an initialize request.');
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport as StreamableHTTPServerTransport);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      const server = await createMcpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        deps: serverDeps,
        tools: toolRegistrars,
      });
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, body);
    return;
  }

  // GET (SSE stream) / DELETE (session teardown) require an existing session.
  if (req.method === 'GET' || req.method === 'DELETE') {
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      sendJsonError(res, 400, 'Unknown or missing mcp-session-id.');
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
}

const httpServer = createServer((req, res) => {
  if (!req.url || new URL(req.url, `http://${HOST}`).pathname !== MCP_PATH) {
    // Cheap liveness probe for the deploy smoke test / healthchecks.
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    res.writeHead(404).end();
    return;
  }
  handleMcp(req, res).catch((err) => {
    console.error(`[ofw-mcp:http] request error: ${(err as Error).message}`);
    if (!res.headersSent) sendJsonError(res, 500, 'Internal error');
  });
});

httpServer.listen(PORT, HOST, () => {
  console.error(SERVER_BANNER);
  console.error(`[ofw-mcp:http] ${SERVER_NAME} v${SERVER_VERSION} listening on http://${HOST}:${PORT}${MCP_PATH} (healthz: /healthz)`);
  console.error('[ofw-mcp:http] localhost-only; put a reverse proxy with identity gating in front.');
});

// Graceful shutdown so an orchestrator restart doesn't leak sessions.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const t of transports.values()) void t.close();
    httpServer.close(() => process.exit(0));
  });
}
