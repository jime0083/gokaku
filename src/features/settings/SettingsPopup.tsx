import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { CONTACT_URL } from '@/config/legalLinks';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';

import type { LoadedSettings } from './settings';
import { openSettingsLink, type SettingsLink } from './settingsLinks';
import { loadSettings, updateSettings } from './settingsRepository';

type Action = 'load' | 'save' | SettingsLink;

export function SettingsPopup({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<LoadedSettings | null>(null);
  const [busy, setBusy] = useState(true);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [failedAction, setFailedAction] = useState<Action | null>(null);

  const run = useCallback(async (action: Action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailedAction(null);
    try {
      if (action === 'load') {
        const loaded = await loadSettings();
        if (mounted.current) setDraft(loaded);
      } else if (action === 'save') {
        if (!draft) return;
        await updateSettings(draft.uid, { checkEnabled: draft.checkEnabled, xPostEnabled: draft.xPostEnabled });
        if (mounted.current) onSaved();
      } else {
        await openSettingsLink(action);
      }
    } catch {
      if (mounted.current) setFailedAction(action);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [draft, onSaved]);

  // Load once per opening. A failed read never creates a default draft.
  useEffect(() => {
    mounted.current = true;
    busyRef.current = true;
    const load = async () => {
      try {
        const loaded = await loadSettings();
        if (mounted.current) setDraft(loaded);
      } catch {
        if (mounted.current) setFailedAction('load');
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    };
    void load();
    return () => { mounted.current = false; };
  }, []);

  return <View testID="settings-popup" style={settingsPopupStyles.backdrop}>
    <View style={settingsPopupStyles.popup} accessibilityViewIsModal>
      <Text style={settingsPopupStyles.title}>設定とリンク</Text>
      <ScrollView testID="settings-scroll" contentContainerStyle={settingsPopupStyles.content}>
        {draft ? <>
          <View style={settingsPopupStyles.row}>
            <Text style={settingsPopupStyles.label}>「勉強中？」確認</Text>
            <Switch testID="settings-check-toggle" accessibilityLabel="「勉強中？」確認" value={draft.checkEnabled}
              disabled={busy} onValueChange={(checkEnabled) => setDraft({ ...draft, checkEnabled })} />
          </View>
          <Text style={settingsPopupStyles.note}>変更は次回開始の計測から反映されます</Text>
          <View style={settingsPopupStyles.row}>
            <Text style={settingsPopupStyles.label}>X投稿</Text>
            <Switch testID="settings-x-toggle" accessibilityLabel="X投稿" value={draft.xPostEnabled}
              disabled={busy} onValueChange={(xPostEnabled) => setDraft({ ...draft, xPostEnabled })} />
          </View>
        </> : busy ? <Text style={settingsPopupStyles.label}>読み込み中...</Text> : null}
        <PrimaryButton title="サブスクリプションの管理" variant="secondary" testID="settings-subscription"
          disabled={busy} onPress={() => void run('subscription')} />
        <PrimaryButton title="利用規約" variant="secondary" testID="settings-terms"
          disabled={busy} onPress={() => void run('terms')} />
        <PrimaryButton title="プライバシーポリシー" variant="secondary" testID="settings-privacy"
          disabled={busy} onPress={() => void run('privacy')} />
        <PrimaryButton title={CONTACT_URL ? 'お問い合わせ' : 'お問い合わせ（準備中）'} variant="secondary"
          testID="settings-contact" disabled={busy || !CONTACT_URL} onPress={() => void run('contact')} />
        {failedAction ? <>
          <ErrorText testID="settings-error" message="通信できませんでした。電波の良い場所で再度お試しください" />
          <PrimaryButton title="再試行" testID="settings-retry" disabled={busy} onPress={() => void run(failedAction)} />
        </> : null}
        <PrimaryButton title="保存" testID="settings-save" disabled={busy || !draft} onPress={() => void run('save')} />
        <PrimaryButton title="キャンセル" variant="secondary" testID="settings-cancel" disabled={busy}
          onPress={onCancel} />
      </ScrollView>
    </View>
  </View>;
}

export const settingsPopupStyles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', padding: spacing.md },
  popup: { maxHeight: '95%', flexShrink: 1, backgroundColor: colors.background, borderRadius: radius.lg, overflow: 'hidden' },
  title: { color: colors.text, fontSize: 18, fontWeight: 'bold', padding: spacing.md, textAlign: 'center' },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: colors.text, fontSize: 16, flexShrink: 1 },
  note: { color: colors.textSecondary, fontSize: 14 },
});
