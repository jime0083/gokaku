import { render, screen } from '@testing-library/react-native';

import { ProgressBar } from '@/components/ProgressBar';

function fillWidth(testID: string): unknown {
  const fill = screen.getByTestId(`${testID}-fill`);
  const style = Array.isArray(fill.props.style) ? Object.assign({}, ...fill.props.style) : fill.props.style;
  return style.width;
}

describe('ProgressBar(requirements 4-6: バーは100%で満タン)', () => {
  it('0 は幅 0%', async () => {
    await render(<ProgressBar testID="bar" ratio={0} />);
    expect(fillWidth('bar')).toBe('0%');
  });

  it('0.5 は幅 50%', async () => {
    await render(<ProgressBar testID="bar" ratio={0.5} />);
    expect(fillWidth('bar')).toBe('50%');
  });

  it('1 は幅 100%', async () => {
    await render(<ProgressBar testID="bar" ratio={1} />);
    expect(fillWidth('bar')).toBe('100%');
  });

  it('1 を超える値は 100% に収める(あふれない)', async () => {
    await render(<ProgressBar testID="bar" ratio={1.5} />);
    expect(fillWidth('bar')).toBe('100%');
  });

  it('負の値は 0% に収める', async () => {
    await render(<ProgressBar testID="bar" ratio={-0.5} />);
    expect(fillWidth('bar')).toBe('0%');
  });
});
