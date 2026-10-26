import {deflateRawSync} from 'node:zlib';

// Independently constructed fictional document, not an installed/user map.
export const AP='http://schemas.mindjet.com/MindManager/Application/2003';
export const xml=`<?xml version="1.0" encoding="UTF-8"?>
<ap:Map xmlns:ap="${AP}" xmlns:x="http://www.w3.org/1999/xhtml" OId="fictional-map/+=">
 <ap:OneTopic><ap:Topic OId="root/+="><ap:Text PlainText="架空書籍：雨港の灯 &amp; 設計"/>
  <ap:NotesGroup><ap:NotesXhtmlData><x:html><x:body><x:p>一段目 &amp; 原文</x:p><x:p>二段目<x:br/>続き</x:p></x:body></x:html></ap:NotesXhtmlData></ap:NotesGroup>
  <ap:SubTopics><ap:Topic OId="chapter/+="><ap:Text PlainText="第一章：港の約束"/><ap:Task TaskPercentage="42" StartDate="2026-10-26T23:30:00+09:00" DeadlineDate="2026-10-28T00:00:00+09:00" Priority="2"/><ap:BusinessDataGroup Formula="2+2"/><ap:Hyperlink Url="https://example.invalid/do-not-fetch"/></ap:Topic></ap:SubTopics>
  <ap:FloatingTopics><ap:Topic OId="floating/+="><ap:Text PlainText="未整理の資料"/><ap:Image Uri="resources/placeholder.txt"/></ap:Topic></ap:FloatingTopics>
 </ap:Topic></ap:OneTopic>
 <ap:Relationships>
  <ap:Relationship OId="relation/+="><ap:ConnectionGroup Index="0"><ap:Connection><ap:ObjectReference OIdRef="root/+="/></ap:Connection></ap:ConnectionGroup><ap:ConnectionGroup Index="1"><ap:Connection><ap:ObjectReference OIdRef="chapter/+="/></ap:Connection><ap:ConnectionStyle ConnectionShape="urn:mindjet:Arrow"/></ap:ConnectionGroup><ap:Text PlainText="線のラベルは仕様依存ではない"/></ap:Relationship>
  <ap:Relationship OId="broken/+="><ap:ConnectionGroup Index="0"><ap:Connection><ap:ObjectReference OIdRef="root/+="/></ap:Connection></ap:ConnectionGroup><ap:ConnectionGroup Index="1"><ap:Connection><ap:ObjectReference OIdRef="absent/+="/></ap:Connection></ap:ConnectionGroup></ap:Relationship>
 </ap:Relationships><ap:Theme Custom="unmapped"/>
</ap:Map>`;
function checksum(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;}
export function zip(entries=[{name:'Document.xml',text:xml},{name:'resources/placeholder.txt',text:'架空の添付。実行も外部取得もしない。'}]){
 const locals=[],centrals=[];let offset=0;
 for(const entry of entries){const name=Buffer.from(entry.name),data=Buffer.from(entry.text??''),method=entry.method??8,compressed=method===8?deflateRawSync(data):data,flags=entry.flags??0,crc=checksum(data),local=Buffer.alloc(30),central=Buffer.alloc(46),descriptor=flags&8?Buffer.alloc(16):Buffer.alloc(0);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);local.writeUInt32LE(flags&8?0:crc,14);local.writeUInt32LE(flags&8?0:compressed.length,18);local.writeUInt32LE(flags&8?0:data.length,22);local.writeUInt16LE(name.length,26);
  if(flags&8){descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(compressed.length,8);descriptor.writeUInt32LE(data.length,12);}
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(entry.attrs??0,38);central.writeUInt32LE(offset,42);
  locals.push(local,name,compressed,descriptor);centrals.push(central,name);offset+=local.length+name.length+compressed.length+descriptor.length;
 }
 const central=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,central,end]);
}
