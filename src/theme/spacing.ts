/**
 * 余白トークン(requirements 8 非機能要件のデザイン方針に合わせ、3-1 の既存画面で
 * 実際に使われている値(paddingHorizontal 24・paddingTop 16・marginTop 32 等)を基準に定義する)。
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 40,
} as const;
