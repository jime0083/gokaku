/**
 * 4-2a-0 検証用のテスト専用証明書チェーン(本物の Apple のものではない)。
 *
 * openssl(ECDSA P-256)で自前に作った「ルート CA → 中間 CA → リーフ」の3枚で、
 * @apple/app-store-server-library の SignedDataVerifier が検証に必要とする
 * Apple 独自の拡張 OID(リーフ: 1.2.840.113635.100.6.11.1 / 中間: 1.2.840.113635.100.6.2.1)
 * も Apple の値を模した ASN1:NULL で入れてある(値の中身は検証されず、存在のみ見られるため)。
 *
 * 生成コマンド(再生成する場合):
 *   openssl ecparam -name prime256v1 -genkey -noout -out root.key
 *   openssl req -x509 -new -key root.key -sha256 -days 3650 \
 *     -subj "/CN=Gokaku Test Root CA (NOT APPLE)/O=Gokaku Test/C=JP" \
 *     -addext "basicConstraints=critical,CA:true" -addext "keyUsage=critical,keyCertSign,cRLSign" -out root.pem
 *   openssl ecparam -name prime256v1 -genkey -noout -out intermediate.key
 *   openssl req -new -key intermediate.key -subj "/CN=Gokaku Test Intermediate CA (NOT APPLE)/O=Gokaku Test/C=JP" -out intermediate.csr
 *   # ext_intermediate.cnf: basicConstraints=critical,CA:true / keyUsage=critical,keyCertSign,cRLSign / 1.2.840.113635.100.6.2.1=ASN1:NULL
 *   openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root.key -CAcreateserial -days 3650 -sha256 -extfile ext_intermediate.cnf -out intermediate.pem
 *   openssl ecparam -name prime256v1 -genkey -noout -out leaf.key
 *   openssl req -new -key leaf.key -subj "/CN=Gokaku Test Leaf Signer (NOT APPLE)/O=Gokaku Test/C=JP" -out leaf.csr
 *   # ext_leaf.cnf: basicConstraints=critical,CA:false / keyUsage=critical,digitalSignature / 1.2.840.113635.100.6.11.1=ASN1:NULL
 *   openssl x509 -req -in leaf.csr -CA intermediate.pem -CAkey intermediate.key -CAcreateserial -days 3650 -sha256 -extfile ext_leaf.cnf -out leaf.pem
 *
 * 有効期限は2036年まで。それ以降に差し替える場合は上のコマンドで作り直す。
 */

/** ルート CA 証明書(DER, base64)。SignedDataVerifier の appleRootCertificates に渡す Buffer の元 */
export const TEST_ROOT_CA_DER_BASE64 =
  'MIIB/zCCAaWgAwIBAgIUFDrittal+YI6P+CI63VwYCzBmYAwCgYIKoZIzj0EAwIwTTEoMCYGA1UEAwwfR29rYWt1IFRlc3QgUm9vdCBDQSAoTk9UIEFQUExFKTEUMBIGA1UECgwLR29rYWt1IFRlc3QxCzAJBgNVBAYTAkpQMB4XDTI2MTAwOTEzMTk1M1oXDTM2MTAwNjEzMTk1M1owTTEoMCYGA1UEAwwfR29rYWt1IFRlc3QgUm9vdCBDQSAoTk9UIEFQUExFKTEUMBIGA1UECgwLR29rYWt1IFRlc3QxCzAJBgNVBAYTAkpQMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEs8K/ABsUOqnbxAshK4ZqEuYIKEsaxgyhVfL5cIQfsEmEp7KRiCc4YMAYjxOUUVy7IjjNgOiV6duZQiQEUwwxTKNjMGEwHQYDVR0OBBYEFO1hX9oByNS/TRAWGxSew0BLBTvvMB8GA1UdIwQYMBaAFO1hX9oByNS/TRAWGxSew0BLBTvvMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIAr2pcG92RvHJ0q0txiL9YIrh61ZOg8PcyeOe9endhutAiEA62K5WXsyl1r1acpu631/axYV3qKjXvZJCWR5VrkVEJE=';

/** 中間 CA 証明書(DER, base64)。JWT の x5c ヘッダーの2番目の要素に入れる */
export const TEST_INTERMEDIATE_CA_DER_BASE64 =
  'MIICGjCCAb+gAwIBAgIUMVzkL1Nnk4qCxqyra/co0V1TuyEwCgYIKoZIzj0EAwIwTTEoMCYGA1UEAwwfR29rYWt1IFRlc3QgUm9vdCBDQSAoTk9UIEFQUExFKTEUMBIGA1UECgwLR29rYWt1IFRlc3QxCzAJBgNVBAYTAkpQMB4XDTI2MTAwOTEzMjAwMFoXDTM2MTAwNjEzMjAwMFowVTEwMC4GA1UEAwwnR29rYWt1IFRlc3QgSW50ZXJtZWRpYXRlIENBIChOT1QgQVBQTEUpMRQwEgYDVQQKDAtHb2tha3UgVGVzdDELMAkGA1UEBhMCSlAwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASwcjvHwc6+2NokOueUX4dTTTIEcf4WjeEJt4Uo91PtfdzRYjidHoF7ZcemiAcDbwXlD6+zoegTXMIdQPiRmKoUo3UwczAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAQBgoqhkiG92NkBgIBBAIFADAdBgNVHQ4EFgQUZIo4gvXYdIPkPSiBLJwcctlYwjUwHwYDVR0jBBgwFoAU7WFf2gHI1L9NEBYbFJ7DQEsFO+8wCgYIKoZIzj0EAwIDSQAwRgIhALSJj9gwBbStQynzETLxgaXHS6okfKSmOT0C866jsQe7AiEAhZcKG79hCcRpeUxTN1GlvJwIYrjnBCuGX6TiZb6CDRs=';

/** リーフ(署名者)証明書(DER, base64)。JWT の x5c ヘッダーの1番目の要素に入れる */
export const TEST_LEAF_CERT_DER_BASE64 =
  'MIICGjCCAcCgAwIBAgIULlrDVjd1Mr8EL/fMIttL2tI7qxowCgYIKoZIzj0EAwIwVTEwMC4GA1UEAwwnR29rYWt1IFRlc3QgSW50ZXJtZWRpYXRlIENBIChOT1QgQVBQTEUpMRQwEgYDVQQKDAtHb2tha3UgVGVzdDELMAkGA1UEBhMCSlAwHhcNMjYxMDA5MTMyMDA3WhcNMzYxMDA2MTMyMDA3WjBRMSwwKgYDVQQDDCNHb2tha3UgVGVzdCBMZWFmIFNpZ25lciAoTk9UIEFQUExFKTEUMBIGA1UECgwLR29rYWt1IFRlc3QxCzAJBgNVBAYTAkpQMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEju+3zDPFJUOxl8OZooMUVkZt48Sd1r0gH2j94JCYF6alWl1nErvhQ1i/VxBHOoErkrg+zENZA49Q4AaTQGseO6NyMHAwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEAYKKoZIhvdjZAYLAQQCBQAwHQYDVR0OBBYEFJSJE3RX1KptyVjkWxbC52dPSpqnMB8GA1UdIwQYMBaAFGSKOIL12HSD5D0ogSycHHLZWMI1MAoGCCqGSM49BAMCA0gAMEUCIByKQ8mV3nV0xEbNtobFaB4a/vgH+jMnl5bydEdrPlqXAiEA83/oMNxHgP2Y5n21ZAvmNP4yr4nGYgeS15Crdo3QAog=';

/**
 * リーフ証明書に対応する秘密鍵(EC P-256, SEC1 PEM)。
 * このテストファイル用に openssl で新規生成したものだけで、Apple や本番のどの鍵とも無関係。
 * JWT に署名して SignedDataVerifier の検証を試すためだけに使う
 */
export const TEST_LEAF_PRIVATE_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIPK2gHzTQ6iqHUu3XRE6noDvgU9GcmPbRGwrv3GNOeIZoAoGCCqGSM49
AwEHoUQDQgAEju+3zDPFJUOxl8OZooMUVkZt48Sd1r0gH2j94JCYF6alWl1nErvh
Q1i/VxBHOoErkrg+zENZA49Q4AaTQGseOw==
-----END EC PRIVATE KEY-----
`;

/** 上の3枚とは無関係な、別のテスト専用ルート CA(DER, base64)。「信頼していないルート」のテストに使う */
export const TEST_OTHER_ROOT_CA_DER_BASE64 =
  'MIICCjCCAbGgAwIBAgIUErnQR1tc2xwQJ2+Rm26Kw5BZY6UwCgYIKoZIzj0EAwIwUzEuMCwGA1UEAwwlR29rYWt1IFRlc3QgT1RIRVIgUm9vdCBDQSAoTk9UIEFQUExFKTEUMBIGA1UECgwLR29rYWt1IFRlc3QxCzAJBgNVBAYTAkpQMB4XDTI2MTAwOTEzMjA0NVoXDTM2MTAwNjEzMjA0NVowUzEuMCwGA1UEAwwlR29rYWt1IFRlc3QgT1RIRVIgUm9vdCBDQSAoTk9UIEFQUExFKTEUMBIGA1UECgwLR29rYWt1IFRlc3QxCzAJBgNVBAYTAkpQMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIAjYdyJZ8lBgRhXB2ngNHzLXT/7eNmYOAH7KFjdfQJpe0QovkLlHKnvAyFu+oDnxXOz9iQUsFuGN6SE+l77EO6NjMGEwHQYDVR0OBBYEFDghLekOyMTm5ypL0Xbp7WRxB7oXMB8GA1UdIwQYMBaAFDghLekOyMTm5ypL0Xbp7WRxB7oXMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0cAMEQCICJaOkn9o8mXHZeLYPcWY5yBjVvwEuq6HRuiGNG/2R9uAiAzkntBj6vFO5PsC5owMK9Bq48t8hcAoPEZI4+SgA8RJw==';
