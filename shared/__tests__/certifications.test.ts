import { CERTIFICATIONS, CERTIFICATION_SOURCES, getCertificationEstimate } from '../certifications';

/** gaisan-an.txt A の「出典の目安」列どおりの期待値(id, lower, upper) */
const EXPECTED: readonly [string, number | null, number][] = [
  ['it-passport', null, 100],
  ['bookkeeping-3', 50, 100],
  ['bookkeeping-2', 350, 500],
  ['fp-3', 80, 150],
  ['fp-2', 150, 300],
  ['hazardous-materials-handler-class4', 50, 100],
  ['secretary-skill-2', 30, 70],
  ['mos', 40, 80],
  ['registered-seller', 200, 300],
  ['medical-clerk', 150, 200],
  ['real-estate-transaction-specialist', 300, 400],
  ['condominium-management-business-manager', null, 300],
  ['domestic-travel-services-manager', null, 300],
  ['fundamental-information-technology-engineer', null, 200],
  ['interior-coordinator', null, 300],
  ['customs-specialist', 400, 500],
  ['condominium-manager', null, 500],
  ['administrative-scrivener', 500, 1000],
  ['labor-social-security-attorney', 800, 1000],
  ['smes-management-consultant', null, 1000],
  ['land-house-surveyor', 1000, 1500],
  ['judicial-scrivener', null, 3000],
  ['tax-accountant', null, 3000],
  ['patent-attorney', null, 3000],
  ['certified-public-accountant', null, 4000],
  ['bar-exam', 3000, 8000],
];

describe('CERTIFICATIONS', () => {
  it('26件である', () => {
    expect(CERTIFICATIONS).toHaveLength(26);
  });

  it('全26資格の lowerHours・upperHours が gaisan-an.txt の出典の目安と一致する', () => {
    const actual = CERTIFICATIONS.map(
      (c) => [c.id, c.lowerHours, c.upperHours] as [string, number | null, number],
    );
    expect(actual).toEqual(EXPECTED);
  });

  it('範囲ありの資格は lowerHours が設定されている(例: 日商簿記3級)', () => {
    const cert = getCertificationEstimate('bookkeeping-3');
    expect(cert).toMatchObject({ name: '日商簿記3級', lowerHours: 50, upperHours: 100 });
  });

  it('1つの値のみの資格は lowerHours が null(例: ITパスポート)', () => {
    const cert = getCertificationEstimate('it-passport');
    expect(cert).toMatchObject({ name: 'ITパスポート', lowerHours: null, upperHours: 100 });
  });

  it('各資格の sourceIds が CERTIFICATION_SOURCES に存在する', () => {
    for (const cert of CERTIFICATIONS) {
      expect(cert.sourceIds.length).toBeGreaterThan(0);
      for (const sourceId of cert.sourceIds) {
        expect(CERTIFICATION_SOURCES[sourceId]).toBeDefined();
        expect(CERTIFICATION_SOURCES[sourceId].url).toMatch(/^https:\/\//);
      }
    }
  });

  it('一覧にない id は RangeError(「その他」はここに含まれない)', () => {
    expect(() => getCertificationEstimate('other')).toThrow(RangeError);
    expect(() => getCertificationEstimate('')).toThrow(RangeError);
  });
});
