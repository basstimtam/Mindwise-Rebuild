# Mindwise Rebuild

人とCodexが、構想・設計・仕事・成果物を同じ地図から扱う、個人用の制作空間です。作業場所は `C:\Users\basst\Dropbox\AI Project\16.Mindwise-Rebuild`。契約は **Mindwise Rebuild Rev 2 / ACTIVE**、製品は初期実装中です。

## 起動と停止

このフォルダで `npm start` を実行し、表示された http://127.0.0.1:4316 を開きます。Node.js 24以降が必要です。現環境はv24.13.0で確認済み。追加パッケージの導入は不要です。停止は起動した画面で Ctrl+C。

1. 最初の枝を作るか、空の画面の「ゲームのサンプルで試す」を選びます。
2. 枝の内容・領域・具体化の深さ・状態・親・日程を編集します。表示の親と、仕様の依存関係は別です。
3. 地図、階層、領域、プロセス、タスク、ガント、数値を切り替え、同じ枝の詳細を扱います。
4. 枝を選んで「Codexと制作」へ依頼します。開始時の対象と版に結び付けて実行します。
5. 制作後、結果が枝へ戻ります。「成果物を読む」で実ファイルの本文と保存時の指紋を確認できます。

## 保存とCodex

通常の保存先は `%LOCALAPPDATA%\Mindwise-Rebuild\<案件ID>\mindwise.sqlite`。Dropbox内のソースとは分けています。テキスト成果物は本フォルダの `artifacts/<実行ID>/` に保存します。DBのバックアップには外部の成果物ファイルは含まれません。

現在の接続は既存の個人用ChatGPTログインを利用する公式Codex App Serverです。既存の利用枠を消費します。API従量課金へ自動で切り替えません。この初期経路は対象文脈からテキスト成果物を制作し、枝へ接続します。任意のshell実行・既存プロジェクトファイルの自由な改変・他案件の探索はまだ提供していません。

## 現在の確認範囲

実Codexで初稿制作と、同じ会話を再開して訂正済みの仕様を使う再制作に成功。生成ファイル、指紋、枝の参照まで照合しました。`npm test` の16件も成功しています。画面の自動操作はWork設定で無効のため、実画面の見え方・操作は未検証です。

数値の式計算、共通仕様と例外の解決、確認証拠・重みを含む進捗率、MindManager交換、最終復旧と実用比較は未完成です。表示された枝数やテスト件数を全体完成率にはしません。

開発の現在地は [HANDOFF.md](HANDOFF.md)、構造と証拠の入口は [PROJECT_MAP.md](PROJECT_MAP.md)、新チャット用の貼付文は [NEXT_CHAT_PROMPT.txt](NEXT_CHAT_PROMPT.txt)。最終要件は [GOAL.md](GOAL.md)、設計は [DESIGN_STANDARD.md](DESIGN_STANDARD.md) が正本です。旧版・参照の入口は [references/README.md](references/README.md)。参照用source-snapshotは実行しません。
