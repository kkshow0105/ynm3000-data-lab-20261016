'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const core=require('../tools/us-market/market-core'),{collect,budgetDay}=require('../scripts/collect-us-market'),{collectSox}=require('../scripts/collect-sox'),{collectExtra}=require('../scripts/collect-market-extras'),{syncPublic}=require('../scripts/public-market-data');
const ID='cloud-proof-v1';
const MODULES=['sector:NASDAQ','sector:NYSE','industry:NASDAQ','industry:NYSE','index:^GSPC','index:^IXIC','fred:NASDAQSOX','fred:NASDAQNBI'];
function identify(url,target){
 const u=new URL(url),q=u.searchParams;let id;
 if(u.origin==='https://financialmodelingprep.com'){
  if(['/stable/sector-performance-snapshot','/stable/industry-performance-snapshot'].includes(u.pathname)&&q.get('date')===target&&core.EXCHANGES.includes(q.get('exchange')))id=(u.pathname.includes('industry')?'industry':'sector')+':'+q.get('exchange');
  if(u.pathname==='/stable/historical-price-eod/full'&&q.get('to')===target&&q.get('from')===core.shift(target,-12)&&Object.hasOwn(core.ACTIVE_INDEXES,q.get('symbol')))id='index:'+q.get('symbol');
 }else if(u.origin==='https://fred.stlouisfed.org'&&u.pathname==='/graph/fredgraph.csv'&&q.get('coed')===target&&['NASDAQSOX','NASDAQNBI'].includes(q.get('id')))id='fred:'+q.get('id');
 if(!id)throw Error('Non-allowlisted endpoint blocked');return {u,id,provider:id.startsWith('fred:')?'FRED':'FMP'};
}
function inspect(text,id,target,at){
 const meta={fieldsValid:false,rows:0,dataDate:null,previousDate:null,readiness:'invalid'};
 try{
 if(id.startsWith('fred:')){const sox=id==='fred:NASDAQSOX',d=sox?core.parseSoxCsv(text,at):core.parseDailyCsv(text,at,'NBI'),r=sox?core.soxForDate(d,target):core.dailySeriesForDate(d,'NBI',target);Object.assign(meta,{fieldsValid:true,rows:d.observations.length,dataDate:r.record?.date||d.observations.at(-1)?.date||null,previousDate:r.record?.previousDate||null,readiness:r.status,hasAdjacentCloses:Number.isFinite(r.record?.change)});}
 else{const data=JSON.parse(text);if(!Array.isArray(data))return {...meta,structure:'object'};meta.structure='array';meta.rows=data.length;if(id.startsWith('index:')){const r=core.indexFromCloses(data,id.slice(6),target);Object.assign(meta,{fieldsValid:true,dataDate:r.date,previousDate:r.previousDate,readiness:'current',hasAdjacentCloses:true});}else{const [kind,exchange]=id.split(':');core.normalizeRows(data,kind,exchange,target);Object.assign(meta,{fieldsValid:true,dataDate:target,readiness:'current'});}}
 }catch{meta.readiness='validation_failed';}return meta;
}
function boundedFetch(target,fetchImpl=fetch){
 const events=[],seen=new Set(),counts={FMP:0,FRED:0};
 const request=async(url,options={})=>{
  const {id,provider}=identify(url,target);
  if(seen.has(id)||counts[provider]>=(provider==='FMP'?6:2))return new Response('',{status:598});
  seen.add(id);counts[provider]++;const event={module:id,provider,requestedAt:new Date().toISOString(),http:null,transport:'pending'};events.push(event);const start=Date.now();
  try{const r=await fetchImpl(url,{...options,redirect:'error'});event.http=r.status;event.transport='received';const text=await r.text();if(r.ok)Object.assign(event,inspect(text,id,target,new Date().toISOString()));return new Response(text,{status:r.status,headers:{'Content-Type':r.headers.get('content-type')||'text/plain'}});}catch{event.transport='network_error';return new Response('',{status:599});}finally{event.elapsedMs=Date.now()-start;}
 };
 return {request,events,counts};
}
function safeModule(id,event){if(!event)return {module:id,attempted:false};return Object.fromEntries(['module','provider','requestedAt','http','transport','elapsedMs','fieldsValid','rows','dataDate','previousDate','readiness','hasAdjacentCloses','structure'].filter(k=>event[k]!==undefined).map(k=>[k,event[k]]));}
async function run({dir,date,now=new Date(),fetchImpl=fetch,key=process.env.FMP_API_KEY,testMode=false}){
 if(!core.isTradingDay(date)||date>core.expectedSession(now))throw Error('Target must be a completed trading session');
 const bounded=boundedFetch(date,fetchImpl),opts={dir,date,now,key,budget:6,fetchImpl:bounded.request,testMode};
 const stages={};for(const [name,fn] of [['FMP',()=>collect(opts)],['SOX',()=>collectSox(opts)],['NBI',()=>collectExtra({...opts,symbol:'NBI'})]]){try{await fn();stages[name]='validated';}catch{stages[name]='blocked';}}
 let complete=false;try{const result=await syncPublic({sourceDir:dir,dir:path.join(dir,'private-validated-output'),now});complete=result.latest===date;}catch{}
 return {kind:'CLOUD_CONNECTION_CHECK_ONLY',containsMarketPrices:false,experiment:ID,targetDate:date,checkedAt:new Date().toISOString(),counts:{...bounded.counts},complete,publication:'DISABLED',stages,modules:MODULES.map(id=>safeModule(id,bounded.events.find(e=>e.module===id)))};
}
async function main(){
 if(process.env.GITHUB_REPOSITORY!=='kkshow0105/ynm3000-data-lab-20261016'||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REF!=='refs/heads/main')throw Error('Only approved main manual workflow may collect');
 if(!process.env.FMP_API_KEY?.trim())throw Error('FMP secret missing');
 const root=path.resolve(process.env.RUNNER_TEMP||''),dir=path.resolve(root,'ynm-cloud-proof'),grant=JSON.parse(await fs.readFile(path.join(root,'ynm-cloud-grant.json'),'utf8'));
 if(!process.env.RUNNER_TEMP||!dir.startsWith(root+path.sep)||grant.experiment!==ID||grant.runId!==process.env.GITHUB_RUN_ID||grant.day!==budgetDay(new Date())||grant.fmp!==6||grant.fred!==2)throw Error('Valid persisted reservation required');
 await fs.mkdir(dir,{recursive:true});const result=await run({dir,date:grant.targetDate});const text=JSON.stringify(result,null,2);
 // Only metadata leaves the temporary data directory. Never upload an artifact or print provider responses.
 await fs.writeFile(path.join(root,'ynm-cloud-summary.json'),text);console.log(text);
 if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'## Cloud connection validation (no market prices)\n```json\n'+text+'\n```\n');
}
module.exports={ID,MODULES,identify,inspect,boundedFetch,run};
if(require.main===module)main().catch(()=>{console.error('Cloud verification stopped; no raw response or credential logged.');process.exitCode=1;});
