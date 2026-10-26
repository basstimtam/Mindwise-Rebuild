import {createHash} from 'node:crypto';
import {mmapSourceBytes} from './mmap.mjs';

export const MAX_EXCHANGE_BYTES=6*1024*1024;
export const exchangeHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

// Archives are inert source documents. They never become mutation receipts,
// live runs, contract approvals, or filesystem read instructions.
export function inspectExchange(input,{validate,assert}) {
  assert(object(input),'交換データはオブジェクトにしてください。');
  assert(Buffer.byteLength(JSON.stringify(input))<=MAX_EXCHANGE_BYTES,'交換データは6MiB以内にしてください。',413);
  const core=structuredClone(input);delete core.archives;
  const records=input.archives??[];
  assert(Array.isArray(records)&&records.length<=100,'出所保管は100件以内にしてください。');
  function check(data) {
    assert(object(data)&&[1,2].includes(data.schemaVersion),'未対応の交換形式です。schemaVersion 1 / 2 が必要です。');
    const allowed=new Set(['schemaVersion','projectId','revision','nodes','links','runs','history','events','archiveRefs','exportedAt','backupScope','sourceDocument']);
    const unknown=Object.keys(data).filter(k=>!allowed.has(k));
    assert(!unknown.length,`未対応項目のため取込を中止: ${unknown.join(', ')}`);
    if(data.sourceDocument!==undefined)mmapSourceBytes(data.sourceDocument);
    assert(Array.isArray(data.nodes)&&data.nodes.every(n=>object(n)&&typeof n.id==='string'),'取込元の各枝には明示IDが必要です。');
    validate(structuredClone(data));
    assert(data.runs===undefined||Array.isArray(data.runs)&&data.runs.every(object),'実行記録は配列にしてください。');
    assert(data.history===undefined||Array.isArray(data.history)&&data.history.every(object),'履歴は配列にしてください。');
    assert(data.projectId===undefined||typeof data.projectId==='string'&&data.projectId.length<=160,'元案件IDが不正です。');
    assert(data.revision===undefined||Number.isSafeInteger(data.revision)&&data.revision>=0,'元保存版が不正です。');
    assert(data.exportedAt===undefined||typeof data.exportedAt==='string'&&data.exportedAt.length<=100,'書出時点が不正です。');
    assert(data.backupScope===undefined||typeof data.backupScope==='string','交換範囲が不正です。');
    assert(data.archiveRefs===undefined||Array.isArray(data.archiveRefs)&&data.archiveRefs.length<=100&&data.archiveRefs.every(digest),'出所保管の参照が不正です。');
    assert(data.events===undefined||Array.isArray(data.events)&&data.events.length<=20000,'変更の詳細は2万件以内にしてください。');
    for(const event of data.events||[]) {
      assert(object(event)&&Array.isArray(event.targets)&&event.targets.every(t=>object(t)&&typeof t.targetId==='string'&&Array.isArray(t.changes)&&t.changes.every(object)),'変更の詳細形式が不正です。');
      assert(event.context===null||event.context===undefined||object(event.context),'変更の出所形式が不正です。');
    }
    if(data.schemaVersion===2)assert(Array.isArray(data.events)&&Array.isArray(data.runs)&&Array.isArray(data.archiveRefs),'形式2には変更詳細・実行記録・保管参照が必要です。');
  }
  check(core);
  const bundles=new Map();
  for(const record of records) {
    assert(object(record)&&Object.keys(record).every(k=>['sha256','data'].includes(k))&&digest(record.sha256)&&object(record.data)&&!('archives' in record.data),'出所保管は指紋付きの平坦な記録にしてください。');
    check(record.data);
    assert(exchangeHash(record.data)===record.sha256,'出所保管の指紋が一致しません。');
    assert(!bundles.has(record.sha256),'出所保管の指紋が重複しています。');
    bundles.set(record.sha256,structuredClone(record.data));
  }
  const packageHash=exchangeHash(core);bundles.set(packageHash,core);
  for(const data of bundles.values())for(const ref of data.archiveRefs||[])assert(bundles.has(ref),'参照された出所保管が欠落しています。');
  return {core,packageHash,bundles};
}
