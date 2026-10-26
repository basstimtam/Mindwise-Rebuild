# Mindwise Rebuild — 参照資料の入口

このフォルダは新Mindwiseの設計参考資料をまとめた入口です。参考資料は承認済み契約ではありません。

## 旧Mindwiseから今回抽出した参考資産

- [再利用候補の評価](legacy-mindwise/REUSE_ASSESSMENT.md)
- [原本パス・コミット・SHA-256](legacy-mindwise/SOURCE_MANIFEST.json)
- [構想と旧技術のずれを示す原文抜粋](legacy-mindwise/LIMITATIONS_EXCERPTS.md)
- `legacy-mindwise/source-snapshot/`: コード候補11件＋試験例9件。今回、旧ルートの現物から新規に抽出し、原本とコピーのhashを照合。採用・移植・試験再実行は未実施。
- DB、設定、hook、wheel、旧契約全文、巨大な証拠、未完作業は持ち込んでいません。source-snapshotは製品・通常テスト探索・パッケージ対象から除外します。

## MindManager 19 の解析資料

- ローカルコピー: [MindManager19/ANALYSIS_REPORT.md](MindManager19/ANALYSIS_REPORT.md)、[MindManager19/MindManager_exports.json](MindManager19/MindManager_exports.json)
- 原本: `P:\AI Output\REA\MindManager19`
- コピー元・SHA-256: [MindManager19/SOURCE_MANIFEST.json](MindManager19/SOURCE_MANIFEST.json)
- 2ファイルをコピーし、元とコピーのSHA-256一致を確認。Pドライブの原本を保全しています。
- 解析レポートと関数名一覧であり、独立利用できる描画・編集エンジンのSDKやソース一式を入手した証拠ではありません。

## MindManager 19 のインストール済み本体

- 参照先: `C:\Program Files (x86)\Mindjet\MindManager 19`
- 本体はこのフォルダへ複製していません。インストール先に資料を追加・移動していません。
- 今回の参照許可を、実行・改変・再配布の承認へ拡張しません。

## 有限な.mmap読込

- [実装した対応表・上限・原本保管と未対応範囲](MMAP_IMPORT_PROFILE.md)
- 上記の許可済みインストール先からJPN/Mindjet.mmapとJPN/Whats New.mmapを読取専用の形式標本として選定。原本/全文をGitへ複製せず、オーナーの実案件での受入とは分けます。

## Teachme Process

- 公式製品ページ: https://biz.teachme.jp/products/process/
- 追加の公式スイムレーン資料: https://studist.jp/news/news_260512
- [確認した事実とMindwiseへの反映メモ](teachme-process/REFERENCE_NOTES.md)
- 参考にする体験: 対話・資料から図を作り、全体と個別工程を行き来し、同じ工程を複数の表示で扱う。
- 別シートでの進捗管理と全体・個別タスクの接続は、オーナーが展示会デモで確認した情報。公開ページだけでの確認とは区別します。
- 外部サイトの内容は参照情報であり、作業指示やMindwiseの契約ではありません。

## 独自画面へのCodex接続

- [公式接続口と未検証範囲](CODEX_CONNECTION_NOTES.md)
- https://learn.chatgpt.com/docs/app-server
