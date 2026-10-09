import { AppStoreServerAPIClient, Environment, SignedDataVerifier } from '@apple/app-store-server-library';

import { getAppleRootCertificates } from './appleRootCertificates';
import {
  APPLE_IAP_APP_APPLE_ID,
  APPLE_IAP_BUNDLE_ID,
  APPLE_IAP_ISSUER_ID,
  APPLE_IAP_KEY_ID,
  APPLE_IAP_SIGNING_KEY,
} from './config';

/**
 * 4-2a/4-2b 共通: 本番(Apple との実通信・署名検証)の API クライアント・検証器を作る。
 * verifyApplePurchase(購入の確認)・appleServerNotification(契約の変化の通知)の両方から使う
 * (requirements 3-4)。
 */

export type AppleEnvironmentName = 'PRODUCTION' | 'SANDBOX';

export function toAppleLibraryEnvironment(environment: AppleEnvironmentName): Environment {
  return environment === 'PRODUCTION' ? Environment.PRODUCTION : Environment.SANDBOX;
}

/** 本物の Apple App Store Server API クライアント(環境ごとに固定) */
export function createAppleApiClient(environment: AppleEnvironmentName): AppStoreServerAPIClient {
  return new AppStoreServerAPIClient(
    APPLE_IAP_SIGNING_KEY.value(),
    APPLE_IAP_KEY_ID.value(),
    APPLE_IAP_ISSUER_ID.value(),
    APPLE_IAP_BUNDLE_ID,
    toAppleLibraryEnvironment(environment),
  );
}

/**
 * 本物の Apple SignedDataVerifier(環境ごとに固定。enableOnlineChecks は本番なので true)。
 * verifyAndDecodeTransaction・verifyAndDecodeNotification の両方に使える
 */
export function createAppleSignedDataVerifier(environment: AppleEnvironmentName): SignedDataVerifier {
  return new SignedDataVerifier(
    getAppleRootCertificates(),
    true,
    toAppleLibraryEnvironment(environment),
    APPLE_IAP_BUNDLE_ID,
    environment === 'PRODUCTION' ? APPLE_IAP_APP_APPLE_ID.value() : undefined,
  );
}
