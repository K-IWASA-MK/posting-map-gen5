#!/usr/bin/env node
/**
 * POSTING MAP - Standalone Deploy Release Token Stamp Engine
 *
 * 目的:
 * H-App の全ローカルコードアセット（JS / CSS / config.js）に対し、
 * Deploy単位の単一自動Release Tokenを一括スタンプする。
 * ファイル別の手動番号（v=624等）を廃止し、実機WKWebViewキャッシュ事故を根絶する。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_HTML_PATH = path.join(REPO_ROOT, 'active/h-app/index.html');

/**
 * 必須ローカルコードアセット（Allowlist）
 * ※外部CDN（Google Fonts, LINE SDK等）および画像アセットは対象外
 */
export const REQUIRED_LOCAL_CODE_ASSETS = [
  'tailwind-utils.css',
  '../../data/config.js',
  './style.css',
  './modules/api.js',
  './modules/device.js',
  './modules/navigation.js',
  './modules/pin-status.js',
  './modules/activity.js',
  './db.js',
  './components/navigation.js',
  './components/staff.js',
  './components/ranking.js',
  './components/sync-status.js',
  '../business/area/address_master_service.js',
  './modules/storage.js',
  './modules/bulletin.js',
  './modules/transfer.js',
  './modules/ranking.js',
  './modules/staff-registration.js',
  './modules/auth.js',
  './modules/summary.js',
  './app.js',
  './render.js'
];

/**
 * Git非依存の衝突しにくいUTCタイムスタンプ（ミリ秒付与）トークン生成
 */
export function generateReleaseToken(now = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const h = pad(now.getUTCHours());
  const min = pad(now.getUTCMinutes());
  const s = pad(now.getUTCSeconds());
  const ms = pad(now.getUTCMilliseconds(), 3);
  return `${y}${m}${d}${h}${min}${s}${ms}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * HTML内の対象アセットに対し、Release Tokenを置換または追加
 */
export function stampHtml(htmlContent, token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Valid token string is required for stamping');
  }

  let updatedHtml = htmlContent;

  for (const asset of REQUIRED_LOCAL_CODE_ASSETS) {
    const escapedAsset = escapeRegex(asset);
    // (src="|href=")(asset)(?query)(")
    const regex = new RegExp(`((?:src|href)=["'])(${escapedAsset})(?:\\?([^"']*))?(["'])`, 'g');
    let matchCount = 0;

    updatedHtml = updatedHtml.replace(regex, (match, prefix, assetPath, query, quote) => {
      matchCount++;
      if (!query) {
        // tokenなし → ?v=<token> 追加
        return `${prefix}${assetPath}?v=${token}${quote}`;
      } else {
        // tokenあり → v=<token> を置換、他のクエリパラメータがあれば保持
        const params = query.split('&').filter(Boolean);
        const nonVParams = params.filter(p => !p.startsWith('v='));
        const newParams = [...nonVParams, `v=${token}`];
        return `${prefix}${assetPath}?${newParams.join('&')}${quote}`;
      }
    });

    if (matchCount === 0) {
      throw new Error(`Required local code asset not found in HTML: ${asset}`);
    }
  }

  return updatedHtml;
}

/**
 * Read-Only検証関数: 全必須アセットにtokenが存在し、かつ完全に同一か検査
 */
export function verifyAssetTokens(htmlContent) {
  const results = {};

  for (const asset of REQUIRED_LOCAL_CODE_ASSETS) {
    const escapedAsset = escapeRegex(asset);
    const regex = new RegExp(`(?:src|href)=["']${escapedAsset}(?:\\?([^"']*))?["']`);
    const match = htmlContent.match(regex);

    if (!match) {
      return {
        valid: false,
        error: `Required local code asset missing from HTML: ${asset}`
      };
    }

    const query = match[1] || '';
    const params = query.split('&').filter(Boolean);
    const vParam = params.find(p => p.startsWith('v='));
    const token = vParam ? vParam.substring(2) : null;

    if (!token) {
      return {
        valid: false,
        error: `Required local code asset has NO token: ${asset}`
      };
    }

    results[asset] = token;
  }

  const tokens = Object.values(results);
  const firstToken = tokens[0];
  const allIdentical = tokens.every(t => t === firstToken);

  if (!allIdentical) {
    const disparate = Object.entries(results).map(([a, t]) => `  - ${a}: ${t}`).join('\n');
    return {
      valid: false,
      error: `Disparate asset tokens found across required code assets:\n${disparate}`
    };
  }

  return {
    valid: true,
    token: firstToken,
    count: tokens.length
  };
}

// CLI 直接実行時の Mutation 処理
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const customToken = process.argv[2];
    const token = customToken || generateReleaseToken();

    console.log(`🚀 [Stamp Engine] Stamping H-App Release Token: ${token}`);

    const originalHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const updatedHtml = stampHtml(originalHtml, token);

    // 書き込み前に検証
    const verification = verifyAssetTokens(updatedHtml);
    if (!verification.valid) {
      throw new Error(`Post-stamp verification failed: ${verification.error}`);
    }

    fs.writeFileSync(INDEX_HTML_PATH, updatedHtml, 'utf8');
    console.log(`✅ [Stamp Engine Complete] Successfully stamped all ${verification.count} local code assets in index.html to token: ${verification.token}`);
    process.exit(0);
  } catch (err) {
    console.error(`🛑 [Hard Stop] Stamp Engine Error: ${err.message}`);
    process.exit(1);
  }
}
