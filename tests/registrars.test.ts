import { describe, it, expect } from 'vitest';
import { SERVER_NAME, SERVER_VERSION, SERVER_BANNER, serverDeps, toolRegistrars } from '../src/registrars.js';
import { OFWClient } from '../src/client.js';

describe('shared server registrars', () => {
  it('exposes a stable server identity', () => {
    expect(SERVER_NAME).toBe('ofw');
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SERVER_BANNER).toContain('ofw-mcp');
  });

  it('threads the shared OFW client through as deps', () => {
    expect(serverDeps).toBeInstanceOf(OFWClient);
  });

  it('lists all five tool registrars as functions (both entry points use these)', () => {
    expect(toolRegistrars).toHaveLength(5);
    for (const r of toolRegistrars) expect(typeof r).toBe('function');
  });
});
