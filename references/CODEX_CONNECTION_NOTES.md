# 独自画面からのCodex接続 — 候補と未検証範囲

- 出典: [OpenAI公式 Codex App Server](https://learn.chatgpt.com/docs/app-server)
- 本チャットで公式資料を読取確認。新製品での実機確認は未実施。

公式資料は独自製品へCodexを接続する経路を案内し、会話履歴、認証、承認、エージェントのイベントを扱う。これを新Mindwiseの優先接続候補とする。既存desktop画面の内部をそのまま埋め込めるという意味ではない。

地図・タスク・資料の取得と版付き変更を、アプリの共通操作口からAIへ提供する。MCP等の対応口を評価し、experimentalと記載されたdynamic toolsやWebSocketの利用を最初から必須にしない。共通データの責任をCodex側の会話ログへ移さない。

実装時に確認するのは、当PCの利用可能なCLI／プロトコル、認証と利用条件、対象の正確な受渡し、実ファイル制作の観測、承認・中断・再開、費用と文脈量。モデルのカタログ表示を利用権の証明にせず、既存アカウントの適用・無料・無制限を推測しない。

今回、Codexを起動して新会話を作ったり、認証設定・プラグイン・権限を変更したりしていない。この文書は接続候補の根拠であり、製品の成立実証ではない。

## 2026-10-25 Rev 2での再確認

公式 https://learn.chatgpt.com/docs/app-server 、 https://learn.chatgpt.com/docs/auth 、 https://learn.chatgpt.com/docs/windows/windows-sandbox を取得確認。stdioのJSONL、initialize/initialized、thread/start・resume、turn/start・interrupt、完了状態、認証状態確認の接続口を確認した。ChatGPTログインとAPIキー課金は異なる経路であり、自動切替しない。

当PCはcodex-cli 0.164.0-alpha.11.1。`codex login status` はChatGPTログインを報告。秘密値の読取・複製、ログイン変更はしていない。App Serverのhelpと生成スキーマでローカルの入力形式を確認した。生成物は.cache/protocol（派生キャッシュ、製品や契約の正本ではない）。

初回接続はstdioと構造化応答を用い、対象文脈を渡してアプリ側の検証済み変更口へ戻す。shell/既存MCP/プラグイン/hooks/ブラウザを子プロセスの設定で無効にし、environment accessを空にする。任意の外部ツール呼出は拒否する。これはWindows sandboxの広い読取を案件境界と誤認しないため。dynamicToolsはexperimentalなので初回の必須経路にしない。将来の段階取得や実行拡張は同じ変更口へ限定MCP等を接続する設計余地を残す。

この構造化制作口はテキスト成果物を新規作成する範囲。任意コードの実行・既存ファイルの書換えを完成済みとはしない。実機での受信・対象利用・現物・別セッション継続を別に検証する。
