/**
 * studyCheckDevOverride(5-3e-2。problem P-011 (3))のユニットテスト。
 * lockscreenSync.test.ts と同じ理由で、テスト対象を require で読み込む(jest.mock の factory が
 * 未初期化の mock 変数を参照してしまうのを避けるため)。
 *
 * StudySyncModule(ネイティブモジュール)はモックにする。isDev は各テストで明示的に渡す
 * (CLAUDE.md: __DEV__ が false なら設定を読まない仕組みを、isDev を注入できる形で確かめる)
 */
import { STUDY_CHECK_INTERVAL_MS, STUDY_CHECK_RESPONSE_WINDOW_MS } from '@shared/index';

const mockGetStudyCheckDevOverride = jest.fn<
  { intervalMs: number; responseWindowMs: number } | null,
  []
>();
const mockSetStudyCheckDevOverride = jest.fn<
  void,
  [intervalMs: number | null, responseWindowMs: number | null]
>();

jest.mock('../../../../modules/study-sync/src/StudySyncModule', () => ({
  __esModule: true,
  default: {
    getStudyCheckDevOverride: mockGetStudyCheckDevOverride,
    setStudyCheckDevOverride: mockSetStudyCheckDevOverride,
  },
}));

const {
  DEV_STUDY_CHECK_INTERVAL_MS,
  DEV_STUDY_CHECK_RESPONSE_WINDOW_MS,
  getStudyCheckTiming,
  isStudyCheckDevOverrideEnabled,
  setStudyCheckDevOverrideEnabled,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('../studyCheckDevOverride') as typeof import('../studyCheckDevOverride');

beforeEach(() => {
  mockGetStudyCheckDevOverride.mockReset().mockReturnValue(null);
  mockSetStudyCheckDevOverride.mockReset();
});

describe('getStudyCheckTiming', () => {
  it('isDev が false のときは、ネイティブに触れずに必ず本番の値(60分・10分)', () => {
    mockGetStudyCheckDevOverride.mockReturnValue({
      intervalMs: DEV_STUDY_CHECK_INTERVAL_MS,
      responseWindowMs: DEV_STUDY_CHECK_RESPONSE_WINDOW_MS,
    });
    expect(getStudyCheckTiming(false)).toEqual({
      intervalMs: STUDY_CHECK_INTERVAL_MS,
      responseWindowMs: STUDY_CHECK_RESPONSE_WINDOW_MS,
    });
    expect(mockGetStudyCheckDevOverride).not.toHaveBeenCalled();
  });

  it('isDev が true で上書き設定が無ければ本番の値', () => {
    mockGetStudyCheckDevOverride.mockReturnValue(null);
    expect(getStudyCheckTiming(true)).toEqual({
      intervalMs: STUDY_CHECK_INTERVAL_MS,
      responseWindowMs: STUDY_CHECK_RESPONSE_WINDOW_MS,
    });
  });

  it('isDev が true で上書き設定があれば、その値', () => {
    mockGetStudyCheckDevOverride.mockReturnValue({ intervalMs: 123, responseWindowMs: 45 });
    expect(getStudyCheckTiming(true)).toEqual({ intervalMs: 123, responseWindowMs: 45 });
  });

  it('isDev が true でも、上書き設定の形が不正(0 以下・非数)なら本番の値', () => {
    mockGetStudyCheckDevOverride.mockReturnValue({ intervalMs: 0, responseWindowMs: 45 });
    expect(getStudyCheckTiming(true)).toEqual({
      intervalMs: STUDY_CHECK_INTERVAL_MS,
      responseWindowMs: STUDY_CHECK_RESPONSE_WINDOW_MS,
    });
    mockGetStudyCheckDevOverride.mockReturnValue({ intervalMs: NaN, responseWindowMs: 45 });
    expect(getStudyCheckTiming(true)).toEqual({
      intervalMs: STUDY_CHECK_INTERVAL_MS,
      responseWindowMs: STUDY_CHECK_RESPONSE_WINDOW_MS,
    });
  });

  it('isDev が true でもネイティブの呼び出しが例外を投げたら本番の値', () => {
    mockGetStudyCheckDevOverride.mockImplementation(() => {
      throw new Error('native not registered');
    });
    expect(getStudyCheckTiming(true)).toEqual({
      intervalMs: STUDY_CHECK_INTERVAL_MS,
      responseWindowMs: STUDY_CHECK_RESPONSE_WINDOW_MS,
    });
  });
});

describe('setStudyCheckDevOverrideEnabled', () => {
  it('isDev が false のときは何もしない(ネイティブを呼ばない)', () => {
    setStudyCheckDevOverrideEnabled(true, false);
    expect(mockSetStudyCheckDevOverride).not.toHaveBeenCalled();
  });

  it('isDev が true・enabled=true で開発用の短い値(2分・1分)を書く', () => {
    setStudyCheckDevOverrideEnabled(true, true);
    expect(mockSetStudyCheckDevOverride).toHaveBeenCalledWith(
      DEV_STUDY_CHECK_INTERVAL_MS,
      DEV_STUDY_CHECK_RESPONSE_WINDOW_MS,
    );
  });

  it('isDev が true・enabled=false で null(本番の値に戻す)を書く', () => {
    setStudyCheckDevOverrideEnabled(false, true);
    expect(mockSetStudyCheckDevOverride).toHaveBeenCalledWith(null, null);
  });

  it('ネイティブの呼び出しが例外を投げても無視する', () => {
    mockSetStudyCheckDevOverride.mockImplementation(() => {
      throw new Error('native not registered');
    });
    expect(() => setStudyCheckDevOverrideEnabled(true, true)).not.toThrow();
  });
});

describe('isStudyCheckDevOverrideEnabled', () => {
  it('isDev が false なら常に false(ネイティブを呼ばない)', () => {
    mockGetStudyCheckDevOverride.mockReturnValue({ intervalMs: 1, responseWindowMs: 1 });
    expect(isStudyCheckDevOverrideEnabled(false)).toBe(false);
    expect(mockGetStudyCheckDevOverride).not.toHaveBeenCalled();
  });

  it('isDev が true で有効な上書き設定があれば true', () => {
    mockGetStudyCheckDevOverride.mockReturnValue({ intervalMs: 1, responseWindowMs: 1 });
    expect(isStudyCheckDevOverrideEnabled(true)).toBe(true);
  });

  it('isDev が true で上書き設定が無ければ false', () => {
    mockGetStudyCheckDevOverride.mockReturnValue(null);
    expect(isStudyCheckDevOverrideEnabled(true)).toBe(false);
  });
});
