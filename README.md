# ope-note — 手術記録アプリ

ローカル完結型の手術記録アプリ（PWA）。患者データは端末内の IndexedDB のみに保存され、外部への通信は一切行わない。

## 設計方針

- **Macがマスタ、iPhoneは入力端末**。iPhoneのブラウザストレージは消失リスクがあるため、入力後は速やかにMacへAirDrop送信する運用とする
- デバイス間転送はJSON、Excel連携はxlsx/CSV
- 各記録はUUIDで識別し、マージ時の重複登録を防ぐ

## 動作確認（開発時）

```bash
cd ~/Developer/ope-note
python3 -m http.server 8000
```

ブラウザで http://localhost:8000 を開く。
（`index.html` をダブルクリックして file:// で開いても動作するが、ブラウザによってIndexedDBが制限される場合があるためローカルサーバー推奨）

## データ構造

### records ストア（keyPath: uuid）

手術日 / 患者ID / 年齢 / 身長(heightCm) / 体重(weightKg) / 性別 / 左右 / 疾患名 / Crowe分類 / 執刀医 / アプローチ /
手術時間 / 出血量 /
Cup商品名(cupName) / Cupサイズ(cupSize) / Liner(linerType) /
Stem商品名(stemName) / Stemサイズ(stemSize) / Headサイズ(headSize) / Head素材(headMaterial) /
Navigation /
Navigation RI・RA / 実測 RI・RA / メモ / 手術記録 /
uuid / createdAt / updatedAt / createdDevice / syncedAt

- **Cup / Stem**: 商品名（選択式マスタ）＋サイズ（Cupは数字、Stemは数字＋文字の自由記載）
- **Head**: サイズ（数字の自由記載）＋素材（選択式マスタ `headMaterial`）。※旧 `headType`（単一select）は廃止
- **Liner**: 選択式（変更なし）

### masterOptions ストア（keyPath: id, autoIncrement）

category / value / sortOrder / isActive

カテゴリ: sex, side, diagnosis, crowe, surgeon, approach, cup, liner, stem, headMaterial, navigation

## ロードマップ

- [x] **Phase 1**: カード型入力フォーム＋IndexedDB保存＋一覧＋マスタ設定画面
- [x] **Phase 2**: JSONエクスポート（共有シート/AirDrop）、JSON/xlsx/CSVインポート＋UUIDマージ、xlsxエクスポート
- [x] **Phase 3**: Service Worker（オフライン化）＋GitHub Pages配置 → iPhoneで「ホーム画面に追加」
- [ ] **Phase 4**（任意）: PINロック、未送信件数バッジ、症例数集計、自動バックアップ

## ファイル構成

- `index.html` — 画面構造（入力/一覧/データ/設定の4ビュー）
- `app.js` — ロジック（IndexedDB、フォーム、一覧、マスタ管理、入出力）
- `style.css` — FileMaker風カードUI（モバイルファースト）
- `vendor/xlsx.full.min.js` — SheetJS 0.20.3（Excel/CSV処理。ローカル同梱で外部通信なし）
- `manifest.webmanifest` — PWAマニフェスト（ホーム画面追加用）
- `sw.js` — Service Worker（全ファイルをプリキャッシュしオフライン動作。ファイル更新時は `CACHE_VERSION` を上げる）
- `icons/` — アプリアイコン（apple-touch-icon 180px / 192px / 512px / maskable）

## 配信とインストール（Phase 3）

- **URL**: https://totanfu30.github.io/ope-note/
- GitHub Pages（`main` ブランチ直下）で配信。リポジトリにはコードのみが含まれ、患者データは一切含まれない（データは各端末の IndexedDB のみ）
- **iPhoneへのインストール**: Safariで上記URLを開く → 共有ボタン → 「ホーム画面に追加」。以後はオフラインでも起動・入力できる
- **アプリの更新手順**: ファイルを編集 → `sw.js` の `CACHE_VERSION` を上げる → commit & push。端末側は次回オンライン起動時に新バージョンを取得（反映はアプリ再起動後）

## データ入出力の仕様（Phase 2）

- **JSONエクスポート**: 未送信分のみ／全件バックアップの2種。共有シート対応環境（iPhone）では共有シート→AirDrop、非対応環境はダウンロード。未送信分は送信成功後に `syncedAt` を付与
- **JSONインポート**: `app: "ope-note"` のファイルのみ受理。UUIDでマージ（新規追加／`updatedAt` が新しければ更新／同じならスキップ）。マスタ選択肢も不足分のみ追加
- **Excel/CSVインポート**: 1行目を見出しとしてエイリアス表で列をマッピング。日付はExcelシリアル値・`2026/6/1`・`2026-06-01`等を自動正規化。CSVはUTF-8→失敗時Shift-JISの順で自動判別。「手術日＋患者ID＋左右」が一致する既存記録はスキップ。出現した未登録の選択肢はマスタへ自動追加。Excel由来の記録は送信済み扱い（未送信に積まない）
- **Excelエクスポート**: 全件を `.xlsx`（列順固定・日本語見出し）で書き出し。**Cup/Stem/Headはアプリ上は分割入力だが、Excelでは1セルに結合して出力**（cup=商品名＋サイズ / stem=商品名＋サイズ / head=サイズ＋素材、半角スペース区切り）。Linerは単独列。なお結合Excelを再取り込みすると分割は復元できない（商品名側にまとめて入る）ため、ロスレスな復元はJSONバックアップを使うこと
- **BMI**: 記録には保存せず身長・体重から都度計算（フォームはリアルタイム表示、Excel書き出しには計算値を出力、インポート時のBMI列は無視して再計算）
- **暗号化バックアップ（iCloud保存用）**: 「データ」タブの「全件を暗号化して書き出し」。Web Crypto（PBKDF2 250k回 + AES-256-GCM）でパスワード暗号化した `.json`（`{app:"ope-note", enc:"aes-gcm", salt, iv, ct}` 形式）を出力。外部ライブラリ不使用・通信なし。**復元は「取り込み」に同ファイルをドロップ → パスワード入力で復号 → 通常のUUIDマージへ**。改ざんはGCM認証タグで検知。パスワードを忘れると復号不可。iCloudの高度なデータ保護(E2EE)が未設定でも、ファイル自体が暗号化されているためクラウド漏洩時に中身を読めない
