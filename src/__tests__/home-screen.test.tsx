import { render, screen } from '@testing-library/react-native';

import HomeScreen from '@/app/index';

describe('HomeScreen', () => {
  it('アプリ名「合格ウォッチ」を表示する', async () => {
    await render(<HomeScreen />);

    expect(screen.getByText('合格ウォッチ')).toBeOnTheScreen();
  });
});
