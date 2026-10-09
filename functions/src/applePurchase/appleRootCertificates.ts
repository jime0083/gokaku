/**
 * 4-2a: SignedDataVerifier(@apple/app-store-server-library)に渡す Apple のルート証明書(公開情報)。
 *
 * ライブラリ自体にはルート証明書が同梱されていないため(README「Obtaining Apple Root Certificates」参照)、
 * Apple PKI のページから取得して埋め込む。テスト用の証明書チェーン(appleTestCertChain.ts)と同じ方式
 * (DER を base64 にして定数に埋め込む)で、ビルド成果物へのファイルコピー漏れを避ける。
 *
 * 出典: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (2026-10-09 取得)
 * SHA-256: 63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179
 * (StoreKit 2 / App Store Server API の署名(JWS)の x5c チェーンが終端するルート。
 *  Apple PKI ページの「Apple Root CA - G3 Root」)
 *
 * 本物の Apple 発行の JWS(本番の鍵。W6/8-2 待ち)での検証はまだ行っていないため、
 * このルート証明書が実際に有効かは 8-2 で本番接続する際に確認する
 */
export const APPLE_ROOT_CA_G3_DER_BASE64 =
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';

/** SignedDataVerifier に渡すルート証明書(Buffer 配列) */
export function getAppleRootCertificates(): Buffer[] {
  return [Buffer.from(APPLE_ROOT_CA_G3_DER_BASE64, 'base64')];
}
