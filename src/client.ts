import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb bundle)
try {
  const { config } = await import('dotenv');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  config({ path: join(__dirname, '..', '.env'), override: false, quiet: true });
} catch {
  // not available — rely on process.env (mcpb sets credentials via mcp_config.env)
}

/**
 * Read an env var, trim whitespace, and treat as unset if blank or if the value
 * looks like an unsubstituted shell placeholder (e.g. `${FOO}`) — defends
 * against MCP hosts that pass .mcp.json env blocks through unexpanded.
 */
function readVar(key: string): string | undefined {
  const raw = process.env[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === 'undefined' || trimmed === 'null') return undefined;
  if (/^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

const BASE_URL = 'https://ofw.ourfamilywizard.com';

const OFW_PROTOCOL_HEADERS = {
  'ofw-client': 'WebApplication',
  'ofw-version': '1.0.0',
} as const;

interface LoginResponse {
  auth: string; // Bearer token for all subsequent API calls
  redirectUrl: string;
}

export interface BinaryResponse {
  body: Buffer;
  contentType: string | null;
  /** Parsed from Content-Disposition header if present. */
  suggestedFileName: string | null;
}

// Parse a Content-Disposition header for a filename. Prefers RFC 6266
// `filename*=UTF-8''…` (percent-decoded) and falls back to `filename="…"`.
function parseContentDispositionFilename(cd: string): string | null {
  const extMatch = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (extMatch) {
    const raw = extMatch[1].trim().replace(/^"|"$/g, '');
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return m ? m[1] : null;
}

export class OFWClient {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureAuthenticated();
    const response = await this.fetchWithRetry(method, path, body, 'application/json', false);
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Like `request`, but returns the raw bytes plus Content-Type/-Disposition metadata. */
  async requestBinary(method: string, path: string): Promise<BinaryResponse> {
    await this.ensureAuthenticated();
    const response = await this.fetchWithRetry(method, path, undefined, 'application/octet-stream', false);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type'),
      suggestedFileName: parseContentDispositionFilename(response.headers.get('content-disposition') ?? ''),
    };
  }

  // Single fetch+retry scaffold for both JSON and binary callers. Handles
  // 401 (re-auth and replay once), 429 (wait 2s and replay once), and
  // turns any other non-2xx into a thrown Error.
  private async fetchWithRetry(
    method: string,
    path: string,
    body: unknown,
    accept: string,
    isRetry: boolean,
  ): Promise<Response> {
    const isFormData = body instanceof FormData;
    const headers: Record<string, string> = {
      ...OFW_PROTOCOL_HEADERS,
      Accept: accept,
      Authorization: `Bearer ${this.token!}`,
    };
    if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: isFormData ? body : JSON.stringify(body) } : {}),
    });

    if (response.status === 401 && !isRetry) {
      this.token = null;
      this.tokenExpiry = null;
      await this.ensureAuthenticated();
      return this.fetchWithRetry(method, path, body, accept, true);
    }
    if (response.status === 429) {
      if (!isRetry) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        return this.fetchWithRetry(method, path, body, accept, true);
      }
      throw new Error('Rate limited by OFW API');
    }
    if (!response.ok) {
      throw new Error(`OFW API error: ${response.status} ${response.statusText} for ${method} ${path}`);
    }
    return response;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.isTokenExpiredSoon()) return;
    await this.login();
  }

  private async login(): Promise<void> {
    const username = readVar('OFW_USERNAME');
    const password = readVar('OFW_PASSWORD');
    if (!username || !password) {
      throw new Error('OFW_USERNAME and OFW_PASSWORD must be set');
    }

    // Spring Security requires a SESSION cookie before accepting the login POST.
    // GET /ofw/login.form with redirect:manual to capture the Set-Cookie from the 303 response.
    const initResponse = await fetch(`${BASE_URL}/ofw/login.form`, {
      headers: { ...OFW_PROTOCOL_HEADERS },
      redirect: 'manual',
    });
    // Extract just the SESSION=value part (strip attributes like Path, Secure, etc.)
    const setCookie = initResponse.headers.get('set-cookie') ?? '';
    const sessionCookie = setCookie.split(';')[0];

    const response = await fetch(`${BASE_URL}/ofw/login`, {
      method: 'POST',
      headers: {
        ...OFW_PROTOCOL_HEADERS,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      },
      body: new URLSearchParams({
        submit: 'Sign In',
        _eventId: 'submit',
        username,
        password,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`OFW login failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const body = await response.text();
      throw new Error(`OFW login returned unexpected response (${contentType}): ${body.substring(0, 200)}`);
    }

    const data = (await response.json()) as LoginResponse;
    this.token = data.auth;
    // Token expiry not returned by login endpoint; use 6h as a safe default
    this.tokenExpiry = new Date(Date.now() + 6 * 60 * 60 * 1000);
  }

  private isTokenExpiredSoon(): boolean {
    if (!this.token || !this.tokenExpiry) return true;
    return this.tokenExpiry.getTime() - Date.now() < 5 * 60 * 1000;
  }
}

export const client = new OFWClient();
