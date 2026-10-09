/**
 * 文字サイズトークン。3-1 の既存画面の見出し(20)・本文(16)・補助(14)・エラー等の注記(13)を基準に定義する。
 * 色は colors トークンと組み合わせて使う(ここでは文字サイズ・太さのみ持つ)
 */
export const typography = {
  /** 初回起動画面のような大見出し */
  display: { fontSize: 24, fontWeight: '700' as const },
  /** ステップ画面の見出し */
  heading: { fontSize: 20, fontWeight: '700' as const },
  /** 本文・入力欄の文字 */
  body: { fontSize: 16, fontWeight: '400' as const },
  /** ラベル・行の文字 */
  label: { fontSize: 14, fontWeight: '400' as const },
  /** エラー文言・注記などの補助文字 */
  caption: { fontSize: 13, fontWeight: '400' as const },
} as const;
