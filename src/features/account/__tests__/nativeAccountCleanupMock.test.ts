import type native from '../../../../modules/study-sync/src/StudySyncModule';
import mock from '../../../../modules/study-sync/src/__mocks__/StudySyncModule';

afterEach(() => { jest.clearAllMocks(); });

test('native and mock expose the same three signatures', () => {
  const signatures: Pick<typeof native,
    'cleanupAccountOperation' | 'finishAccountOperation' | 'cancelAccountOperation'
  > = mock;
  expect(signatures).toBe(mock);
});

test.each(['cleanupAccountOperation', 'finishAccountOperation'] as const)(
  '%s requires an explicit result',
  async (method) => {
    await expect(mock[method]('A', 'logout', 'operation')).rejects.toThrow('not configured');
  },
);

test.each(['cleanupAccountOperation', 'finishAccountOperation'] as const)(
  '%s preserves arguments and Promise<void>',
  async (method) => {
    mock[method].mockResolvedValueOnce(undefined);
    await expect(mock[method]('A', 'delete', 'operation')).resolves.toBeUndefined();
    expect(mock[method]).toHaveBeenCalledWith('A', 'delete', 'operation');
    const failure = new Error('isolated failure');
    mock[method].mockRejectedValueOnce(failure);
    await expect(mock[method]('A', 'delete', 'operation')).rejects.toBe(failure);
  },
);

test('cancel fails by default and returns void only when configured', () => {
  expect(() => mock.cancelAccountOperation('A', 'logout', 'operation')).toThrow('not configured');
  mock.cancelAccountOperation.mockImplementationOnce(() => {});
  expect(mock.cancelAccountOperation('A', 'logout', 'operation')).toBeUndefined();
  expect(mock.cancelAccountOperation).toHaveBeenLastCalledWith('A', 'logout', 'operation');
});
