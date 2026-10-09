import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { Card } from '@/components/Card';

describe('Card(3-4a デザインの土台)', () => {
  it('子要素をそのまま表示する', async () => {
    await render(
      <Card testID="sample-card">
        <Text testID="card-child">カードの内容</Text>
      </Card>,
    );
    expect(screen.getByTestId('sample-card')).toBeOnTheScreen();
    expect(screen.getByTestId('card-child')).toHaveTextContent('カードの内容');
  });
});
