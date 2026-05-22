// Wire-level constants shared by client.ts (general API calls) and
// auth-password.ts (form-login). Kept in a leaf module to avoid an import
// cycle between client.ts → auth.ts → auth-password.ts.

export const BASE_URL = 'https://ofw.ourfamilywizard.com';

// Required on every OFW API request. `ofw-version` is the OFW protocol
// version, not this package's version — do NOT bump it during a release.
export const OFW_PROTOCOL_HEADERS = {
  'ofw-client': 'WebApplication',
  'ofw-version': '1.0.0',
} as const;
