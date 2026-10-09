/**
 * 配色トークン(requirements 8 非機能要件: 白基調+ブルー系のアクセントカラー、
 * 進捗はブルーに調和するグリーン系。3-4a でデザインの土台として整える)。
 * キー名は 3-1 の既存画面と互換を保つ(background/primary/primaryDisabled/text/textSecondary/error/border)。
 */
export const colors = {
  /** 白基調の背景 */
  background: '#FFFFFF',
  /** カード・行など、背景より一段沈める薄いグレー */
  surface: '#F3F5F8',
  /** メインのブルー */
  primary: '#2563EB',
  /** 主要ボタン押下時のやや濃いブルー(副ボタンの枠線にも使う) */
  primaryPressed: '#1D4ED8',
  /** 無効状態のブルー */
  primaryDisabled: '#93C5FD',
  /** primary の背景の上に乗る文字色 */
  onPrimary: '#FFFFFF',
  /** 積み上げ時間の進捗(ブルーに調和するグリーン系) */
  progress: '#16A34A',
  /** 進捗バーの背景(淡いグリーン) */
  progressTrack: '#DCFCE7',
  /** エラー */
  error: '#DC2626',
  /** 本文の文字色 */
  text: '#111827',
  /** 補助文字色 */
  textSecondary: '#6B7280',
  /** 境界線 */
  border: '#E5E7EB',
} as const;
