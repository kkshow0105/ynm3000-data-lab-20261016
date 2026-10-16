 'use strict';
// No browser imports. Export only explicit market fields; never copy the private directory.
const {createHash}=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),{execFileSync}=require('node:child_process');
const core=require('../tools/us-market/market-core');
const {readJson,atomicJson,DATA_DIR}=require('./collect-us-market');
const ROOT=path.resolve(__dirname,'..'),PUBLIC_DIR=path.join(ROOT,'public-data/us-market');
const pick=(value,keys)=>Object.fromEntries(keys.map(k=>[k,value[k]]));
const INDEX_FIELDS=['symbol','name','date','previousDate','close','previousClose','change'];
const SOX_FIELDS=['version','source','series','sourceUrl','copyright','fetchedAt'];
const NBI_FIELDS=['version','series','source','sourceUrl','copyright','unit','basis','fetchedAt'];
function publicSnapshot(raw){
 core.validateSnapshot(raw);
 const result={...pick(raw,['version','tradingDate','updatedAt','source','isProxy']),
  calculation:{industry:'FMP交易所行业平均涨跌幅',index:'(收盘价 / 上一有效交易日收盘价 - 1) × 100',scope:'NASDAQ + NYSE交易所行业记录排行'},
  datasets:Object.fromEntries(['sector','industry'].map(k=>[k,raw.datasets[k].map(r=>pick(r,['name','exchange','change']))])),
  indices:raw.indices.filter(r=>Object.hasOwn(core.ACTIVE_INDEXES,r.symbol)).map(r=>pick(r,INDEX_FIELDS))};
 return core.validateSnapshot(result);
}
function publicSeries(raw,symbol){
 const value=symbol==='SOX'?core.validateSox(raw):core.validateDailySeries(raw,'NBI');
 if(!value)throw Error(symbol+'日线缺失');
 return {...pick(value,symbol==='SOX'?SOX_FIELDS:NBI_FIELDS),observations:value.observations.map(r=>pick(r,symbol==='SOX'?['date','close','fetchedAt']:['date','close','fetchedAt','previousDate','previousClose']))};
}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function manifestDates(m,now){
 if(!m||m.version!==1||!Array.isArray(m.dates)||!m.dates.length||new Set(m.dates).size!==m.dates.length
  ||m.dates.some(d=>!core.isTradingDay(d)||d>core.expectedSession(now))||m.latest!==[...m.dates].sort().at(-1))throw Error('公开历史清单为空、损坏或包含无效/未来交易日');
 return [...m.dates].sort().reverse();
}
function checkKeys(actual,expected,label){
 if(!same(Object.keys(actual).sort(),Object.keys(expected).sort()))throw Error(label+'包含非白名单字段');
}
function checkBundle(bundle,now=new Date()){
 const dates=manifestDates(bundle['manifest.json'],now),expected=['manifest.json','status.json','sox.json','nbi.json',...dates.map(d=>'snapshots/'+d+'.json')];
 if(!same(Object.keys(bundle).sort(),expected.sort()))throw Error('公开数据文件缺失或包含非白名单文件');
 checkKeys(bundle['manifest.json'],{version:1,dates:[],latest:'',integrity:{}},'历史清单');
 for(const symbol of ['SOX','NBI']){
  const name=symbol.toLowerCase()+'.json',raw=bundle[name],clean=publicSeries(raw,symbol);
  if(!same(raw,clean))throw Error(symbol+'存在非白名单字段');
  if(raw.observations.some(r=>r.date>core.expectedSession(now)))throw Error(symbol+'包含未来交易日');
 }
 for(const date of dates){
  const value=bundle['snapshots/'+date+'.json'];
  if(value.tradingDate!==date||!same(value,publicSnapshot(value)))throw Error(date+'快照字段或日期无效');
  // Current exporter deliberately requires all four complete closes for every published date.
  for(const symbol of Object.keys(core.ACTIVE_INDEXES))if(core.indexForDate(value.indices,symbol,date).status!=='current')throw Error(date+' FMP指数不完整');
  const sox=core.soxForDate(bundle['sox.json'],date),nbi=core.dailySeriesForDate(bundle['nbi.json'],'NBI',date);
  if(sox.status!=='current'||!Number.isFinite(sox.record?.change)||nbi.status!=='current'||!Number.isFinite(nbi.record?.change))throw Error(date+' SOX/NBI缺少当日或前一有效收盘价');
  const nbiPrevious=bundle['nbi.json'].observations.find(r=>r.date===nbi.record.previousDate);
  if(!nbiPrevious||nbiPrevious.close!==nbi.record.previousClose)throw Error(date+' NBI前收盘价格与历史记录不一致');
 }
 const integrity=bundle['manifest.json'].integrity;
 const protectedFiles=expected.filter(f=>!['manifest.json','status.json'].includes(f)).sort();
 if(!integrity||!same(Object.keys(integrity).sort(),protectedFiles)||protectedFiles.some(f=>integrity[f]!==digest(bundle[f])))throw Error('公开行情完整性哈希不匹配，禁止部署');
 const latest=bundle['snapshots/'+dates[0]+'.json'];
 if(!same(bundle['status.json'],{version:1,lastAttempt:{success:true,date:dates[0],at:latest.updatedAt}}))throw Error('公开状态不符合白名单');
 return {dates,latest:dates[0],files:expected.sort(),coverage:Object.fromEntries(['sector','industry'].map(k=>[k,Object.fromEntries(core.EXCHANGES.map(e=>[e,latest.datasets[k].filter(r=>r.exchange===e).length]))]))};
}
async function fileNames(dir,prefix=''){
 const names=[];
 for(const ent of await fs.readdir(dir,{withFileTypes:true})){
  if(ent.isSymbolicLink())throw Error('公开数据不允许符号链接');
  const name=prefix+ent.name;
  if(ent.isDirectory())names.push(...await fileNames(path.join(dir,ent.name),name+'/'));
  else names.push(name);
 }
 return names;
}
async function loadBundle(dir){
 const bundle={};
 let names;try{names=await fileNames(dir);}catch(e){if(e.code==='ENOENT')throw Error('公开行情目录缺失；先运行同步命令');throw e;}
 for(const name of names){
  if(!/^(manifest|status|sox|nbi)\.json$|^snapshots\/\d{4}-\d{2}-\d{2}\.json$/.test(name))throw Error('公开目录存在非白名单文件：'+name);
  try{bundle[name]=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));}catch{throw Error('公开JSON缺失或损坏：'+name);}
 }
 return bundle;
}
async function validatePublic({dir=PUBLIC_DIR,now=new Date()}={}){return checkBundle(await loadBundle(dir),now);}
function mergeSeries(old,fresh,symbol){
 if(!old)return fresh;
 const records=new Map(old.observations.map(r=>[r.date,r]));let added=false;
 for(const row of fresh.observations){
  const previous=records.get(row.date);
  if(previous){if(previous.close!==row.close||(previous.previousClose!=null&&row.previousClose!=null&&previous.previousClose!==row.previousClose))throw Error(symbol+'既有历史价格发生变化；停止自动覆盖，请人工核实');}
  else{records.set(row.date,row);added=true;}
 }
 return added?{...fresh,observations:[...records.values()].sort((a,b)=>a.date.localeCompare(b.date))}:old;
}
async function syncPublic({sourceDir=DATA_DIR,dir=PUBLIC_DIR,now=new Date()}={}){
 let old={};try{await fs.access(dir);old=await loadBundle(dir);checkBundle(old,now);}catch(e){if(e.code!=='ENOENT')throw e;}
 const manifest=await readJson(path.join(sourceDir,'manifest.json'),null),sourceDates=manifestDates(manifest,now);
 const bundle={...old};
 for(const date of sourceDates){
  const key='snapshots/'+date+'.json',clean=publicSnapshot(await readJson(path.join(sourceDir,key),null));
  if(clean.tradingDate!==date)throw Error('原始快照日期不匹配');
  if(old[key]&&!same(clean,old[key]))throw Error(date+'已公开历史变化；停止自动覆盖');bundle[key]=clean;
 }
 for(const symbol of ['SOX','NBI']){
  const key=symbol.toLowerCase()+'.json';bundle[key]=mergeSeries(old[key],publicSeries(await readJson(path.join(sourceDir,key),null),symbol),symbol);
 }
 const dates=[...new Set([...(old['manifest.json']?.dates||[]),...sourceDates])].sort().reverse();
 bundle['manifest.json']={version:1,dates,latest:dates[0],integrity:Object.fromEntries(['sox.json','nbi.json',...dates.map(d=>'snapshots/'+d+'.json')].sort().map(f=>[f,digest(bundle[f])]))};
 bundle['status.json']={version:1,lastAttempt:{success:true,date:dates[0],at:bundle['snapshots/'+dates[0]+'.json'].updatedAt}};
 const checked=checkBundle(bundle,now); // Validate everything before changing any public file.
 await fs.mkdir(path.join(dir,'snapshots'),{recursive:true});
 for(const name of checked.files.filter(n=>n!=='manifest.json'))if(!same(old[name],bundle[name]))await atomicJson(path.join(dir,name),bundle[name]);
 if(!same(old['manifest.json'],bundle['manifest.json']))await atomicJson(path.join(dir,'manifest.json'),bundle['manifest.json']);
 await validatePublic({dir,now});return {...checked,requests:0};
}
module.exports={ROOT,PUBLIC_DIR,publicSnapshot,publicSeries,checkBundle,loadBundle,validatePublic,syncPublic};
if(require.main===module)(async()=>{
 const args=process.argv.slice(2);
 if(args.some(a=>!['--check','--collect','--stage'].includes(a)&&!/^--date=\d{4}-\d{2}-\d{2}$/.test(a))||(args.includes('--check')&&args.length!==1))throw Error('用法：node scripts/public-market-data.js [--check | --collect [--date=YYYY-MM-DD]] [--stage]');
 if(args.some(a=>a.startsWith('--date='))&&!args.includes('--collect'))throw Error('--date仅用于显式采集；普通同步保留全部已有历史');
 if(args.includes('--check')){console.log(JSON.stringify(await validatePublic()));return;}
 let collection=[];
 if(args.includes('--collect')){
  if(process.env.NODE_TEST_CONTEXT)throw Error('自动化测试禁止真实采集');
  const date=args.find(a=>a.startsWith('--date='))?.slice(7);
  collection.push(await require('./collect-us-market').collect({date}));
  collection.push(await require('./collect-sox').collectSox({date}));
  collection.push(await require('./collect-market-extras').collectExtra({symbol:'NBI',date}));
 }
 const result=await syncPublic();
 if(args.includes('--stage'))execFileSync('git',['add','--',...result.files.map(f=>path.relative(ROOT,path.join(PUBLIC_DIR,f)))],{cwd:ROOT,stdio:'inherit'});
 console.log(JSON.stringify({...result,collection,staged:args.includes('--stage')},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
