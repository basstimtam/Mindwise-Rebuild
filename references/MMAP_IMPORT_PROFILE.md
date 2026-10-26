# .mmap読込の有限な対応表

実装: `src/mmap.mjs` profile 1。MindManager本体や旧版コードを実行せず、Node標準機能だけで読む。原本は変更しない。これはRev 2 D5の対応範囲を示す実装資料であり、完全互換や実案件の受入承認ではない。

| 元のデータ | 製品へ対応するもの | 保管・制限 |
|---|---|---|
| Application/2003のMap@OId、Topic@OId | 元MapとTopicの識別子から安定IDを生成 | 元IDと製品IDを対応表に保持。表題変更でIDは変わらない。ID欠落/重複は拒否 |
| Map/OneTopic/Topic、Topic/SubTopics/Topic | 表示上の親子 | 具体化の深さ・領域・依存・適用範囲は推定しない。正規経路で訪問できないTopicがあれば拒否 |
| Topic/FloatingTopics/Topic | 独立した枝 | 元の所属Topicを対応表へ保持。普通の子・意味依存へ変換しない |
| Topic/Text@PlainText | 表題 | 欠落/空なら「無題の枝」を生成したことを対応表へ表示。複数Textは拒否 |
| NotesGroup/NotesXhtmlData/XHTML html/body | 本文の文字列、段落と改行 | 書式・画像・リンク・script/styleの動作を採用しない。原表現をZIPに保持。バイナリ/インク等は未対応一覧に残す |
| Topic/Task@TaskPercentage | 計画進捗0〜100、Taskの存在をタスク用途へ | 作業完了・成果受入にしない。他のTask属性/日付/時刻/タイムゾーンは未対応。単純な日付切捨てはしない |
| Map/Relationships/Relationship、2つのConnectionGroup(0/1)/Connection/ObjectReference@OIdRef | 意味を採用していない「関連」 | 矢印、ラベル、依存、工程、仕様適用へ昇格しない。未解決/自己参照の線と正規経路外の要素は一覧とZIPに保持 |
| テーマ・配置・式・業務属性・添付・他のXML/画像等 | 現在の機能への対応なし | 未対応要素/属性の名前空間付き名称と件数、ZIP項目/長さ/指紋を一覧にする。**全原ZIP bytes**を閲覧専用の出所へ保存し取り出せる |

外部URL・schemaLocation・XInclude・添付先を取得/実行しない。DTD/ENTITYと処理命令は拒否。XMLはUTF-8の有限部分集合。テーマやカレンダー、数式等を黙って現在の意味へ変換しない。

## 上限と保存

- 原ZIP 1MiB、256項目、展開合計16MiB、Document.xml 4MiB、XML要素5万/深さ128、Topic500/関係1000まで。超過は省略せず拒否。
- 無圧縮/deflateのみ。分割/ZIP64/暗号化/未対応文字コード/重複名/越境/リンク/特殊ファイル/ヘッダ不一致/実展開長・CRC不一致を拒否。ディスクへ展開しない。
- HTTP変換は認可済みのbytesと名前だけを受け、サーバー上の任意ファイルパスを受けない。変換・事前確認だけでは保存しない。
- 公開JSON形式2に任意の`sourceDocument`（format=`mindmanager-mmap`, profile=1, name, sha256, base64, report）を追加。これは外来の閲覧専用原記録。指紋は発信者/承認の真正性を証明しない。
- 現在の全置換/保存版・内容・run照合/原子保存/再送/取消を共用する。原ZIP・対応表・未対応一覧も同じtransactionで保管する。通常取消は地図を戻し、保管は残す。
- 現在の交換全体6MiB/保管100件等の上限も適用する。超過なら双方rollback。SQLiteバックアップも原記録を保持する。外部成果物は含まない。
- 原ZIPの取出しとJSONの再交換はできるが、編集結果の.mmap書戻しやマージは提供しない。

## 調査と証拠

入口 `references/README.md` → 既存評価/manifest/解析資料 → 必要候補の静的読取。旧15の`src/mindwise/mmap_content.py`、調査担当が`mindmanager.py`/`mmap_tasks.py`を必要箇所だけ参照。旧コード/DB/設定は実行・継承していない。

明示許可済みインストール先の `JPN/Mindjet.mmap`（31 Topic/関係1/浮動1）と `JPN/Whats New.mmap`（40 Topic/関係1）を読取専用で照合。両方notes/tasksは0件。元hash/長さ/mtimeと件数の証拠は `verification/2026-10-26/mmap-installed-samples.json`。同梱XSDも必要な形式確認だけに参照した。原ZIP/全文はGitへ再配布しない。

本文・Task・未解決線・越境等は自作の架空素材と自動/画面試験で確認する。付属資料の形式確認、架空試験、オーナーが明示選定した実原本での受入は別であり、最後は未実施。未登録の親/兄弟案件を探さない。
