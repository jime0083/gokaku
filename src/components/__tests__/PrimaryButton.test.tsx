import { fireEvent, render, screen } from '@testing-library/react-native';

import { PrimaryButton } from '@/components/PrimaryButton';

describe('PrimaryButton(3-4a デザインの土台)', () => {
  it('既定(primary)は押せて onPress が呼ばれる', async () => {
    const onPress = jest.fn();
    await render(<PrimaryButton title="次へ" onPress={onPress} testID="next-button" />);
    await fireEvent.press(screen.getByTestId('next-button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('disabled のときは押しても onPress が呼ばれない', async () => {
    const onPress = jest.fn();
    await render(<PrimaryButton title="次へ" onPress={onPress} disabled testID="next-button" />);
    const button = screen.getByTestId('next-button');
    expect(button).toBeDisabled();
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('variant=secondary でも押せて onPress が呼ばれる', async () => {
    const onPress = jest.fn();
    await render(
      <PrimaryButton title="サブ操作" variant="secondary" onPress={onPress} testID="sub-button" />,
    );
    await fireEvent.press(screen.getByTestId('sub-button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('variant=secondary の disabled は押しても onPress が呼ばれない', async () => {
    const onPress = jest.fn();
    await render(
      <PrimaryButton
        title="サブ操作"
        variant="secondary"
        disabled
        onPress={onPress}
        testID="sub-button"
      />,
    );
    const button = screen.getByTestId('sub-button');
    expect(button).toBeDisabled();
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
