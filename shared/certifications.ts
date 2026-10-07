/**
 * 資格の必要勉強時間の概算データ(requirements 4-3、mokuhyo.txt 2)。
 *
 * - 一覧・時間は gaisan-an.txt の「出典の目安」列(2026-10-07 承認。「表示値(案)」列は使わない)
 * - 2つの出典で数値が違う場合は、新しい [F] を採用した(gaisan-an.txt A の注記のとおり)
 * - 表示: 出典に範囲があれば「約下限〜上限時間」、1つの値なら「約○時間」(lowerHours が null の場合)
 * - 目標勉強時間の初期値は上限(resolveInitialTargetHours を使う。estimatedHours.ts)
 * - 「その他」はこの一覧に含まない(概算なし。requirements 4-3)
 */

export type CertificationSourceId = 'F' | 'T';

export type CertificationSource = {
  /** 出典の表示名 */
  name: string;
  /** 出典のURL */
  url: string;
  /** 出典の更新日(YYYY-MM-DD) */
  updatedAt: string;
};

/** 出典(gaisan-an.txt A の出典一覧) */
export const CERTIFICATION_SOURCES: Readonly<Record<CertificationSourceId, CertificationSource>> = {
  F: {
    name: 'フォーサイト「3ヶ月で取れるおすすめ資格10選」',
    url: 'https://www.foresight.jp/media/study-time/',
    updatedAt: '2026-08-02',
  },
  T: {
    name: '資格Times「資格取得に必要な勉強時間ランキング」',
    url: 'https://shikakutimes.jp/topics/2623',
    updatedAt: '2024-09-13',
  },
};

export type CertificationEstimate = {
  /** 資格ID(Firestore の goals.certId) */
  id: string;
  /** 表示名 */
  name: string;
  /** 下限(時間)。出典が1つの値のみの場合は null(上限のみ表示) */
  lowerHours: number | null;
  /** 上限(時間)。lowerHours が null の場合、表示・初期値に使う唯一の値 */
  upperHours: number;
  /** この資格の時間の採用元(gaisan-an.txt A の「出典」列) */
  sourceIds: readonly CertificationSourceId[];
};

/** 承認済みの資格一覧(gaisan-an.txt A。26件。並び順も出典の表の順) */
export const CERTIFICATIONS: readonly CertificationEstimate[] = [
  { id: 'it-passport', name: 'ITパスポート', lowerHours: null, upperHours: 100, sourceIds: ['F', 'T'] },
  { id: 'bookkeeping-3', name: '日商簿記3級', lowerHours: 50, upperHours: 100, sourceIds: ['F'] },
  { id: 'bookkeeping-2', name: '日商簿記2級', lowerHours: 350, upperHours: 500, sourceIds: ['T'] },
  { id: 'fp-3', name: 'FP3級', lowerHours: 80, upperHours: 150, sourceIds: ['F'] },
  { id: 'fp-2', name: 'FP2級', lowerHours: 150, upperHours: 300, sourceIds: ['T'] },
  {
    id: 'hazardous-materials-handler-class4',
    name: '危険物取扱者 乙4',
    lowerHours: 50,
    upperHours: 100,
    sourceIds: ['F'],
  },
  { id: 'secretary-skill-2', name: '秘書検定2級', lowerHours: 30, upperHours: 70, sourceIds: ['F'] },
  { id: 'mos', name: 'MOS', lowerHours: 40, upperHours: 80, sourceIds: ['T'] },
  { id: 'registered-seller', name: '登録販売者', lowerHours: 200, upperHours: 300, sourceIds: ['F'] },
  { id: 'medical-clerk', name: '医療事務', lowerHours: 150, upperHours: 200, sourceIds: ['F'] },
  {
    id: 'real-estate-transaction-specialist',
    name: '宅地建物取引士',
    lowerHours: 300,
    upperHours: 400,
    sourceIds: ['F'],
  },
  {
    id: 'condominium-management-business-manager',
    name: '管理業務主任者',
    lowerHours: null,
    upperHours: 300,
    sourceIds: ['F', 'T'],
  },
  {
    id: 'domestic-travel-services-manager',
    name: '国内旅行業務取扱管理者',
    lowerHours: null,
    upperHours: 300,
    sourceIds: ['F'],
  },
  {
    id: 'fundamental-information-technology-engineer',
    name: '基本情報技術者',
    lowerHours: null,
    upperHours: 200,
    sourceIds: ['T'],
  },
  {
    id: 'interior-coordinator',
    name: 'インテリアコーディネーター',
    lowerHours: null,
    upperHours: 300,
    sourceIds: ['T'],
  },
  { id: 'customs-specialist', name: '通関士', lowerHours: 400, upperHours: 500, sourceIds: ['T'] },
  {
    id: 'condominium-manager',
    name: 'マンション管理士',
    lowerHours: null,
    upperHours: 500,
    sourceIds: ['T'],
  },
  { id: 'administrative-scrivener', name: '行政書士', lowerHours: 500, upperHours: 1000, sourceIds: ['T'] },
  {
    id: 'labor-social-security-attorney',
    name: '社会保険労務士',
    lowerHours: 800,
    upperHours: 1000,
    sourceIds: ['T'],
  },
  {
    id: 'smes-management-consultant',
    name: '中小企業診断士',
    lowerHours: null,
    upperHours: 1000,
    sourceIds: ['T'],
  },
  {
    id: 'land-house-surveyor',
    name: '土地家屋調査士',
    lowerHours: 1000,
    upperHours: 1500,
    sourceIds: ['T'],
  },
  { id: 'judicial-scrivener', name: '司法書士', lowerHours: null, upperHours: 3000, sourceIds: ['T'] },
  { id: 'tax-accountant', name: '税理士', lowerHours: null, upperHours: 3000, sourceIds: ['T'] },
  { id: 'patent-attorney', name: '弁理士', lowerHours: null, upperHours: 3000, sourceIds: ['T'] },
  {
    id: 'certified-public-accountant',
    name: '公認会計士',
    lowerHours: null,
    upperHours: 4000,
    sourceIds: ['T'],
  },
  { id: 'bar-exam', name: '司法試験', lowerHours: 3000, upperHours: 8000, sourceIds: ['T'] },
];

const CERTIFICATIONS_BY_ID: ReadonlyMap<string, CertificationEstimate> = new Map(
  CERTIFICATIONS.map((certification) => [certification.id, certification]),
);

/** certId から資格の概算データを求める。一覧にない id(「その他」等)は RangeError */
export function getCertificationEstimate(certId: string): CertificationEstimate {
  const certification = CERTIFICATIONS_BY_ID.get(certId);
  if (!certification) {
    throw new RangeError(`一覧にない資格ID です(「その他」は概算を出しません): ${certId}`);
  }
  return certification;
}
