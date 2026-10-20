import { useRef, useState } from 'react';
import { Button, ScrollView, Text } from 'react-native';

const HEX_64 = /^[0-9a-f]{64}$/;
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const FAILURE_MESSAGE = '失敗: nonceの検証を完了できませんでした。';

export default function DevAccountSpikeScreen() {
  if (!__DEV__) {
    return null;
  }
  return <AccountNonceProbe />;
}

function AccountNonceProbe() {
  const runningRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function runProbe() {
    if (!__DEV__ || runningRef.current) {
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setResult(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createAppleNonce } = require('../features/account/appleNonce') as typeof import('../features/account/appleNonce');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Crypto = require('expo-crypto') as typeof import('expo-crypto');

      const first = await createAppleNonce();
      const second = await createAppleNonce();
      const knownDigest = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        'abc',
        { encoding: Crypto.CryptoEncoding.HEX },
      );
      const valid =
        [first.rawNonce, first.hashedNonce, second.rawNonce, second.hashedNonce].every(
          (value) => HEX_64.test(value),
        ) &&
        first.rawNonce !== first.hashedNonce &&
        second.rawNonce !== second.hashedNonce &&
        first.rawNonce !== second.rawNonce &&
        first.hashedNonce !== second.hashedNonce &&
        knownDigest === SHA256_ABC;

      setResult(valid ? 'PASS' : FAILURE_MESSAGE);
    } catch {
      setResult(FAILURE_MESSAGE);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text>6-4spikeA nonce native probe</Text>
      <Button
        testID="account-nonce-probe-run"
        title="nonceを検証"
        disabled={running}
        onPress={() => void runProbe()}
      />
      {result !== null && (
        <Text testID="account-nonce-probe-result">{result}</Text>
      )}
      <AppleAvailabilityProbe />
    </ScrollView>
  );
}

function AppleAvailabilityProbe() {
  const runningRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  async function runProbe() {
    if (!__DEV__ || runningRef.current) {
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setAvailable(null);
    setFailed(false);

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AppleAuthentication = require('expo-apple-authentication') as typeof import('expo-apple-authentication');
      const result = await AppleAuthentication.isAvailableAsync();
      setAvailable(result);
    } catch {
      setFailed(true);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  return (
    <>
      <Text>6-4spikeB Apple native availability probe</Text>
      <Button
        testID="account-apple-availability-run"
        title="Apple認証の利用可否を確認"
        disabled={running}
        onPress={() => void runProbe()}
      />
      {available !== null && (
        <Text testID="account-apple-availability-result">{String(available)}</Text>
      )}
      {failed && (
        <Text testID="account-apple-availability-error">
          失敗: Apple認証の利用可否を確認できませんでした。
        </Text>
      )}
    </>
  );
}
