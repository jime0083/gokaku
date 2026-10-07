import firebaseJson from '../../firebase.json';

import {
  FIREBASE_EMULATOR_CONFIG,
  getFirebaseEmulatorConfig,
} from '@/config/firebase-emulator';

describe('getFirebaseEmulatorConfig', () => {
  it('開発ビルドでは Emulator の接続先を返す', () => {
    expect(getFirebaseEmulatorConfig(true)).toBe(FIREBASE_EMULATOR_CONFIG);
  });

  it('本番ビルドでは null を返す', () => {
    expect(getFirebaseEmulatorConfig(false)).toBeNull();
  });

  it('接続先が firebase.json の Emulator 設定と一致する', () => {
    const { emulators } = firebaseJson;

    expect(FIREBASE_EMULATOR_CONFIG).toEqual({
      host: emulators.auth.host,
      authPort: emulators.auth.port,
      firestorePort: emulators.firestore.port,
      functionsPort: emulators.functions.port,
    });
    expect(emulators.firestore.host).toBe(FIREBASE_EMULATOR_CONFIG.host);
    expect(emulators.functions.host).toBe(FIREBASE_EMULATOR_CONFIG.host);
  });
});
