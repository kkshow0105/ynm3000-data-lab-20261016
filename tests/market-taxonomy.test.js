'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {makeBundle,NOW,memoryStore}=require('./market-publish-fixtures'),{prepare,publish,hash}=require('../scripts/publish-market-data'),{taxonomy,checkIndustrySnapshot}=require('../scripts/market-taxonomy');
global.fetch=async()=>assert.fail('No market HTTP');
const FILE='snapshots/2026-10-14.json',clone=structuredClone;
function rehash(b){b['manifest.json'].integrity[FILE]=hash(b[FILE]);return b;}
test('固定基准255分类及完整Mock均通过，不使用真实API',async()=>{
 assert.equal(taxonomy.exchanges.NASDAQ.length,127);assert.equal(taxonomy.exchanges.NYSE.length,128);
 const mock=await makeBundle();prepare({bundle:mock,now:NOW});
});
test('逐一删除、重复、替换及改交易所：全部255分类均被检测，报告身份差异',async()=>{
 const base=(await makeBundle())[FILE];
 for(let i=0;i<255;i++)for(const mutation of ['delete','duplicate','replace','exchange']){
  const s=clone(base),original=s.datasets.industry[i];
  if(mutation==='delete')s.datasets.industry.splice(i,1);
  if(mutation==='duplicate'){const other=s.datasets.industry.find((r,j)=>j!==i&&r.exchange===original.exchange);original.name=other.name;}
  if(mutation==='replace')original.name='Unexpected New Classification';
  if(mutation==='exchange')original.exchange=original.exchange==='NASDAQ'?'NYSE':'NASDAQ';
  assert.throws(()=>checkIndustrySnapshot(s),e=>e.code==='INDUSTRY_COVERAGE'&&!!e.details.exchanges,mutation+' '+i);
 }
 const s=clone(base),old=s.datasets.industry[0];old.name='New Industry';
 assert.throws(()=>checkIndustrySnapshot(s),e=>e.details.exchanges[old.exchange].unexpected.includes('New Industry')&&e.details.exchanges[old.exchange].missing.length===1);
});
test('必要字段、唯一性、数值类型/有限性校验，非法内容不进入发布存储',async()=>{
 const base=await makeBundle();for(const mutate of [s=>delete s.name,s=>delete s.exchange,s=>delete s.change,s=>s.change='1.2',s=>s.change=NaN,s=>s.change=Infinity,s=>s.change=-101,s=>s.exchange='AMEX',s=>s.name=123,s=>s.secret='unexpected']){
  const b=clone(base);mutate(b[FILE].datasets.industry[0]);rehash(b);let writes=0;
  await assert.rejects(publish({bundle:b,now:NOW,store:{head(){writes++;},commit(){writes++;},advance(){writes++;}}}));assert.equal(writes,0);
 }
});
test('254条且哈希正确仍拒绝：旧快照及manifest字节保持不变',async()=>{
 const old=await makeBundle(),store=memoryStore();await publish({bundle:old,store,expectedHead:store.tip,now:NOW});const files=clone(store.files),tip=store.tip;
 const bad=rehash(clone(old));bad[FILE].datasets.industry.pop();rehash(bad);
 await assert.rejects(publish({bundle:bad,previous:old,store,expectedHead:tip,now:NOW}),e=>e.code==='INDUSTRY_COVERAGE');assert.deepEqual(store.files,files);assert.equal(store.tip,tip);
});
