import type * as WebBrowser from 'expo-web-browser';

import {
  createAuthBrowser,
  type AuthBrowserOptions,
  type AuthBrowserResult,
} from './authBrowser';

let browser: ReturnType<typeof createAuthBrowser> | undefined;

/** Native loading is deferred until use; the driver owns the shared session gate. */
export async function openXAuthorization(
  url: string,
  options?: AuthBrowserOptions,
): Promise<AuthBrowserResult> {
  if (!browser) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { openAuthSessionAsync } = require('expo-web-browser') as typeof WebBrowser;
    browser = createAuthBrowser(openAuthSessionAsync);
  }
  return browser.open(url, options);
}
