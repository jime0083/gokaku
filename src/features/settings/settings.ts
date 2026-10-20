export type SettingsDraft = { checkEnabled: boolean; xPostEnabled: boolean };
export type LoadedSettings = SettingsDraft & { uid: string };

export function parseSettings(data: Record<string, unknown>): SettingsDraft {
  const checkEnabled = data.checkEnabled === undefined ? true : data.checkEnabled;
  const xPostEnabled = data.xPostEnabled === undefined ? false : data.xPostEnabled;
  if (typeof checkEnabled !== 'boolean' || typeof xPostEnabled !== 'boolean') {
    throw new Error('設定の形式が不正です');
  }
  return { checkEnabled, xPostEnabled };
}

/** Shared save boundary for the native repository and Emulator. Explicit two-field allowlist. */
export async function saveSettings(port: {
  update: (uid: string, patch: SettingsDraft) => Promise<void>;
  remember: (checkEnabled: boolean) => void;
}, expectedUid: string, getCurrentUid: () => string | null, draft: SettingsDraft): Promise<void> {
  if (!expectedUid || getCurrentUid() !== expectedUid) throw new Error('ログイン状態が変わりました');
  if (typeof draft.checkEnabled !== 'boolean' || typeof draft.xPostEnabled !== 'boolean') {
    throw new Error('設定の形式が不正です');
  }
  await port.update(expectedUid, { checkEnabled: draft.checkEnabled, xPostEnabled: draft.xPostEnabled });
  // Future lock-screen starts only. Never change an active session snapshot or confirmations.
  // An already accepted server write may finish after sign-out; do not apply its prefs to another user.
  if (getCurrentUid() === expectedUid) port.remember(draft.checkEnabled);
}
