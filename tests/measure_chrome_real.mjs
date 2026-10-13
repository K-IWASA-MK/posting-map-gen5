import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

console.log("====================================================");
console.log("🖥️ PHASE 14: CHROME REAL-BROWSER T0-T2 SLA BENCHMARK");
console.log("====================================================");

// ─── 共通ヘルパー: 統計量計算 ──────────────────────────────────
function calcStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min, max, mean, median, samples };
}

// ─── Chrome インスタンス管理クラス ─────────────────────────────
class ChromeController {
  constructor() {
    this.chromeProcess = null;
    this.profileDir = null;
    this.ws = null;
    this.msgId = 0;
    this.pendingRequests = new Map();
  }

  async start() {
    this.profileDir = path.join(os.tmpdir(), `chrome-pm-perf-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
    fs.mkdirSync(this.profileDir, { recursive: true });

    this.chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--disable-translate'
    ], { stdio: 'ignore' });

    // DevToolsActivePort 待機
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    let attempts = 0;
    while (!fs.existsSync(portFile) && attempts < 40) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    if (!fs.existsSync(portFile)) {
      throw new Error("Failed to find DevToolsActivePort within timeout");
    }

    const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    const port = lines[0];
    const wsPath = lines[1];
    const wsUrl = `ws://127.0.0.1:${port}${wsPath}`;

    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && this.pendingRequests.has(data.id)) {
        const { resolve, reject } = this.pendingRequests.get(data.id);
        this.pendingRequests.delete(data.id);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    if (this.chromeProcess) {
      this.chromeProcess.kill('SIGKILL');
      await new Promise(r => setTimeout(r, 200));
    }
    if (this.profileDir && fs.existsSync(this.profileDir)) {
      try {
        fs.rmSync(this.profileDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}

// ─── 実機測定ランナー ─────────────────────────────────────────
async function runChromeMeasurement(scenarioName, { isOnline = true, hasUserInfo = false, networkThrottling = null }, runs = 5) {
  const measurementsT2 = [];
  const measurementsFCP = [];

  const targetUrl = pathToFileURL(path.join(REPO_ROOT, 'active/h-app/index.html')).href;

  for (let r = 1; r <= runs; r++) {
    const chrome = new ChromeController();
    try {
      await chrome.start();

      // 新規ターゲット（タブ）作成
      const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });

      // Session経由のコマンドヘルパー
      const sendSession = (method, params = {}) => {
        const id = ++chrome.msgId;
        return new Promise((resolve, reject) => {
          chrome.pendingRequests.set(id, { resolve, reject });
          chrome.ws.send(JSON.stringify({ id, sessionId, method, params }));
        });
      };

      await sendSession('Page.enable');
      await sendSession('Runtime.enable');
      await sendSession('Network.enable');

      // ネットワーク条件の設定 (Offline or Throttled or Normal)
      if (!isOnline) {
        await sendSession('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0
        });
      } else if (networkThrottling) {
        await sendSession('Network.emulateNetworkConditions', {
          offline: false,
          latency: networkThrottling.latency || 300,
          downloadThroughput: networkThrottling.downloadThroughput || (1.5 * 1024 * 1024 / 8),
          uploadThroughput: networkThrottling.uploadThroughput || (750 * 1024 / 8)
        });
      }

      // 非侵入型計測スクリプトのインジェクト
      // 1. localStorage初期状態の設定 (Warm vs Cold)
      // 2. DOM監視による真のT2検知 (loading解除 & app可視化)
      // 3. Performance API による高精度記録
      const injectionScript = `
        (() => {
          window.__perfMetrics = { t2: null, fcp: null, navStart: performance.timeOrigin };
          window.__pageErrors = [];
          window.addEventListener('error', (e) => {
            window.__pageErrors.push(e.message || String(e));
          });

          // localStorage初期化
          ${hasUserInfo ? `
            localStorage.setItem('user_info', JSON.stringify({
              id: 'S001',
              last: '桑名 太郎',
              lineUserId: 'U_KUWANA_001'
            }));
          ` : `
            localStorage.clear();
            // Local file:// での未認証 Cold UI 展開を観測するための Minimal LIFF Stub
            window.liff = {
              init: () => Promise.resolve(),
              isLoggedIn: () => true,
              getAccessToken: () => 'stub_token_for_local_benchmark',
              getProfile: () => Promise.resolve({
                userId: 'U_COLD_BENCHMARK',
                displayName: 'ベンチマーク太郎',
                pictureUrl: ''
              }),
              getDecodedIDToken: () => ({ sub: 'U_COLD_BENCHMARK', name: 'ベンチマーク太郎' })
            };
          `}

          // FCP Observer
          try {
            new PerformanceObserver((entryList) => {
              for (const entry of entryList.getEntries()) {
                if (entry.name === 'first-contentful-paint') {
                  window.__perfMetrics.fcp = entry.startTime;
                }
              }
            }).observe({ type: 'paint', buffered: true });
          } catch(e) {}

          // Web Performance API (Paint Timing) fallback check
          if (!window.__perfMetrics.fcp && typeof performance.getEntriesByType === 'function') {
            const paints = performance.getEntriesByType('paint');
            const fcp = paints.find(p => p.name === 'first-contentful-paint');
            if (fcp) window.__perfMetrics.fcp = fcp.startTime;
          }

          // T2: DOM Observer（loadingの非表示化 & appの表示化）
          let t2Recorded = false;
          function checkT2() {
            if (t2Recorded) return;
            const app = document.getElementById('app');
            const loading = document.getElementById('loading');
            if (app && loading) {
              const appVisible = !app.classList.contains('hidden') && !app.classList.contains('opacity-0');
              const loadingDismissed = loading.classList.contains('hidden') || loading.classList.contains('opacity-0');
              if (appVisible && loadingDismissed) {
                t2Recorded = true;
                performance.mark('T2');
                window.__perfMetrics.t2 = performance.now();
              }
            }
          }

          const observer = new MutationObserver(checkT2);
          function startObserving() {
            if (document.documentElement) {
              try {
                observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
              } catch(e) {}
            }
          }
          if (document.documentElement) {
            startObserving();
          } else {
            document.addEventListener('readystatechange', startObserving);
          }
          window.addEventListener('DOMContentLoaded', checkT2);
        })();
      `;

      await sendSession('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });

      // ページナビゲーション開始 (T0)
      await sendSession('Page.navigate', { url: targetUrl });

      // T2 完了待機（最大3秒）
      let metrics = null;
      let lastDiag = null;
      for (let w = 0; w < 30; w++) {
        await new Promise(res => setTimeout(res, 100));
        const evalRes = await sendSession('Runtime.evaluate', {
          expression: `(() => {
            const app = document.getElementById('app');
            const loading = document.getElementById('loading');
            return {
              perf: window.__perfMetrics,
              hasConfig: !!window.PMS_CLIENT_CONFIG,
              appClass: app ? app.className : 'null',
              loadingClass: loading ? loading.className : 'null',
              errors: window.__pageErrors || []
            };
          })()`,
          returnByValue: true
        });
        if (evalRes && evalRes.result && evalRes.result.value) {
          lastDiag = evalRes.result.value;
          if (lastDiag.perf && lastDiag.perf.t2 !== null) {
            metrics = lastDiag.perf;
            break;
          }
        }
      }

      // 偽フォールバック代用を完全撤廃: 3秒以内に観測できなかった試行は MEASUREMENT_TIMEOUT として厳格に例外スロー
      if (!metrics || metrics.t2 === null || typeof metrics.t2 !== 'number') {
        const diagStr = JSON.stringify(lastDiag);
        throw new Error(`[MEASUREMENT_TIMEOUT] T2 (loading解除＋UI展開) could not be observed within 3000ms in run ${r} (${scenarioName}). Diag: ${diagStr}`);
      }

      const t2Val = metrics.t2;
      const fcpVal = typeof metrics.fcp === 'number' ? metrics.fcp : 0;

      measurementsT2.push(t2Val);
      measurementsFCP.push(fcpVal);

    } finally {
      await chrome.close();
    }
  }

  const t2Stats = calcStats(measurementsT2);
  const fcpStats = calcStats(measurementsFCP);
  return { t2Stats, fcpStats };
}

// ─────────────────────────────────────────────────────────────
// メイン測定実行部
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log("【測定環境】");
  console.log("  - ブラウザ: Google Chrome (Headless CDP / Blink Engine)");
  console.log("  - OS: macOS (Darwin)");
  console.log("  - 測定対象: active/h-app/index.html (H-App)");
  console.log("  - 測定方式: Web Performance API + CDP Script Injection (非侵入型)");
  console.log("  - 指標分離: FCP (ブラウザ標準補助指標) vs T2 (POSTING MAP固有正式指標)");

  // 1. Warm Start
  console.log("\n▶ [実機計測 1] Warm Start (有効キャッシュあり) 5回測定");
  const { t2Stats: warmT2, fcpStats: warmFCP } = await runChromeMeasurement("Warm Start", { isOnline: true, hasUserInfo: true }, 5);
  console.log(`  - 試行結果 (T2): [${warmT2.samples.map(s => s.toFixed(1) + 'ms').join(', ')}]`);
  console.log(`  - 代表値 (Median T2): ${warmT2.median.toFixed(1)} ms (SLA 目標: ≤ 200.0 ms)`);
  console.log(`  - 最大値 (Max T2): ${warmT2.max.toFixed(1)} ms (許容上限: ≤ 250.0 ms)`);
  console.log(`  - 最小値 (Min): ${warmT2.min.toFixed(1)} ms / 平均 (Mean): ${warmT2.mean.toFixed(1)} ms`);
  console.log(`  - (参考) 補助指標 FCP Median: ${warmFCP.median.toFixed(1)} ms`);

  // 2. Cold Start (LIFF/Auth 測定境界分離)
  console.log("\n▶ [測定境界分離 2] Cold Start SLA (≤ 800.0 ms)");
  console.log("  - 測定境界: LIFF認証・LINE OAuth・Backend Identity Bootstrap 必須経路");
  console.log("  - 判定: Local file:// では本番LINE OAuth/トークン交換が成立しないため、Local CDPでの偽フォールバック代用を完全撤廃。実機・本番受入プロトコル（E2E）にて実測検証。");

  // 3. Offline Start
  console.log("\n▶ [実機計測 3] Offline Start (ネットワーク切断) 5回測定");
  const { t2Stats: offlineT2, fcpStats: offlineFCP } = await runChromeMeasurement("Offline Start", { isOnline: false, hasUserInfo: true }, 5);
  console.log(`  - 試行結果 (T2): [${offlineT2.samples.map(s => s.toFixed(1) + 'ms').join(', ')}]`);
  console.log(`  - 代表値 (Median T2): ${offlineT2.median.toFixed(1)} ms (SLA 目標: ≤ 200.0 ms)`);
  console.log(`  - 最大値 (Max T2): ${offlineT2.max.toFixed(1)} ms (許容上限: ≤ 250.0 ms)`);
  console.log(`  - 最小値 (Min): ${offlineT2.min.toFixed(1)} ms / 平均 (Mean): ${offlineT2.mean.toFixed(1)} ms`);
  console.log(`  - (参考) 補助指標 FCP Median: ${offlineFCP.median.toFixed(1)} ms`);

  // 4. Weak Network Start (弱電波 3G エミュレーション: Latency 300ms, DL 1.5Mbps, UL 750kbps)
  console.log("\n▶ [実機計測 4] Weak Network Start (弱電波・3G相当環境) 5回測定");
  const { t2Stats: weakT2, fcpStats: weakFCP } = await runChromeMeasurement("Weak Network Start", {
    isOnline: true,
    hasUserInfo: true,
    networkThrottling: { latency: 300, downloadThroughput: 1.5 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 }
  }, 5);
  console.log(`  - 試行結果 (T2): [${weakT2.samples.map(s => s.toFixed(1) + 'ms').join(', ')}]`);
  console.log(`  - 代表値 (Median T2): ${weakT2.median.toFixed(1)} ms`);
  console.log(`  - 最大値 (Max T2): ${weakT2.max.toFixed(1)} ms`);
  console.log(`  - 最小値 (Min): ${weakT2.min.toFixed(1)} ms / 平均 (Mean): ${weakT2.mean.toFixed(1)} ms`);
  console.log(`  - (参考) 補助指標 FCP Median: ${weakFCP.median.toFixed(1)} ms`);
  console.log(`  - [観測評価] UI展開完了 & フリーズなし: 5/5 試行で正常にローディング解除および操作可能UIが展開`);

  // ─────────────────────────────────────────────────────────────
  // 客観的 SLA 合否判定 (数値を操作せず実測値そのまま判定)
  // ─────────────────────────────────────────────────────────────
  console.log("\n====================================================");
  console.log("📊 CHROME REAL-BROWSER SLA EVALUATION REPORT");
  console.log("====================================================");

  let warmPass = warmT2.median <= 200 && warmT2.max <= 250;
  let offlinePass = offlineT2.median <= 200 && offlineT2.max <= 250;
  const coldStatus = 'SEPARATED'; // NOT_MEASURED: Local file:// では本番LINE OAuthが成立しないため実機受入プロトコル側で実測判定

  console.log(`Warm Start SLA (≤ 200ms):    ${warmPass ? '✅ PASS' : '❌ FAIL'} (Median: ${warmT2.median.toFixed(1)}ms, Max: ${warmT2.max.toFixed(1)}ms)`);
  console.log(`Cold Start SLA (≤ 800ms):    ℹ️ ${coldStatus} / NOT_MEASURED (LIFF/Auth Production E2E Verification)`);
  console.log(`Offline Start SLA (≤ 200ms): ${offlinePass ? '✅ PASS' : '❌ FAIL'} (Median: ${offlineT2.median.toFixed(1)}ms, Max: ${offlineT2.max.toFixed(1)}ms)`);
  console.log(`Weak Network (観測記録):     ✅ STABLE (Median: ${weakT2.median.toFixed(1)}ms, Max: ${weakT2.max.toFixed(1)}ms, No Freeze)`);

  assert.ok(warmPass, `Warm Start failed SLA: Median=${warmT2.median}ms, Max=${warmT2.max}ms`);
  assert.ok(offlinePass, `Offline Start failed SLA: Median=${offlineT2.median}ms, Max=${offlineT2.max}ms`);

  console.log("\n🎉 LOCAL CHROME BENCHMARKS PASSED (Warm/Offline SLA Clear, Cold Start: NOT MEASURED HERE)");
  console.log("====================================================");
}

main().catch(err => {
  console.error("\n❌ CHROME REAL-BROWSER BENCHMARK FAILED:", err.message);
  process.exit(1);
});
