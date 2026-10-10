import { act, cleanup, renderRouter, screen, waitFor } from 'expo-router/testing-library';

/** ホーム画面(6-1 で本実装するまでの仮の画面)が /home で表示されることの最小確認 */
describe('ホーム画面(仮。5-1a)', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('「ホーム(準備中)」と表示される', async () => {
    await act(async () => {
      renderRouter('src/app', { initialUrl: '/home' });
    });

    await waitFor(() => screen.getByTestId('home-placeholder-text'));
    expect(screen.getByTestId('home-placeholder-text')).toHaveTextContent('ホーム(準備中)');
  });
});
