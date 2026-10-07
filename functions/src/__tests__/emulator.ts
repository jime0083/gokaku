import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FUNCTIONS_REGION } from '../config';

type FirebaseJson = {
  emulators?: { functions?: { host?: string; port?: number } };
};

/** Emulator 上の HTTPS 関数の URL を、firebase.json の Emulator 設定と実行中のプロジェクトIDから組み立てる */
export function functionUrl(name: string): string {
  const projectId = process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error('GCLOUD_PROJECT が未設定です。`npm run test:functions`(firebase emulators:exec)経由で実行してください');
  }
  const firebaseJson = JSON.parse(
    readFileSync(resolve(__dirname, '../../../firebase.json'), 'utf8'),
  ) as FirebaseJson;
  const functionsEmulator = firebaseJson.emulators?.functions;
  if (!functionsEmulator?.host || !functionsEmulator.port) {
    throw new Error('firebase.json に Functions Emulator の host/port がありません');
  }
  return `http://${functionsEmulator.host}:${functionsEmulator.port}/${projectId}/${FUNCTIONS_REGION}/${name}`;
}
