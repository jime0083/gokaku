import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import type { AccountAction, AccountActionFlowResult } from './accountActionFlow';

export type AccountActionPopupProps = Readonly<{
  action: AccountAction;
  /** Resolve with the authoritative checkpoint state even when the flow fails. */
  perform: () => Promise<{ result: AccountActionFlowResult; retryOnly: boolean }>;
  onCancel: () => void;
  onComplete: () => void;
  openSubscriptionManagement: () => Promise<void>;
  /** Supply true when reopening an unfinished durable operation. */
  retryOnly?: boolean;
}>;

const communicationError = '通信できませんでした。電波の良い場所で再度お試しください';

function failureMessage(result: Extract<AccountActionFlowResult, { status: 'incomplete' }>) {
  if (result.reason === 'measuring') return '計測中です。先にタイマーを停止してから再試行してください';
  if (result.reason === 'unknown-owner') return '端末データの所属アカウントを確認できませんでした。再試行してください';
  return communicationError;
}

export function AccountActionPopup({
  action, perform, onCancel, onComplete, openSubscriptionManagement, retryOnly = false,
}: AccountActionPopupProps) {
  const mounted = useRef(true);
  const working = useRef(false);
  const completed = useRef(false);
  const locked = useRef(retryOnly);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [checkpointPending, setCheckpointPending] = useState(retryOnly);
  const [actionError, setActionError] = useState<string | null>(null);
  const [managementFailed, setManagementFailed] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const retryRequired = retryOnly || checkpointPending;
  const unavailable = busy || finished;

  function cancel() {
    if (!mounted.current || working.current || completed.current || retryOnly || locked.current) return;
    onCancel();
  }

  async function run(target: 'account' | 'management') {
    if (!mounted.current || working.current || completed.current) return;
    if (target === 'management' && (retryOnly || locked.current)) return;
    working.current = true;
    setBusy(true);
    if (target === 'account') setActionError(null);
    else setManagementFailed(false);
    try {
      if (target === 'management') {
        await openSubscriptionManagement();
      } else {
        const outcome = await perform();
        if (!mounted.current) return;
        locked.current = outcome.retryOnly;
        setCheckpointPending(outcome.retryOnly);
        if (outcome.result.status === 'complete') {
          completed.current = true;
          setFinished(true);
          onComplete();
        } else {
          setActionError(failureMessage(outcome.result));
        }
      }
    } catch {
      if (!mounted.current) return;
      if (target === 'management') {
        setManagementFailed(true);
      } else {
        // A rejected adapter gives no authoritative checkpoint state. Fail closed.
        locked.current = true;
        setCheckpointPending(true);
        setActionError(communicationError);
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <View testID="account-action-popup" style={styles.backdrop} onAccessibilityEscape={cancel}>
    <View style={styles.popup} accessibilityViewIsModal>
      <ScrollView testID="account-action-scroll" contentContainerStyle={styles.content}>
        <Text style={styles.title}>{action === 'logout' ? 'ログアウトしますか？' : 'アカウントを削除しますか？'}</Text>
        <Text style={styles.body}>{action === 'logout'
          ? 'ログアウトしても、クラウドの目標・履歴は保持されます。端末の記録・入力・トークン・送信待ちは消去されます。'
          : 'アカウントと関連する全データ・Xのトークンを削除します。'}</Text>
        {action === 'delete' ? <>
          <Text style={styles.body}>アカウント削除だけではAppleの定期課金は停止しません</Text>
          <PrimaryButton title="サブスクリプションの管理" variant="secondary" testID="account-subscription"
            disabled={unavailable || retryRequired} onPress={() => void run('management')} />
          {managementFailed ? <>
            <ErrorText testID="account-management-error" message={`サブスクリプションの管理画面を開けませんでした。${communicationError}`} />
            <PrimaryButton title="管理画面を再試行" variant="secondary" testID="account-management-retry"
              disabled={unavailable || retryRequired} onPress={() => void run('management')} />
          </> : null}
        </> : null}
        {retryRequired ? <Text style={styles.body}>処理が完了していません。再試行して完了してください。</Text> : null}
        <ErrorText testID="account-action-error" message={actionError} />
        <PrimaryButton title={actionError || retryRequired ? '再試行' : action === 'logout' ? 'ログアウト' : 'アカウントを削除'}
          testID="account-action-submit" disabled={unavailable} onPress={() => void run('account')} />
        <PrimaryButton title="キャンセル" variant="secondary" testID="account-action-cancel"
          disabled={unavailable || retryRequired} onPress={cancel} />
        {busy ? <Text style={styles.body}>処理中...</Text> : null}
      </ScrollView>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', padding: spacing.md },
  popup: { maxHeight: '95%', flexShrink: 1, backgroundColor: colors.background, borderRadius: radius.lg, overflow: 'hidden' },
  content: { padding: spacing.md, gap: spacing.md },
  title: { ...typography.heading, color: colors.text, textAlign: 'center' },
  body: { ...typography.body, color: colors.text },
});
