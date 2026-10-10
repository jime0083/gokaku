/**
 * URL を知っていれば誰でも呼べる HTTPS 関数(onRequest)に共通で設ける上限(5-3b-2・5-3b-3。
 * requirements 3-2「大量の呼び出しへの対策」)。
 *
 * - appleServerNotification: Apple の署名検証をリクエストボディを読んだ後にしかできないため、
 *   ユーザーごとの回数制限は使えず、同時に動くインスタンス数と本文の大きさで防ぐ(4-2a・4-2b・5-3b-2)
 * - nativeSync: デバイストークンの検証より前に本文の大きさを判定することで、不正なトークンを使った
 *   大きな本文での呼び出しも安く断る(5-3b-3)
 *
 * どちらも同じ値(本文64KB・同時10インスタンス)を使う(5-3b-3。5-3b-2 で決めた値をそのまま適用)
 */
export const PUBLIC_ENDPOINT_MAX_BODY_BYTES = 64 * 1024;
export const PUBLIC_ENDPOINT_MAX_INSTANCES = 10;
