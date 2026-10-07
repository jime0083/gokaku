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

type FirestoreEmulatorFirebaseJson = {
  emulators?: { firestore?: { host?: string; port?: number } };
};

function firestoreEmulatorBaseUrl(): string {
  const projectId = process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error('GCLOUD_PROJECT が未設定です。`npm run test:functions` 経由で実行してください');
  }
  const firebaseJson = JSON.parse(
    readFileSync(resolve(__dirname, '../../../firebase.json'), 'utf8'),
  ) as FirestoreEmulatorFirebaseJson;
  const firestoreEmulator = firebaseJson.emulators?.firestore;
  if (!firestoreEmulator?.host || !firestoreEmulator.port) {
    throw new Error('firebase.json に Firestore Emulator の host/port がありません');
  }
  return `http://${firestoreEmulator.host}:${firestoreEmulator.port}/v1/projects/${projectId}/databases/(default)/documents`;
}

/** Firestore REST (Emulator) の values 表現を素の JS 値に戻す(テスト用の最小実装) */
function unwrapFirestoreValue(value: Record<string, unknown>): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('mapValue' in value) {
    const fields = (value.mapValue as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
    return unwrapFirestoreFields(fields);
  }
  return undefined;
}

function unwrapFirestoreFields(
  fields: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = unwrapFirestoreValue(value);
  }
  return result;
}

/**
 * Firestore Emulator は REST API にもセキュリティルールを適用するため、テストの検証用読み取りは
 * ルールを無視する Emulator 専用の管理者トークン(`Bearer owner`)を使う
 * (本番 Firestore はこのトークンを認識しないため、Emulator 以外では成立しない)
 */
const EMULATOR_ADMIN_HEADERS = { Authorization: 'Bearer owner' };

/** Firestore Emulator から1件のドキュメントを REST 経由で読む(存在しない場合は null) */
export async function getFirestoreDoc(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${firestoreEmulatorBaseUrl()}/${path}`, { headers: EMULATOR_ADMIN_HEADERS });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Firestore Emulator の読み取りに失敗しました(${res.status})`);
  }
  const body = (await res.json()) as { fields?: Record<string, Record<string, unknown>> };
  return unwrapFirestoreFields(body.fields ?? {});
}

/** Firestore Emulator からコレクション内の全ドキュメントを REST 経由で読む */
export async function listFirestoreDocs(path: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${firestoreEmulatorBaseUrl()}/${path}`, { headers: EMULATOR_ADMIN_HEADERS });
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    throw new Error(`Firestore Emulator の読み取りに失敗しました(${res.status})`);
  }
  const body = (await res.json()) as { documents?: { fields?: Record<string, Record<string, unknown>> }[] };
  return (body.documents ?? []).map((doc) => unwrapFirestoreFields(doc.fields ?? {}));
}
