import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { StepScreen } from '@/components/StepScreen';

describe('StepScreen(3-4a デザインの土台: ステップ画面の型)', () => {
  it('見出し・本文(子要素)を表示し、戻る・次へのコールバックが呼ばれる', async () => {
    const onBack = jest.fn();
    const onNext = jest.fn();
    await render(
      <StepScreen
        title="目標大学を入力してください"
        onBack={onBack}
        onNext={onNext}
        backTestID="back-button"
        nextTestID="next-button"
        titleTestID="title"
      >
        <Text testID="body-content">本文</Text>
      </StepScreen>,
    );

    expect(screen.getByTestId('title')).toHaveTextContent('目標大学を入力してください');
    expect(screen.getByTestId('body-content')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('back-button'));
    expect(onBack).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('next-button'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('nextDisabled のときは次へを押しても onNext が呼ばれない', async () => {
    const onNext = jest.fn();
    await render(
      <StepScreen
        title="見出し"
        onBack={jest.fn()}
        onNext={onNext}
        nextDisabled
        nextTestID="next-button"
      >
        <Text>本文</Text>
      </StepScreen>,
    );

    const button = screen.getByTestId('next-button');
    expect(button).toBeDisabled();
    await fireEvent.press(button);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('error を渡すとエラー文言を表示し、省略時(null)は表示しない', async () => {
    const { rerender } = await render(
      <StepScreen title="見出し" onBack={jest.fn()} onNext={jest.fn()} errorTestID="step-error">
        <Text>本文</Text>
      </StepScreen>,
    );
    expect(screen.queryByTestId('step-error')).toBeNull();

    await rerender(
      <StepScreen
        title="見出し"
        onBack={jest.fn()}
        onNext={jest.fn()}
        error="入力してください"
        errorTestID="step-error"
      >
        <Text>本文</Text>
      </StepScreen>,
    );
    expect(screen.getByTestId('step-error')).toHaveTextContent('入力してください');
  });

  it('showNext が false のときは次へボタンを表示しない(3-2a: 一覧タップだけで進む画面用)', async () => {
    await render(
      <StepScreen title="見出し" onBack={jest.fn()} showNext={false} nextTestID="next-button">
        <Text>本文</Text>
      </StepScreen>,
    );
    expect(screen.queryByTestId('next-button')).toBeNull();
  });

  it('nextLabel を渡すとボタンの文言が変わる', async () => {
    await render(
      <StepScreen title="見出し" onBack={jest.fn()} onNext={jest.fn()} nextLabel="OK、登録する" nextTestID="next-button">
        <Text>本文</Text>
      </StepScreen>,
    );
    expect(screen.getByTestId('next-button')).toHaveTextContent('OK、登録する');
  });
});
