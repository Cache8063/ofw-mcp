// Shared server identity + tool registrars, imported by BOTH entry points
// (src/index.ts = stdio, src/http.ts = Streamable HTTP). Keeping the tool list
// in one place means a new tool can't be wired into one transport and forgotten
// on the other.

import { registerUserTools } from './tools/user.js';
import { registerMessageTools } from './tools/messages.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerJournalTools } from './tools/journal.js';
import { client } from './client.js';

export const SERVER_NAME = 'ofw';
export const SERVER_VERSION = '2.4.4'; // x-release-please-version
export const SERVER_BANNER =
  '[ofw-mcp] This project was developed and is maintained by AI (Claude Sonnet 4.6). Use at your own discretion.';

// `client` is the shared, lazily-authenticated OFW API client (a module-load
// singleton). Both transports thread it through as `deps`.
export const serverDeps = client;

export const toolRegistrars = [
  registerUserTools,
  registerMessageTools,
  registerCalendarTools,
  registerExpenseTools,
  registerJournalTools,
];
