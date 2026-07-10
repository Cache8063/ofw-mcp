#!/usr/bin/env node
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
import { runMcp } from '@chrischall/mcp-utils';
import { SERVER_NAME, SERVER_VERSION, SERVER_BANNER, serverDeps, toolRegistrars } from './registrars.js';

// runMcp builds the McpServer, applies the registrars (with `client` threaded
// through as deps), prints the banner to stderr, wires SIGINT/SIGTERM graceful
// shutdown, and connects the stdio transport. The deferred-config-error pattern
// is preserved: `client` is constructed at module load in ./client.js (auth is
// resolved lazily on the first tool call), so the host's initial tools/list
// always succeeds before any credential check runs.
//
// The Streamable-HTTP transport (src/http.ts) reuses the same identity + tool
// registrars from ./registrars.js.
await runMcp({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  deps: serverDeps,
  tools: toolRegistrars,
  banner: SERVER_BANNER,
});
