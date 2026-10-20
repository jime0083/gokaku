import * as Linking from 'expo-linking';
import { showManageSubscriptionsIOS } from 'expo-iap';
import { TERMS_OF_SERVICE_URL, PRIVACY_POLICY_URL, CONTACT_URL } from '@/config/legalLinks';
import { openSettingsLink } from '../settingsLinks';
jest.mock('expo-linking', () => ({ openURL: jest.fn() }));
jest.mock('expo-iap', () => ({ showManageSubscriptionsIOS: jest.fn() }));
beforeEach(() => { jest.clearAllMocks(); });
it('opens management and ignores returned purchases', async () => {
  jest.mocked(showManageSubscriptionsIOS).mockResolvedValueOnce([{ id: 'purchase' }] as never);
  expect(await openSettingsLink('subscription')).toBeUndefined();
  expect(showManageSubscriptionsIOS).toHaveBeenCalledTimes(1);
  expect(Linking.openURL).not.toHaveBeenCalled();
});
it.each([['terms', TERMS_OF_SERVICE_URL], ['privacy', PRIVACY_POLICY_URL]] as const)('opens existing %s URL', async (action, url) => {
  await openSettingsLink(action);
  expect(Linking.openURL).toHaveBeenCalledWith(url);
});
it('has no guessed contact URL', async () => {
  expect(CONTACT_URL).toBeNull();
  await expect(openSettingsLink('contact')).rejects.toThrow();
  expect(Linking.openURL).not.toHaveBeenCalled();
});
it('propagates action failures for UI retry', async () => {
  jest.mocked(showManageSubscriptionsIOS).mockRejectedValueOnce(new Error('failed'));
  await expect(openSettingsLink('subscription')).rejects.toThrow('failed');
  jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('offline'));
  await expect(openSettingsLink('terms')).rejects.toThrow('offline');
});
