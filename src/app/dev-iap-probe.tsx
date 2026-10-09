import {
  type Purchase,
  type ProductSubscription,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'expo-iap';
import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getFirebaseEmulatorConfig } from '../config/firebase-emulator';

/**
 * Phase 4-1a 技術検証専用の画面。
 * expo-iap(StoreKit 2)で、Xcode の StoreKit 設定ファイル(config/gokaku.storekit。
 * plugins/withStoreKitConfig.js が prebuild のたびにスキームへ結び付ける)から
 * 商品情報の取得・購入・復元ができることを確かめる。
 * タブ・ナビゲーションには含めない(本番の画面遷移から到達できない)。本番ビルドでは空の画面にする
 *
 * 製品ID(4-1a の提案。requirements.md 3-4 への追記案):
 * 1つのサブスクリプショングループ「Premium」に月額・年額を入れる
 */
const MONTHLY_SKU = 'com.jime0083.gokakuwatch.premium.monthly';
const YEARLY_SKU = 'com.jime0083.gokakuwatch.premium.yearly';
const SKUS = [MONTHLY_SKU, YEARLY_SKU];

export default function DevIapProbeScreen() {
  const emulatorConfig = getFirebaseEmulatorConfig();
  const [log, setLog] = useState<string[]>([]);
  const [products, setProducts] = useState<ProductSubscription[]>([]);
  const connectedRef = useRef(false);

  function appendLog(message: string) {
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${message}`, ...prev].slice(0, 30));
  }

  function logPurchase(label: string, purchase: Purchase) {
    const originalTransactionIdentifierIOS =
      'originalTransactionIdentifierIOS' in purchase
        ? purchase.originalTransactionIdentifierIOS
        : null;
    const jws = purchase.purchaseToken ?? null;
    appendLog(
      `${label}: productId=${purchase.productId} transactionId=${purchase.id} ` +
        `originalTransactionIdentifierIOS=${String(originalTransactionIdentifierIOS)} ` +
        `jws(先頭20文字)=${jws ? jws.slice(0, 20) : 'null'}`
    );
  }

  useEffect(() => {
    if (!emulatorConfig) {
      return;
    }
    const updatedSub = purchaseUpdatedListener(async (purchase) => {
      logPurchase('購入イベント', purchase);
      try {
        await finishTransaction({ purchase, isConsumable: false });
        appendLog('finishTransaction 成功');
      } catch (error) {
        appendLog(`finishTransaction 失敗: ${String(error)}`);
      }
    });
    const errorSub = purchaseErrorListener((error) => {
      appendLog(`購入エラー: code=${error.code} message=${error.message}`);
    });
    return () => {
      updatedSub.remove();
      errorSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emulatorConfig]);

  async function connect() {
    try {
      await initConnection();
      connectedRef.current = true;
      appendLog('initConnection 成功');
    } catch (error) {
      appendLog(`initConnection 失敗: ${String(error)}`);
    }
  }

  async function loadProducts() {
    try {
      if (!connectedRef.current) {
        await connect();
      }
      const result = await fetchProducts({ skus: SKUS, type: 'subs' });
      const list = result as ProductSubscription[];
      setProducts(list);
      list.forEach((product) => {
        appendLog(
          `商品: id=${product.id} displayName=${String(product.displayName)} ` +
            `displayPrice=${product.displayPrice} price=${String(product.price)} currency=${product.currency}`
        );
      });
      if (list.length === 0) {
        appendLog('商品が0件(StoreKit Configuration がスキームに設定されているか確認)');
      }
    } catch (error) {
      appendLog(`fetchProducts 失敗: ${String(error)}`);
    }
  }

  async function buy(sku: string) {
    try {
      if (!connectedRef.current) {
        await connect();
      }
      await requestPurchase({ request: { apple: { sku } }, type: 'subs' });
      appendLog(`requestPurchase 呼び出し: ${sku}(結果は購入イベントで記録)`);
    } catch (error) {
      appendLog(`requestPurchase 失敗: ${String(error)}`);
    }
  }

  async function restore() {
    try {
      if (!connectedRef.current) {
        await connect();
      }
      const purchases = await getAvailablePurchases();
      appendLog(`getAvailablePurchases: ${purchases.length}件`);
      purchases.forEach((purchase) => logPurchase('復元', purchase));
    } catch (error) {
      appendLog(`getAvailablePurchases 失敗: ${String(error)}`);
    }
  }

  if (!emulatorConfig) {
    return <View style={styles.container} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>4-1a 技術検証: expo-iap + StoreKit 設定ファイル</Text>
      <Button title="接続(initConnection)" onPress={() => void connect()} />
      <Button title="商品情報を取得(fetchProducts)" onPress={() => void loadProducts()} />
      <Button title="月額を購入(requestPurchase)" onPress={() => void buy(MONTHLY_SKU)} />
      <Button title="年額を購入(requestPurchase)" onPress={() => void buy(YEARLY_SKU)} />
      <Button title="購入を復元(getAvailablePurchases)" onPress={() => void restore()} />
      {products.map((product) => (
        <Text key={product.id} style={styles.product} testID="dev-iap-probe-product">
          {product.id}: {product.displayPrice}({product.currency})
        </Text>
      ))}
      {log.map((line, index) => (
        <Text key={`${index}-${line}`} style={styles.log} testID="dev-iap-probe-log-line">
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
    fontSize: 16,
    fontWeight: 'bold',
  },
  product: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111111',
  },
  log: {
    fontSize: 12,
    color: '#333333',
  },
});
