#!/usr/bin/env node
/**
 * Maestro E2E の実行ハーネス(`npm run e2e`)。
 *
 * - 対象シミュレータは .maestro/devices.json(機種名+iOSバージョン)で指定する。UDID はマシンごとに
 *   変わるため、実行時に `xcrun simctl list devices` から解決する(ハードコードしない)
 * - appId・接続先 URL は app.json(expo.ios.bundleIdentifier / expo.scheme)から読み、
 *   .maestro/flows/ のフローには `-e` で渡す(フロー側に直書きしない)
 * - アプリは Expo の開発ビルド(expo-dev-client。Expo Go 不可)。Debug ビルドは Metro(開発サーバー)の
 *   JS バンドルが必要なため、このスクリプトが Metro を起動し、終了時に自分が起動した PID で停止する
 *   (事前に `npx expo run:ios` 等でビルド・インストール済みであること。ビルド自体はこのスクリプトでは行わない)
 */

'use strict';

const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JSON_PATH = path.join(ROOT_DIR, 'app.json');
const DEVICES_JSON_PATH = path.join(ROOT_DIR, '.maestro', 'devices.json');
const FLOWS_DIR = path.join(ROOT_DIR, '.maestro', 'flows');
const OUTPUT_ROOT_DIR = path.join(ROOT_DIR, '.maestro', 'output');
const SCREENSHOTS_ROOT_DIR = path.join(ROOT_DIR, '.maestro', 'screenshots');

const METRO_PORT = 8081;
const METRO_READY_TIMEOUT_MS = 60_000;
const METRO_READY_POLL_MS = 1_000;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function loadAppConfig() {
  const appJson = readJson(APP_JSON_PATH);
  const bundleIdentifier = appJson?.expo?.ios?.bundleIdentifier;
  const scheme = appJson?.expo?.scheme;
  if (!bundleIdentifier || !scheme) {
    throw new Error('app.json に expo.ios.bundleIdentifier または expo.scheme がありません');
  }
  return { bundleIdentifier, scheme };
}

function loadDevices() {
  const config = readJson(DEVICES_JSON_PATH);
  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    throw new Error(`${DEVICES_JSON_PATH} に devices が定義されていません`);
  }
  return config.devices.map((device) => ({ ...device, slug: slugify(device.name) }));
}

function listSimulators() {
  const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    encoding: 'utf8',
  });
  const json = JSON.parse(raw);
  const simulators = [];
  for (const [runtime, devices] of Object.entries(json.devices)) {
    for (const device of devices) {
      simulators.push({ runtime, ...device });
    }
  }
  return simulators;
}

function resolveUdid(device, simulators) {
  const runtimeSuffix = `iOS-${device.osVersion.replace(/\./g, '-')}`;
  const match = simulators.find(
    (sim) => sim.name === device.name && sim.runtime.endsWith(runtimeSuffix)
  );
  if (!match) {
    throw new Error(
      `シミュレータ "${device.name}" (iOS ${device.osVersion}) が見つかりません。Xcode で作成してください`
    );
  }
  return match.udid;
}

function bootSimulatorIfNeeded(udid, simulators) {
  const sim = simulators.find((candidate) => candidate.udid === udid);
  if (sim && sim.state === 'Booted') {
    return;
  }
  execFileSync('xcrun', ['simctl', 'boot', udid], { stdio: 'ignore' });
  execFileSync('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: 'ignore' });
}

/** DerivedData から bundleIdentifier の一致する Debug 用シミュレータビルド(.app)を探す */
function findBuiltApp(bundleIdentifier) {
  const derivedDataDir = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  if (!fs.existsSync(derivedDataDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(derivedDataDir)) {
    const productsDir = path.join(derivedDataDir, entry, 'Build', 'Products', 'Debug-iphonesimulator');
    if (!fs.existsSync(productsDir)) {
      continue;
    }
    for (const candidate of fs.readdirSync(productsDir)) {
      if (!candidate.endsWith('.app')) {
        continue;
      }
      const appPath = path.join(productsDir, candidate);
      const infoPlistPath = path.join(appPath, 'Info.plist');
      if (!fs.existsSync(infoPlistPath)) {
        continue;
      }
      const result = spawnSync(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleIdentifier', infoPlistPath],
        { encoding: 'utf8' }
      );
      if (result.status === 0 && result.stdout.trim() === bundleIdentifier) {
        return appPath;
      }
    }
  }
  return null;
}

function installApp(udid, appPath, bundleIdentifier) {
  execFileSync('xcrun', ['simctl', 'install', udid, appPath], { stdio: 'inherit' });
  // dev-client の初回起動時に開発メニューのオンボーディング案内が画面を覆うのを防ぐ(Phase 1-1 で確認済みの方法)
  execFileSync(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'defaults',
      'write',
      bundleIdentifier,
      'EXDevMenuIsOnboardingFinished',
      '-bool',
      'YES',
    ],
    { stdio: 'ignore' }
  );
}

function waitForMetroReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: 'localhost', port: METRO_PORT, path: '/status', timeout: 2000 },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 200 && body.includes('packager-status:running')) {
              resolve();
            } else {
              retry();
            }
          });
        }
      );
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error('Metro(開発サーバー)の起動を確認できませんでした(タイムアウト)'));
        return;
      }
      setTimeout(attempt, METRO_READY_POLL_MS);
    };
    attempt();
  });
}

function startMetro() {
  return spawn('npx', ['expo', 'start', '--port', String(METRO_PORT)], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function stopMetro(metroProcess) {
  if (!metroProcess || metroProcess.exitCode !== null || metroProcess.killed) {
    return;
  }
  // 自分が起動した PID だけを指定して止める(pkill 等の名前一致での一括終了は禁止)
  metroProcess.kill('SIGTERM');
}

function runMaestro(udid, appId, devClientUrl, outputDir) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  const result = spawnSync(
    'maestro',
    [
      '--device',
      udid,
      'test',
      '-e',
      `APP_ID=${appId}`,
      '-e',
      `DEV_CLIENT_URL=${devClientUrl}`,
      '--test-output-dir',
      outputDir,
      FLOWS_DIR,
    ],
    {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Maestro は既定で匿名の利用統計を送信するため無効化する
        MAESTRO_CLI_NO_ANALYTICS: '1',
        MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
      },
    }
  );
  return result.status === 0;
}

/** Maestro の出力(.maestro/output/<device>/<timestamp>/<flow>/takeScreenshot/*.png)を
 *  確認しやすい固定パス(.maestro/screenshots/<device>/)へコピーする */
function collectScreenshots(outputDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.png') &&
        path.basename(path.dirname(fullPath)) === 'takeScreenshot'
      ) {
        found.push(fullPath);
      }
    }
  };
  if (fs.existsSync(outputDir)) {
    walk(outputDir);
  }
  for (const file of found) {
    fs.copyFileSync(file, path.join(destDir, path.basename(file)));
  }
  return found.length;
}

async function main() {
  const { bundleIdentifier, scheme } = loadAppConfig();
  const devices = loadDevices();

  const appPath = findBuiltApp(bundleIdentifier);
  if (!appPath) {
    console.error(
      `ビルド済みの .app (bundle id: ${bundleIdentifier}) が見つかりません。先に \`npx expo run:ios\` でビルド・インストールしてください`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`対象アプリ: ${appPath}`);

  for (const device of devices) {
    const simulators = listSimulators();
    const udid = resolveUdid(device, simulators);
    console.log(`${device.name} (iOS ${device.osVersion}, ${udid}) を起動・インストールします`);
    bootSimulatorIfNeeded(udid, simulators);
    installApp(udid, appPath, bundleIdentifier);
  }

  console.log('Metro(開発サーバー)を起動しています...');
  const metroProcess = startMetro();

  let allPassed = true;
  try {
    await waitForMetroReady(METRO_READY_TIMEOUT_MS);
    if (metroProcess.exitCode !== null) {
      throw new Error('Metro が起動直後に終了しました');
    }
    console.log('Metro の起動を確認しました');

    const devClientUrl = `${scheme}://expo-development-client/?url=${encodeURIComponent(
      `http://localhost:${METRO_PORT}`
    )}`;

    for (const device of devices) {
      const simulators = listSimulators();
      const udid = resolveUdid(device, simulators);
      console.log(`\n=== ${device.name} (iOS ${device.osVersion}) ===`);
      const outputDir = path.join(OUTPUT_ROOT_DIR, device.slug);
      const passed = runMaestro(udid, bundleIdentifier, devClientUrl, outputDir);
      const screenshotDir = path.join(SCREENSHOTS_ROOT_DIR, device.slug);
      const screenshotCount = collectScreenshots(outputDir, screenshotDir);
      const ok = passed && screenshotCount > 0;
      console.log(
        `${device.name}: ${ok ? 'PASS' : 'FAIL'} (screenshots: ${screenshotCount} -> ${screenshotDir})`
      );
      allPassed = allPassed && ok;
    }
  } finally {
    console.log('\nMetro(開発サーバー)を停止します...');
    stopMetro(metroProcess);
  }

  process.exitCode = allPassed ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
