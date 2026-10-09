import { fireEvent, render, screen } from '@testing-library/react-native';

import { TextField } from '@/components/TextField';

describe('TextField(3-4a デザインの土台)', () => {
  it('ラベル・値を表示し、入力で onChangeText が呼ばれる', async () => {
    const onChangeText = jest.fn();
    await render(
      <TextField
        label="目標大学"
        value="〇〇大学"
        onChangeText={onChangeText}
        testID="university-input"
        labelTestID="university-label"
      />,
    );
    expect(screen.getByTestId('university-label')).toHaveTextContent('目標大学');
    expect(screen.getByTestId('university-input').props.value).toBe('〇〇大学');

    await fireEvent.changeText(screen.getByTestId('university-input'), '△△大学');
    expect(onChangeText).toHaveBeenCalledWith('△△大学');
  });

  it('error が null でないときだけエラー文言を表示する', async () => {
    const { rerender } = await render(
      <TextField
        label="目標大学"
        value=""
        onChangeText={jest.fn()}
        error={null}
        testID="university-input"
        errorTestID="university-error"
      />,
    );
    expect(screen.queryByTestId('university-error')).toBeNull();

    await rerender(
      <TextField
        label="目標大学"
        value="長すぎる入力"
        onChangeText={jest.fn()}
        error="51文字以上は入力できません"
        testID="university-input"
        errorTestID="university-error"
      />,
    );
    expect(screen.getByTestId('university-error')).toHaveTextContent('51文字以上は入力できません');
  });
});
