import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getFirebaseEmulatorConfig } from '../config/firebase-emulator';

/**
 * progress.txt 3-0 (problem P-013) の調査専用画面。
 *
 * P-013 の原因は、.maestro/tests/ に残っていた実際のレビュー時の再現記録(commands.json・
 * screen-hierarchy)を調べて特定した: assertVisible / extendedWaitUntil の `textRegex` は
 * Kotlin の `Regex.matches()`(完全一致。両端が暗黙に `^`〜`$` で固定される)で評価されており、
 * 部分一致ではない。失敗した全ての記録は `textRegex: "Keychain"` `textRegex: "送信:"` のように
 * `.*` で囲まずに書かれており、実際の要素のテキストは
 * 「17:04:12 開始(ライブアクティビティ表示)。送信: false(理由: ...)」のように、その語を含む
 * もっと長い1文だった(hierarchy JSON に正しく記録されていた)。そのため完全一致が一度も成立せず、
 * 8秒待っても FAILED になっていた(Maestro 側の表示判定自体にはタイミングの不具合はない)。
 *
 * この画面は、(1) 完全一致ではない短い `textRegex` が実際に失敗し続けること、
 * (2) `.*` で囲む・または testID(id セレクタ)を使えば安定して検出できることを、
 * プレフィックス・サフィックス付きの動的な行(ScrollView の末尾に state で追加)で確認するためのもの。
 * タブ・ナビゲーションには含めない。本番ビルド(Emulator に接続しない)では空の画面にする
 */
export default function DevMaestroTextProbeScreen() {
  const emulatorConfig = getFirebaseEmulatorConfig();
  const [count, setCount] = useState(0);
  // 実際の dev-lockscreen-spike と同じく、前後に文字が付いた1文としてログ行を追加する
  // (`SENT_STATUS_N` は文の一部でしかなく、文全体とは一致しない)
  const [lines, setLines] = useState<string[]>([]);

  if (!emulatorConfig) {
    return <View style={styles.container} />;
  }

  function handleAdd() {
    const next = count + 1;
    setCount(next);
    setLines((prev) => [...prev, `[${next}] SENT_STATUS_${next}(詳細情報)。送信: true`]);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Maestro テキスト判定プローブ</Text>
      <Button testID="probe-add-button" title="Add line" onPress={handleAdd} />
      <Text testID="probe-count" style={styles.count}>
        {`count: ${count}`}
      </Text>
      <Text style={styles.sectionLabel}>lines(末尾に追加・dev-lockscreen-spike と同形)</Text>
      {lines.map((line, index) => (
        <Text key={line} testID={`probe-line-${index + 1}`} style={styles.log}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'stretch',
    gap: 8,
    padding: 16,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#666666',
    marginTop: 8,
  },
  count: {
    fontSize: 14,
  },
  log: {
    fontSize: 12,
    color: '#333333',
  },
});
