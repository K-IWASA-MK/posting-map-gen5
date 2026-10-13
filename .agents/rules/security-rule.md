# Security & Authentication Rule

- **Data Provisioning Security Rule**:
  - 業務データ（CSV等）は、GitHub Pages等の静的ホスティングからクライアント側で直接Fetchしてはならない。必ずGAS（`v2_api`）認証境界を経由し、適切な認可・検証を通過した状態で取得すること。

- **API Authentication & Authorization Gate (Pointer SSOT)**:
  - API エンドポイントごとの詳細な認証区分（Public Bootstrap, Dual Auth, Protected Write / 認可必須）は、正本仕様書 **[docs/api/API_CONTRACT.md](../../docs/api/API_CONTRACT.md)** および **[docs/security/SECURITY_BASELINE.md](../../docs/security/SECURITY_BASELINE.md)** を唯一の Canonical SSOT とする。
  - 本ルールでは詳細リストを重複保持せず、以下の検証関門（Security Gate）として機能させる：
    1. **Public Bootstrap Gate**: 初期描画最適化（Optimistic Load）やデバイス登録ハンドシェイクのため無認証アクセスが明示許可された API（`getTier1`, `getMapsApiKey`, `verifyManagerPassword` 等）のみが無認証呼び出しを許可される。
    2. **Dual Auth Gate**: `getSystemSummary` などの Dual-Audience API は、LIFF Token または Dashboard Session Token の有無に応じて返却スコープを動的制御し、適切なセキュリティ境界を維持する。
    3. **Protected API Gate**: 上記を除くすべての業務 API（実績登録、名簿参照、受渡要請、管理者操作等）は、有効なトークンまたはセッション認証を通過しなければならない。
  - バックエンド実装（`active/api/v2_api.js`）およびフロントエンド通信において、Canonical SSOT で規定された認証区分を逸脱・変更することは固く禁止する。
