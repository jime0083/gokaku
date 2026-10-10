/**
 * 計測の sessionId(開始時に1つ)と、送信操作ごとの idempotencyKey(5-1b-2)を作る。
 *
 * サーバー(functions/src/studySession/recordStudyEvent.ts の SAFE_ID_PATTERN)が受け付ける形
 * ^[A-Za-z0-9_-]{1,128}$ に合う文字だけを使う。暗号的な強度は不要(他のユーザーに予測されても
 * 困らない。実在する sessionId かどうかはサーバー側で本人の goalId と紐づけて検査する)なため、
 * 新しいライブラリ(uuid・expo-crypto 等)を追加せず、Date.now() と Math.random() から作る。
 * 衝突を避けるため、時刻(ミリ秒)に加えて複数回ランダム値を混ぜる
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function randomSegment(): string {
  // Math.random() の 36進表現(0.xxxxxx の "0." を取り除いた部分)。[0-9a-z] のみになる
  return Math.random().toString(36).slice(2);
}

/** sessionId・idempotencyKey として使う ID を1つ作る */
export function generateLocalId(): string {
  const id = `${Date.now().toString(36)}-${randomSegment()}-${randomSegment()}`;
  if (!SAFE_ID_PATTERN.test(id)) {
    // 上の生成方法は常にこのパターンに合う文字列になるはずのため、実際には起きない想定の保険
    throw new Error(`生成した ID がサーバーの許容する形式に合いません: ${id}`);
  }
  return id;
}
