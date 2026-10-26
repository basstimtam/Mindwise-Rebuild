import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';

// This reader never extracts entries or resolves URLs/schema locations. It accepts
// a bounded ZIP/XML profile, not the complete MindManager document format.
export const MMAP_LIMITS=Object.freeze({bytes:1024*1024,entries:256,expanded:16*1024*1024,document:4*1024*1024,elements:50000,depth:128,topics:500,relationships:1000});
const AP='http://schemas.mindjet.com/MindManager/Application/2003',XHTML='http://www.w3.org/1999/xhtml';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function requireValue(ok,message){if(!ok){const error=new Error(message);error.status=400;throw error;}}
const utf8=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{requireValue(false,'UTF-8として読み取れません。この文字コードは未対応です。');}};
const crcTable=Uint32Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
export function crc32(bytes){let value=0xffffffff;for(const b of bytes)value=crcTable[(value^b)&255]^(value>>>8);return (value^0xffffffff)>>>0;}

export function readMmapZip(bytes) {
 requireValue(Buffer.isBuffer(bytes)&&bytes.length<=MMAP_LIMITS.bytes&&bytes.length>=22,'.mmapは1MiB以下の非暗号化ZIPにしてください。');
 const span=(offset,length)=>requireValue(Number.isSafeInteger(offset)&&length>=0&&offset>=0&&offset+length<=bytes.length,'ZIPの境界が不正です。');
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 requireValue(end>=0,'ZIP終端がありません。');
 requireValue(bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&bytes.readUInt16LE(end+8)===bytes.readUInt16LE(end+10),'分割ZIPは未対応です。');
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
 requireValue(count>0&&count<=MMAP_LIMITS.entries&&offset!==0xffffffff&&size!==0xffffffff,'ZIP64またはZIP件数上限256件超過です。');
 requireValue(offset+size===end,'ZIP中央ディレクトリの境界が不正です。');span(offset,size);
 const records=[],names=new Set(),ranges=[];let cursor=offset,total=0;
 for(let i=0;i<count;i++) {
  span(cursor,46);requireValue(cursor+46<=end&&bytes.readUInt32LE(cursor)===0x02014b50,'ZIP中央ヘッダが不正です。');
  const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),expanded=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),disk=bytes.readUInt16LE(cursor+34),attrs=bytes.readUInt32LE(cursor+38),local=bytes.readUInt32LE(cursor+42);
  requireValue(!(flags&1)&&!(flags&~0x080e),'暗号化または未対応のZIPフラグです。');requireValue([0,8].includes(method),'未対応のZIP圧縮方式です。');
  requireValue(disk===0&&![compressed,expanded,local].includes(0xffffffff),'分割ZIP/ZIP64は未対応です。');
  const next=cursor+46+nameLength+extraLength+commentLength;requireValue(next<=end,'ZIP項目が中央ディレクトリを越えています。');
  const nameBytes=bytes.subarray(cursor+46,cursor+46+nameLength);requireValue(flags&0x800||nameBytes.every(b=>b<128),'UTF-8以外のZIPファイル名は未対応です。');
  const name=utf8(nameBytes),directory=name.endsWith('/'),parts=(directory?name.slice(0,-1):name).split('/');
  requireValue(name.length>0&&name.length<=1000&&!/[\\:\x00-\x1f]/.test(name)&&parts.every(p=>p&&p!=='.'&&p!=='..'),'ZIP内に越境または曖昧なパスがあります。');
  const mode=(attrs>>>16)&0xf000;requireValue([0,0x8000,0x4000].includes(mode)&&(mode!==0x4000||directory)&&(mode!==0x8000||!directory),'ZIP内のリンク/特殊ファイルは未対応です。');
  requireValue(!names.has(name.toLowerCase()),'ZIP内のファイル名が重複しています。');names.add(name.toLowerCase());
  total+=expanded;requireValue(total<=MMAP_LIMITS.expanded&&expanded<=MMAP_LIMITS.expanded,'ZIP展開上限16MiBを超えています。');
  if(name==='Document.xml')requireValue(expanded<=MMAP_LIMITS.document,'Document.xmlは4MiB以内にしてください。');
  span(local,30);requireValue(local+30<=offset&&bytes.readUInt32LE(local)===0x04034b50,'ZIPローカルヘッダが不正です。');
  const ln=bytes.readUInt16LE(local+26),le=bytes.readUInt16LE(local+28),start=local+30+ln+le,finish=start+compressed;
  requireValue(bytes.readUInt16LE(local+6)===flags&&bytes.readUInt16LE(local+8)===method&&ln===nameLength&&bytes.subarray(local+30,local+30+ln).equals(nameBytes),'ZIP中央/ローカルヘッダが一致しません。');
  requireValue(finish<=offset,'ZIPデータが中央ディレクトリを越えています。');
  let rangeEnd=finish;
  if(flags&8){let p=finish;span(p,12);if(bytes.readUInt32LE(p)===0x08074b50)p+=4;span(p,12);requireValue(bytes.readUInt32LE(p)===crc&&bytes.readUInt32LE(p+4)===compressed&&bytes.readUInt32LE(p+8)===expanded,'ZIPデータ記述子が一致しません。');rangeEnd=p+12;}
  else requireValue(bytes.readUInt32LE(local+14)===crc&&bytes.readUInt32LE(local+18)===compressed&&bytes.readUInt32LE(local+22)===expanded,'ZIP長さ/CRCの宣言が一致しません。');
  requireValue(rangeEnd<=offset,'ZIP項目の境界が不正です。');ranges.push([local,rangeEnd]);records.push({name,directory,crc,compressed,expanded,start,method});cursor=next;
 }
 requireValue(cursor===end,'ZIP中央ディレクトリに未対応のデータがあります。');
 ranges.sort((a,b)=>a[0]-b[0]);requireValue(ranges[0][0]===0&&ranges.every((r,i)=>!i||r[0]>=ranges[i-1][1]),'ZIP項目が重複または先頭に未対応のデータがあります。');
 const entries=new Map();
 for(const record of records){const input=bytes.subarray(record.start,record.start+record.compressed);let output;
  if(record.method===0){requireValue(record.compressed===record.expanded,'無圧縮ZIPの長さが一致しません。');output=input;}
  else {let result;try{result=inflateRawSync(input,{maxOutputLength:Math.max(1,record.expanded),info:true});}catch{requireValue(false,'ZIP圧縮データが破損しているか、宣言した展開長を超えています。');}requireValue(result.engine.bytesWritten===input.length,'ZIP圧縮データに余分な内容があります。');output=result.buffer;}
  requireValue(output.length===record.expanded&&crc32(output)===record.crc,'ZIPの実展開長またはCRCが一致しません。');requireValue(!record.directory||output.length===0,'ZIPディレクトリに内容があります。');entries.set(record.name,{...record,bytes:output});
 }
 requireValue(entries.has('Document.xml'),'Document.xmlがありません。暗号化または未対応形式です。');return entries;
}

const xmlChar=n=>n===9||n===10||n===13||n>=32&&n<=0xd7ff||n>=0xe000&&n<=0xfffd||n>=0x10000&&n<=0x10ffff;
function entities(text){requireValue(!text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,'').includes('&'),'未定義のXML実体参照です。');return text.replace(/&([^;]+);/g,(_,v)=>{const known={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(v in known)return known[v];const n=v.startsWith('#x')?parseInt(v.slice(2),16):Number(v.slice(1));requireValue(xmlChar(n),'XML文字参照が不正です。');return String.fromCodePoint(n);});}
// A deliberately strict XML subset with namespaces, ordered mixed content,
// comments and CDATA; no DTD, custom entities, XInclude or processing execution.
export function readMmapXml(bytes){
 let source=utf8(bytes).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');for(const c of source)requireValue(xmlChar(c.codePointAt(0)),'XMLに無効な文字があります。');
 source=source.replace(/^<\?xml[ \t\n]+version=["']1\.0["'](?:[ \t\n]+encoding=["'][Uu][Tt][Ff]-8["'])?(?:[ \t\n]+standalone=["'](?:yes|no)["'])?[ \t\n]*\?>/,'');
 const document={children:[],parts:[],ns:Object.assign(Object.create(null),{xml:'http://www.w3.org/XML/1998/namespace'})},stack=[document];let cursor=0,count=0;
 const namePattern=/[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/y,whitespace=/[ \t\n]*/y,equality=/[ \t\n]*=[ \t\n]*(["'])/y,closing=/<\/([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)[ \t\n]*>/y;
 const matchAt=pattern=>{pattern.lastIndex=cursor;return pattern.exec(source);};
 const text=value=>{requireValue(stack.length>1||/^[ \t\n]*$/.test(value),'XMLルート外の本文です。');stack.at(-1).parts.push(value);};
 function expanded(name,ns,attribute=false){const parts=name.split(':');const uri=parts.length===2?ns[parts[0]]:attribute?'':ns['']||'';requireValue(uri!==undefined,'XML名前空間が未定義です。');return {uri,local:parts.at(-1)};}
 while(cursor<source.length){
  if(source[cursor]!=='<'){let end=source.indexOf('<',cursor);if(end<0)end=source.length;const value=source.slice(cursor,end);requireValue(!value.includes(']]>'),'XML本文が不正です。');text(entities(value));cursor=end;continue;}
  if(source.startsWith('<!--',cursor)){const end=source.indexOf('-->',cursor+4),content=source.slice(cursor+4,end);requireValue(end>=0&&!content.includes('--')&&!content.endsWith('-'),'XMLコメントが不正です。');cursor=end+3;continue;}
  if(source.startsWith('<![CDATA[',cursor)){const end=source.indexOf(']]>',cursor+9);requireValue(end>=0&&stack.length>1,'XML CDATAが不正です。');text(source.slice(cursor+9,end));cursor=end+3;continue;}
  requireValue(!source.startsWith('<!',cursor)&&!source.startsWith('<?',cursor),'DTD/ENTITY/処理命令は未対応です。');
  if(source.startsWith('</',cursor)){const match=matchAt(closing);requireValue(match&&stack.length>1&&match[1]===stack.at(-1).name,'XML閉じタグが一致しません。');stack.pop();cursor+=match[0].length;continue;}
  cursor++;const match=matchAt(namePattern);requireValue(match,'XML要素名が不正です。');const name=match[0];cursor+=name.length;
  const attributes=[],seen=new Set();let self=false;
  while(true){const space=matchAt(whitespace)[0];cursor+=space.length;
   if(source.startsWith('/>',cursor)){self=true;cursor+=2;break;}if(source[cursor]==='>'){cursor++;break;}
   requireValue(space.length>0,'XML属性の区切りが不正です。');const m=matchAt(namePattern);requireValue(m&&!seen.has(m[0]),'XML属性が不正または重複しています。');const key=m[0];seen.add(key);cursor+=key.length;
   const equal=matchAt(equality);requireValue(equal,'XML属性値は引用符が必要です。');cursor+=equal[0].length;const end=source.indexOf(equal[1],cursor);requireValue(end>=0&&!source.slice(cursor,end).includes('<'),'XML属性値が不正です。');attributes.push([key,entities(source.slice(cursor,end).replace(/[\t\n]/g,' '))]);cursor=end+1;
  }
  const ns=Object.assign(Object.create(null),stack.at(-1).ns);for(const [key,value] of attributes)if(key==='xmlns'||key.startsWith('xmlns:')){const prefix=key==='xmlns'?'':key.slice(6);requireValue(prefix!=='xmlns'&&(prefix!=='xml'||value==='http://www.w3.org/XML/1998/namespace')&&(prefix===''||!!value)&&!(value==='http://www.w3.org/2000/xmlns/')&&(prefix==='xml'||value!=='http://www.w3.org/XML/1998/namespace'),'XML名前空間宣言が不正です。');ns[prefix]=value;}
  const tag=expanded(name,ns),attrs=Object.create(null),expandedAttrs=new Set();
  for(const [key,value] of attributes)if(key!=='xmlns'&&!key.startsWith('xmlns:')){const a=expanded(key,ns,true),full=`{${a.uri}}${a.local}`;requireValue(!expandedAttrs.has(full),'XML属性の展開名が重複しています。');expandedAttrs.add(full);attrs[full]=value;}
  const element={name,...tag,attrs,ns,children:[],parts:[]};stack.at(-1).children.push(element);stack.at(-1).parts.push(element);if(!self)stack.push(element);
  requireValue(++count<=MMAP_LIMITS.elements&&stack.length<=MMAP_LIMITS.depth,'XML要素数/深さの上限を超えています。');
 }
 requireValue(stack.length===1&&document.children.length===1,'XMLのルートまたは終端が不正です。');return document.children[0];
}
const children=(element,name,uri=AP)=>element.children.filter(e=>e.local===name&&e.uri===uri);
const attr=(element,key)=>element.attrs[`{}${key}`];
const walk=function*(element){yield element;for(const child of element.children)yield*walk(child);};
const textContent=element=>element.parts.map(p=>typeof p==='string'?p:textContent(p)).join('');
function plainNotes(topic){const groups=children(topic,'NotesGroup');requireValue(groups.length<=1,'複数のNotesGroupは未対応です。');if(!groups.length)return {text:'',mapped:false};const data=children(groups[0],'NotesXhtmlData');requireValue(data.length<=1,'複数のNotesXhtmlDataは未対応です。');if(!data.length)return {text:'',mapped:false};
 const html=children(data[0],'html',XHTML);requireValue(html.length===1,'未対応のノート表現です。XHTML htmlが必要です。');const bodies=children(html[0],'body',XHTML);requireValue(bodies.length===1,'XHTML bodyは1件必要です。');
 const blocks=new Set(['p','div','li','tr','h1','h2','h3','h4','h5','h6']);
 const flatten=e=>{if(e.uri===XHTML&&e.local==='br')return '\n';if(e.uri===XHTML&&['script','style','head'].includes(e.local))return '';let out=e.parts.map(p=>typeof p==='string'?p:flatten(p)).join('');return out+(e.uri===XHTML&&blocks.has(e.local)?'\n':'');};
 // Remove only the final separator introduced by the outermost block.
 const text=flatten(bodies[0]);return {text:text.endsWith('\n')?text.slice(0,-1):text,mapped:true};
}

export function convertMmap(bytes,name='map.mmap'){
 requireValue(typeof name==='string'&&name.length>0&&name.length<=240&&!/[\\/\x00-\x1f]/.test(name),'読込ファイル名が不正です。');
 const entries=readMmapZip(bytes),root=readMmapXml(entries.get('Document.xml').bytes);requireValue(root.uri===AP&&root.local==='Map','未対応のMindManager名前空間/Mapです。');
 const mapOid=attr(root,'OId');requireValue(mapOid&&mapOid.length<=200,'MapのOIdが必要です。');
 const namespace=sha(mapOid).slice(0,20),nodes=[],links=[],mapping=[],relationshipMapping=[],topicIds=new Map(),visited=new Set(),mappedElements=new Set(),mappedAttrs=new Map();
 const mark=(e,...keys)=>{mappedElements.add(e);mappedAttrs.set(e,new Set([...(mappedAttrs.get(e)||[]),...keys.map(k=>`{}${k}`)]));};
 mark(root,'OId');const topicContainers=children(root,'OneTopic');requireValue(topicContainers.length===1&&children(topicContainers[0],'Topic').length===1,'中心Topicは1件必要です。');mark(topicContainers[0]);
 const queue=[{topic:children(topicContainers[0],'Topic')[0],parentId:null,originalParentOId:null,placement:'main',level:0}];
 for(let i=0;i<queue.length;i++){
  requireValue(queue.length<=MMAP_LIMITS.topics,'Topic上限500件を超えています。');const {topic,parentId,originalParentOId,placement,level}=queue[i],oid=attr(topic,'OId');requireValue(oid&&oid.length<=200&&!topicIds.has(oid),'TopicのOIdが欠落または重複しています。');
  const id=`mm:${namespace}:${sha(oid).slice(0,32)}`;topicIds.set(oid,id);visited.add(topic);mark(topic,'OId');
  const texts=children(topic,'Text');requireValue(texts.length<=1,'複数のTopic Textは未対応です。');const title=texts.length?attr(texts[0],'PlainText'):undefined;if(texts.length)mark(texts[0],'PlainText');
  const notes=plainNotes(topic),tasks=children(topic,'Task');requireValue(tasks.length<=1,'複数のTaskは未対応です。');let progress=0,taskProgress=false;
  if(tasks.length&&attr(tasks[0],'TaskPercentage')!==undefined){const value=attr(tasks[0],'TaskPercentage');requireValue(/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)&&Number(value)<=100,'TaskPercentageは0〜100が必要です。');progress=Number(value);taskProgress=true;mark(tasks[0],'TaskPercentage');}
  nodes.push({id,parentId,title:title?.trim()?title:`無題の枝 ${i+1}`,body:notes.text,progress,kind:tasks.length?'task':'concept',x:40+level*240,y:40+i*100});
  mapping.push({nodeId:id,originalOId:oid,originalParentOId,placement,titleImported:!!title?.trim(),notesPlain:notes.mapped,taskProgress});
  for(const [containerName,kind] of [['SubTopics','child'],['FloatingTopics','floating']])for(const container of children(topic,containerName)){mark(container);for(const child of children(container,'Topic'))queue.push({topic:child,parentId:kind==='child'?id:null,originalParentOId:oid,placement:kind,level:kind==='child'?level+1:0});}
 }
 const all=[...walk(root)],topics=all.filter(e=>e.uri===AP&&e.local==='Topic');requireValue(topics.length===visited.size,'未対応の経路にTopicがあります。枝を省略せず読込を中止しました。');
 const collections=children(root,'Relationships');requireValue(collections.length<=1,'複数のRelationshipsは未対応です。');for(const collection of collections)mark(collection);
 const relations=collections.flatMap(c=>children(c,'Relationship'));requireValue(relations.length<=MMAP_LIMITS.relationships,'Relationship上限1000件を超えています。');const relationOids=new Set();
 for(const relation of relations){const oid=attr(relation,'OId');requireValue(oid&&oid.length<=200&&!relationOids.has(oid),'RelationshipのOIdが欠落または重複しています。');relationOids.add(oid);const groups=children(relation,'ConnectionGroup');let endpoints=[];
  for(const index of ['0','1']){const group=groups.filter(g=>attr(g,'Index')===index),connections=group.length===1?children(group[0],'Connection'):[],refs=connections.length===1?children(connections[0],'ObjectReference'):[];endpoints.push(refs.length===1?attr(refs[0],'OIdRef'):null);}
  const resolved=groups.length===2&&endpoints.every(e=>topicIds.has(e))&&endpoints[0]!==endpoints[1];const texts=children(relation,'Text');
  const report={originalOId:oid,endpoints,label:texts.map(t=>attr(t,'PlainText')||'').join('\n'),mapped:resolved};
  if(resolved){const id=`mmr:${namespace}:${sha(oid).slice(0,32)}`;links.push({id,from:topicIds.get(endpoints[0]),to:topicIds.get(endpoints[1]),type:'relates_to'});report.linkId=id;mark(relation,'OId');for(const group of groups){mark(group,'Index');for(const connection of children(group,'Connection')){mark(connection);for(const ref of children(connection,'ObjectReference'))mark(ref,'OIdRef');}}}
  relationshipMapping.push(report);
 }
 const unmappedElements=new Map(),unmappedAttributes=new Map();
 for(const e of all){const tag=`{${e.uri}}${e.local}`;if(!mappedElements.has(e))unmappedElements.set(tag,(unmappedElements.get(tag)||0)+1);for(const key of Object.keys(e.attrs))if(!mappedAttrs.get(e)?.has(key)){const path=`${tag}/@${key}`;unmappedAttributes.set(path,(unmappedAttributes.get(path)||0)+1);}}
 const report={profile:1,sourceMapOId:mapOid,topics:nodes.length,relationships:links.length,unresolvedRelationships:relationshipMapping.filter(r=>!r.mapped).length,mapping,relationshipMapping,
  entries:[...entries.values()].map(e=>({name:e.name,bytes:e.expanded,sha256:sha(e.bytes),used:e.name==='Document.xml'})),
  unmappedElements:[...unmappedElements].map(([name,count])=>({name,count})),unmappedAttributes:[...unmappedAttributes].map(([name,count])=>({name,count})),
  notes:['階層と具体化の深さ・領域は別です。領域/具体化/状態/成果受入は推定しません。','浮動Topicは独立した枝にします。元の所属は対応表に保持します。','ノートは本文の文字列へ変換します。書式/画像/リンク/スクリプトの動作は採用せず、原ZIPに保持します。','Map直下のRelationshipsだけを関連として扱い、矢印/依存/工程/仕様適用/ラベルの意味を採用しません。解決不能な線と正規経路外の線は原ZIPと未対応一覧に保持します。','TaskPercentageは計画進捗だけへ対応します。日付/時刻/タイムゾーン/担当/優先度/式/属性/テーマ/配置等は未対応で原ZIPに保持します。','全ZIP項目を原bytesで保管します。外部参照/添付を取得・実行しません。MindManager向け書戻し/完全互換は提供しません。']};
 const sourceDocument={format:'mindmanager-mmap',profile:1,name,sha256:sha(bytes),base64:bytes.toString('base64'),report};
 return {schemaVersion:2,projectId:`mindmanager:${namespace}`,revision:0,nodes,links,runs:[],events:[],archiveRefs:[],sourceDocument,backupScope:'有限な.mmap変換。原ZIPと対応表/未対応一覧を閲覧専用で保持。外部ファイル/権限/会話を継承しない。'};
}

export function mmapSourceBytes(source){
 requireValue(source&&typeof source==='object'&&!Array.isArray(source)&&Object.keys(source).every(k=>['format','profile','name','sha256','base64','report'].includes(k))&&source.format==='mindmanager-mmap'&&source.profile===1,'未対応の.mmap原記録形式です。');
 requireValue(typeof source.name==='string'&&source.name.length>0&&source.name.length<=240&&!/[\\/\x00-\x1f]/.test(source.name),'原記録のファイル名が不正です。');
 requireValue(typeof source.base64==='string'&&source.base64.length<=Math.ceil(MMAP_LIMITS.bytes/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.base64),'原ZIPのbase64が不正または上限超過です。');
 const bytes=Buffer.from(source.base64,'base64');requireValue(bytes.length>0&&bytes.length<=MMAP_LIMITS.bytes&&bytes.toString('base64')===source.base64&&sha(bytes)===source.sha256,'原ZIPの指紋/長さが一致しません。');
 const report=source.report;
 requireValue(report&&typeof report==='object'&&!Array.isArray(report)&&report.profile===1&&typeof report.sourceMapOId==='string'&&['topics','relationships','unresolvedRelationships'].every(k=>Number.isSafeInteger(report[k])&&report[k]>=0),'変換時の対応表が必要です。');
 for(const key of ['mapping','relationshipMapping','entries','unmappedElements','unmappedAttributes'])requireValue(Array.isArray(report[key])&&report[key].length<=MMAP_LIMITS.elements&&report[key].every(v=>v&&typeof v==='object'&&!Array.isArray(v)),'変換時の対応表の配列が不正です。');
 requireValue(report.mapping.every(m=>typeof m.nodeId==='string')&&Array.isArray(report.notes)&&report.notes.every(n=>typeof n==='string'),'変換時の対応と未対応の説明が不正です。');return bytes;
}
