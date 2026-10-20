import { showManageSubscriptionsIOS } from 'expo-iap';
import { openURL } from 'expo-linking';

import { CONTACT_URL, PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '@/config/legalLinks';

export type SettingsLink = 'subscription' | 'terms' | 'privacy' | 'contact';

export async function openSettingsLink(action: SettingsLink): Promise<void> {
  if (action === 'subscription') {
    // The returned purchases never authorize a client-side subscription update.
    await showManageSubscriptionsIOS();
    return;
  }
  const url = action === 'terms' ? TERMS_OF_SERVICE_URL : action === 'privacy' ? PRIVACY_POLICY_URL : CONTACT_URL;
  if (!url) throw new Error('お問い合わせ先が未設定です');
  await openURL(url);
}
