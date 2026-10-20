import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';

import { AccountActionPopup, type AccountActionPopupProps } from '../AccountActionPopup';
import type { AccountActionFlowResult } from '../accountActionFlow';

type Outcome = Awaited<ReturnType<AccountActionPopupProps['perform']>>;
const complete: Outcome = { result: { status: 'complete' }, retryOnly: false };
const communicationError = '通信できませんでした。電波の良い場所で再度お試しください';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function props(overrides: Partial<AccountActionPopupProps> = {}) {
  return {
    action: 'delete' as const,
    perform: jest.fn<Promise<Outcome>, []>().mockResolvedValue(complete),
    onCancel: jest.fn(),
    onComplete: jest.fn(),
    openSubscriptionManagement: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    ...overrides,
  };
}
afterEach(async () => { await cleanup(); });

it('shows logout retention confirmation and cancels without performing', async () => {
  const p = props({ action: 'logout' });
  await render(<AccountActionPopup {...p} />);
  expect(screen.getByText('ログアウトしますか？')).toBeTruthy();
  expect(screen.getByText(/クラウドの目標・履歴は保持されます/)).toBeTruthy();
  expect(screen.queryByTestId('account-subscription')).toBeNull();
  await fireEvent.press(screen.getByTestId('account-action-cancel'));
  expect(p.onCancel).toHaveBeenCalledTimes(1);
  expect(p.perform).not.toHaveBeenCalled();
  expect(p.onComplete).not.toHaveBeenCalled();
});

it.each(['logout', 'delete'] as const)('completes %s only after verified success and ignores later presses', async (action) => {
  const p = props({ action });
  await render(<AccountActionPopup {...p} />);
  if (action === 'delete') {
    expect(screen.getByText('アカウント削除だけではAppleの定期課金は停止しません')).toBeTruthy();
  }
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(p.onComplete).toHaveBeenCalledTimes(1);
  expect(p.openSubscriptionManagement).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await fireEvent.press(screen.getByTestId('account-action-cancel'));
  expect(p.perform).toHaveBeenCalledTimes(1);
  expect(p.onCancel).not.toHaveBeenCalled();
});

it('disables all operations and ignores repeated calls while performing', async () => {
  const pending = deferred<Outcome>();
  const p = props({ perform: jest.fn(() => pending.promise) });
  await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  for (const id of ['account-action-submit', 'account-action-cancel', 'account-subscription']) {
    expect(screen.getByTestId(id)).toBeDisabled();
    await fireEvent.press(screen.getByTestId(id));
  }
  await fireEvent(screen.getByTestId('account-action-popup'), 'accessibilityEscape');
  expect(p.perform).toHaveBeenCalledTimes(1);
  expect(p.onCancel).not.toHaveBeenCalled();
  expect(p.openSubscriptionManagement).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(complete); });
  expect(p.onComplete).toHaveBeenCalledTimes(1);
});

const reasons: Extract<AccountActionFlowResult, { status: 'incomplete' }>['reason'][] = [
  'measuring', 'unknown-owner', 'pending-records', 'retry-required', 'busy', 'uid-changed', 'checkpoint-conflict',
];
it.each(reasons)('shows the correct %s failure and retries without completing prematurely', async (reason) => {
  const perform = jest.fn<Promise<Outcome>, []>()
    .mockResolvedValueOnce({ result: { status: 'incomplete', reason }, retryOnly: false })
    .mockResolvedValueOnce(complete);
  const p = props({ perform });
  await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  const message = reason === 'measuring' ? '計測中です。先にタイマーを停止してから再試行してください'
    : reason === 'unknown-owner' ? '端末データの所属アカウントを確認できませんでした。再試行してください'
      : communicationError;
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.getByTestId('account-action-cancel')).not.toBeDisabled();
  expect(p.onComplete).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(perform).toHaveBeenCalledTimes(2);
  expect(p.onComplete).toHaveBeenCalledTimes(1);
});

it('permits cancellation and accessibility escape before a cloud checkpoint', async () => {
  const p = props({ perform: jest.fn().mockResolvedValue({
    result: { status: 'incomplete', reason: 'pending-records' }, retryOnly: false,
  }) });
  await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await fireEvent.press(screen.getByTestId('account-action-cancel'));
  await fireEvent(screen.getByTestId('account-action-popup'), 'accessibilityEscape');
  expect(p.onCancel).toHaveBeenCalledTimes(2);
  expect(p.onComplete).not.toHaveBeenCalled();
});

it.each([false, true])('allows only retry with a durable checkpoint (initial=%s)', async (initial) => {
  const perform = jest.fn<Promise<Outcome>, []>()
    .mockResolvedValueOnce({ result: { status: 'incomplete', reason: 'retry-required' }, retryOnly: true })
    .mockResolvedValueOnce(complete);
  const p = props({ perform, retryOnly: initial });
  await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  expect(screen.getByTestId('account-subscription')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('account-action-cancel'));
  await fireEvent.press(screen.getByTestId('account-subscription'));
  await fireEvent(screen.getByTestId('account-action-popup'), 'accessibilityEscape');
  expect(p.onCancel).not.toHaveBeenCalled();
  expect(p.openSubscriptionManagement).not.toHaveBeenCalled();
  expect(p.onComplete).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(p.onComplete).toHaveBeenCalledTimes(1);
});

it('blocks cancellation immediately when opened with a checkpoint', async () => {
  const p = props({ retryOnly: true });
  await render(<AccountActionPopup {...p} />);
  expect(screen.getByText('再試行')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('account-action-cancel'));
  await fireEvent.press(screen.getByTestId('account-subscription'));
  await fireEvent(screen.getByTestId('account-action-popup'), 'accessibilityEscape');
  expect(p.onCancel).not.toHaveBeenCalled();
  expect(p.perform).not.toHaveBeenCalled();
  expect(p.openSubscriptionManagement).not.toHaveBeenCalled();
});

it('fails closed on an unexpected rejected perform and can retry', async () => {
  const p = props({ perform: jest.fn<Promise<Outcome>, []>()
    .mockRejectedValueOnce(new Error('unknown checkpoint')).mockResolvedValueOnce(complete) });
  await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(screen.getByText(communicationError)).toBeTruthy();
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  expect(p.onComplete).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(p.onComplete).toHaveBeenCalledTimes(1);
});

it('retries management independently, never forces deletion, and permits deletion after link failure', async () => {
  const management = jest.fn<Promise<void>, []>()
    .mockRejectedValueOnce(new Error('link')).mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('link again'));
  const p = props({ openSubscriptionManagement: management });
  await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-subscription'));
  expect(screen.getByTestId('account-management-error')).toBeTruthy();
  expect(screen.queryByTestId('account-action-error')).toBeNull();
  expect(p.perform).not.toHaveBeenCalled();
  expect(p.onComplete).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('account-management-retry'));
  expect(management).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('account-management-error')).toBeNull();
  expect(p.perform).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('account-subscription'));
  expect(screen.getByTestId('account-action-submit')).not.toBeDisabled();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(p.perform).toHaveBeenCalledTimes(1);
  expect(p.onComplete).toHaveBeenCalledTimes(1);
});

it('preserves account failure when management fails and retries only management', async () => {
  const p = props({
    perform: jest.fn().mockResolvedValue({ result: { status: 'incomplete', reason: 'measuring' }, retryOnly: false }),
    openSubscriptionManagement: jest.fn().mockRejectedValue(new Error('link')),
  });
  await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await fireEvent.press(screen.getByTestId('account-subscription'));
  await fireEvent.press(screen.getByTestId('account-management-retry'));
  expect(screen.getByTestId('account-action-error')).toHaveTextContent(/先にタイマーを停止/);
  expect(screen.getByTestId('account-management-error')).toBeTruthy();
  expect(p.perform).toHaveBeenCalledTimes(1);
  expect(p.onComplete).not.toHaveBeenCalled();
});

it('disables deletion and cancellation while management is opening', async () => {
  const pending = deferred<void>();
  const p = props({ openSubscriptionManagement: jest.fn(() => pending.promise) });
  await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-subscription'));
  await fireEvent.press(screen.getByTestId('account-subscription'));
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await fireEvent.press(screen.getByTestId('account-action-cancel'));
  expect(p.openSubscriptionManagement).toHaveBeenCalledTimes(1);
  expect(p.perform).not.toHaveBeenCalled();
  expect(p.onCancel).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(undefined); });
  expect(screen.getByTestId('account-action-submit')).not.toBeDisabled();
});

it.each(['complete', 'incomplete', 'reject'] as const)('ignores late %s after unmount', async (settlement) => {
  const pending = deferred<Outcome>();
  const p = props({ perform: jest.fn(() => pending.promise) });
  const view = await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await view.unmount();
  await act(async () => {
    if (settlement === 'reject') pending.reject(new Error('late'));
    else pending.resolve(settlement === 'complete' ? complete : {
      result: { status: 'incomplete', reason: 'unknown-owner' }, retryOnly: true,
    });
  });
  expect(p.onComplete).not.toHaveBeenCalled();
  expect(p.onCancel).not.toHaveBeenCalled();
});

it('ignores a late management rejection after unmount', async () => {
  const pending = deferred<void>();
  const p = props({ openSubscriptionManagement: jest.fn(() => pending.promise) });
  const view = await render(<AccountActionPopup {...p} />);
  await fireEvent.press(screen.getByTestId('account-subscription'));
  await view.unmount();
  await act(async () => { pending.reject(new Error('late link')); });
  expect(p.perform).not.toHaveBeenCalled();
  expect(p.onComplete).not.toHaveBeenCalled();
});
