'use strict';
// Copied to the independent data repository, not run by Netlify or the browser.
const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');
const core=require('../tools/us-market/market-core'),{collect,atomicJson}=require('./collect-us-market'),{collectSox}=require('./collect-sox'),{collectExtra}=require('./collect-market-extras'),{syncPublic,loadBundle,checkBundle}=require('./public-market-data');
const {publish,githubStore,REPO,hash}=require('./publish-market-data'),{sourceFetch}=require('./market-simulation');
const {createGitBudgetStore,reserveAndVerify,verifyGrant,stop}=require('./git-budget-ledger');
const {checkIndustrySnapshot,checkIndustryBundle,coverageDiagnostic}=require('./market-taxonomy');
function reportFailure(e){const taxonomy=coverageDiagnostic(e);if(taxonomy)console.error(taxonomy);else if(/^BUDGET_/.test(e?.code||''))console.error(JSON.stringify({code:e.code,phase:e.phase,message:e.message}));}
const MODE=()=>process.env.MARKET_MODE||'simulation';
function gate(mode,flag){if(!['simulation','real'].includes(mode)||mode==='real'&&flag!=='ENABLED')throw Error('真实行情公开发布未获最终确认，已在采集前阻止');}
function boundedSource(fetchImpl,date){const counts={FMP:0,FRED:0},seen=new Set();return {counts,request:async(url,options)=>{
 const u=new URL(url),q=u.searchParams;let id,provider;
 if(u.origin==='https://fred.stlouisfed.org'&&u.pathname==='/graph/fredgraph.csv'&&['NASDAQSOX','NASDAQNBI'].includes(q.get('id'))&&q.get('coed')===date){provider='FRED';id=q.get('id');}
 else if(u.origin==='https://financialmodelingprep.com'&&['/stable/sector-performance-snapshot','/stable/industry-performance-snapshot'].includes(u.pathname)&&q.get('date')===date&&core.EXCHANGES.includes(q.get('exchange'))){provider='FMP';id=u.pathname+q.get('exchange');}
 else if(u.origin==='https://financialmodelingprep.com'&&u.pathname==='/stable/historical-price-eod/full'&&Object.hasOwn(core.ACTIVE_INDEXES,q.get('symbol'))&&q.get('to')===date&&q.get('from')===core.shift(date,-12)){provider='FMP';id=q.get('symbol');}
 if(!provider||seen.has(id)||counts[provider]>=(provider==='FMP'?6:2))return new Response('',{status:598});seen.add(id);counts[provider]++;
 try{return await fetchImpl(url,{...options,redirect:'error'});}catch{return new Response('',{status:599});} // Existing collector cannot retry a thrown network error.
 }};}
async function writeBundle(dir,bundle){for(const [name,value]of Object.entries(bundle)){await fs.mkdir(path.dirname(path.join(dir,name)),{recursive:true});await atomicJson(path.join(dir,name),value);}}
async function buildCandidate({dir,date,previous=null,mode='simulation',incomplete=false,now=new Date(),key,fetchImpl}){
 gate(mode,mode==='simulation'?'':process.env.ALLOW_REAL_MARKET_PUBLICATION);
 if(!core.isTradingDay(date)||date>core.expectedSession(now))throw Error('只能处理已收盘有效交易日');
 if(previous){checkIndustryBundle(previous);const old=checkBundle(previous,now);if(old.dates.includes(date))return {alreadyComplete:true,bundle:previous,counts:{FMP:0,FRED:0}};}
 const raw=path.join(dir,'private-input'),out=path.join(dir,'validated-output');await fs.mkdir(raw,{recursive:true});
 if(previous){await writeBundle(raw,previous);await writeBundle(out,previous);}
 const source=boundedSource(fetchImpl||(mode==='simulation'?sourceFetch(date,{incomplete}):fetch),date),opts={dir:raw,date,now,budget:6,key:mode==='simulation'?'MOCK_ONLY_NOT_A_CREDENTIAL':key,fetchImpl:source.request,testMode:mode==='simulation'};
 // Wait for both slower FRED sources before spending any FMP calls.
 await collectSox(opts);await collectExtra({...opts,symbol:'NBI'});
 const sox=JSON.parse(await fs.readFile(path.join(raw,'sox.json'))),nbi=JSON.parse(await fs.readFile(path.join(raw,'nbi.json')));
 if(core.soxForDate(sox,date).status!=='current'||core.dailySeriesForDate(nbi,'NBI',date).status!=='current')throw Error('FRED目标日尚未就绪；保留上一完整版本');
 await collect(opts);checkIndustrySnapshot(JSON.parse(await fs.readFile(path.join(raw,'snapshots',date+'.json'),'utf8')));await syncPublic({sourceDir:raw,dir:out,now});const bundle=await loadBundle(out);checkIndustryBundle(bundle);checkBundle(bundle,now);return {alreadyComplete:false,bundle,counts:source.counts};
}
async function existingBundle(prefix){
 let pointer;try{pointer=JSON.parse(await fs.readFile(path.join(prefix,'latest.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!/^[a-f0-9]{64}$/.test(pointer.release)||pointer.kind!==(prefix==='market/v1'?'REAL_MARKET_DATA':'SYNTHETIC_TEST_ONLY'))throw Error('无效发布指针');
 const bundle=await loadBundle(path.join(prefix,'releases',pointer.release));checkIndustryBundle(bundle);checkBundle(bundle);if(pointer.manifestHash!==hash(bundle['manifest.json'])||pointer.latest!==bundle['manifest.json'].latest)throw Error('已发布清单不完整，停止而非覆盖');return {pointer,bundle};
}
async function bootstrapReal(store,root){
 // Executed only AFTER the real-publication gate. Seed all previously published real history.
 const origin='kkshow0105/monster-slayer-kit',ref='8996c60cd125dfd78736c3064eebfefa7cf94f11';
 async function read(name){const r=await fetch('https://api.github.com/repos/'+origin+'/contents/public-data/us-market/'+name+'?ref='+ref,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('既有真实历史种子不可用');const d=await r.json();return JSON.parse(Buffer.from(d.content,'base64').toString());}
 const m=await read('manifest.json'),files=['manifest.json','status.json','sox.json','nbi.json',...m.dates.map(d=>'snapshots/'+d+'.json')],bundle={};for(const f of files)bundle[f]=f==='manifest.json'?m:await read(f);checkIndustryBundle(bundle);checkBundle(bundle);return bundle;
}
// A real batch keeps the tested 6+2 maximum. Mock units remain isolated from provider usage.
const GENESIS='8f8a7ba12051488484868566b9891ccb3b626a66';
function externalFor({mode,now=new Date(),declaredFmp,declaredFred,confirmed=false,legacy}){
 const coversFrom=new Date(now.getTime()-172800000).toISOString();
 if(mode==='simulation')return {known:true,fmp:0,fred:0,observedAt:now.toISOString(),coversFrom};
 if(confirmed!==true||![declaredFmp,declaredFred].every(x=>typeof x==='string'&&/^\d{1,3}$/.test(x)))throw stop('BUDGET_EXTERNAL_UNKNOWN','必须明确确认过去48小时未纳入Git真实账本的FMP/FRED消耗');
 if(!legacy||legacy.version!==1||legacy.kind!=='CLOUD_VALIDATION_BUDGET_ONLY'||!Array.isArray(legacy.experiments))throw stop('BUDGET_EXTERNAL_UNKNOWN','旧真实调用基线无法核验');
 const relevant=legacy.experiments.filter(r=>{if(!Number.isFinite(Date.parse(r.reservedAt))||Date.parse(r.reservedAt)>now.getTime()||![r.fmp,r.fred].every(n=>Number.isSafeInteger(n)&&n>=0))throw stop('BUDGET_EXTERNAL_UNKNOWN','旧实验消耗记录不完整');return r.reservedAt>=coversFrom;});
 const known=relevant.reduce((a,r)=>({fmp:a.fmp+r.fmp,fred:a.fred+r.fred}),{fmp:0,fred:0});
 const fmp=Number(declaredFmp),fred=Number(declaredFred);if(fmp<known.fmp||fred<known.fred)throw stop('BUDGET_EXTERNAL_LOW','外部声明低于旧真实实验预留；不重复相加相同基线');
 return {known:true,fmp,fred,observedAt:now.toISOString(),coversFrom};
}
function validDate(date,now){if(!core.isTradingDay(date)||date>core.expectedSession(now))throw Error('目标尚未收盘或为休市日');}
async function prepareRun({mode,date,runId,now=new Date(),flag,budgetStore,loadExisting,publicationHead,external}){
 gate(mode,flag);validDate(date,now);const existing=await loadExisting();
 if(existing){checkIndustryBundle(existing.bundle);checkBundle(existing.bundle,now);if(existing.bundle['manifest.json'].dates.includes(date))return {shouldRun:false,reason:'already_complete'};}
 const id='market-'+mode+'-'+runId;
 const grant=await reserveAndVerify(budgetStore,{id,namespace:mode,targetDate:date,cost:mode==='real'?{fmp:6,fred:2}:{fmp:1,fred:0},external:typeof external==='function'?await external():external},{now});
 if(grant.authorized!==true)throw stop('BUDGET_DUPLICATE','本任务已有预算预留，禁止重跑');
 return {shouldRun:true,mode,date,runId:String(runId),publicationHead,budgetGrant:grant};
}
async function collectRun({envelope,mode,runId,now=new Date(),flag,budgetStore,publicationStore,loadExisting,bootstrap,dir,incomplete=false,key,fetchImpl,clock=()=>new Date()}){
 gate(mode,flag);const e=envelope,g=e?.budgetGrant;
 if(!e?.shouldRun||e.mode!==mode||e.runId!==String(runId)||g?.id!=='market-'+mode+'-'+runId||g.row?.namespace!==mode||g.row.targetDate!==e.date||JSON.stringify(g.row.cost)!==JSON.stringify(mode==='real'?{fmp:6,fred:2}:{fmp:1,fred:0}))throw stop('BUDGET_GRANT','采集凭证与任务身份、模式或最大预留不符');
 validDate(e.date,now);await verifyGrant(budgetStore,g,{now});
 if(mode==='real'&&!key?.trim())throw Error('缺少FMP Secret');
 const old=await loadExisting();const previous=old?.bundle||(mode==='real'?await bootstrap():null);
 // Recheck immediately before entering the bounded provider adapter. No uncertain grant reaches it.
 await verifyGrant(budgetStore,g,{now:clock()});
 const candidate=await buildCandidate({dir,date:e.date,previous,mode,incomplete,now,key,fetchImpl});
 if(candidate.alreadyComplete&&old)return {skipped:true,sourceRequests:{FMP:0,FRED:0}};
 const result=await publish({bundle:candidate.bundle,previous,kind:mode==='real'?'REAL_MARKET_DATA':'SYNTHETIC_TEST_ONLY',allowReal:mode==='real'&&flag==='ENABLED',store:publicationStore,expectedHead:e.publicationHead,now});
 return {mode,kind:result.pointer.kind,targetDate:e.date,published:true,release:result.pointer.release,dates:result.dates,coverage:result.coverage,sourceRequests:mode==='real'?candidate.counts:{FMP:0,FRED:0},mockCalls:mode==='simulation'?candidate.counts:undefined,budgetCommit:g.head};
}
async function main(){
 if(process.env.GITHUB_RUN_ATTEMPT!=='1'||process.env.GITHUB_REPOSITORY!==REPO||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||!process.env.RUNNER_TEMP)throw Error('只允许独立仓库main新建手动任务');
 const mode=MODE(),flag=process.env.ALLOW_REAL_MARKET_PUBLICATION;gate(mode,flag);
 if(mode==='simulation')throw Error('Mock通过同一prepareRun/collectRun函数验证；请运行market-integration-lab.js，不写入公开数据');
 const root=path.join(process.env.RUNNER_TEMP,'market-update');await fs.mkdir(root,{recursive:true});
 const store=githubStore({token:process.env.GH_TOKEN}),budgetStore=createGitBudgetStore({api:store.api,genesis:GENESIS}),date=process.env.TARGET_DATE||core.expectedSession(),prefix='market/v1',loadExisting=()=>existingBundle(prefix);
 if(process.argv[2]==='prepare'){
  const now=new Date();
  const external=async()=>externalFor({mode,now,declaredFmp:process.env.EXTERNAL_FMP_CALLS,declaredFred:process.env.EXTERNAL_FRED_CALLS,confirmed:process.env.CONFIRM_EXTERNAL_CALLS==='true',legacy:JSON.parse(await fs.readFile('lab/cloud-budget.json','utf8'))});
  const envelope=await prepareRun({mode,date,runId:process.env.GITHUB_RUN_ID,now,flag,budgetStore,loadExisting,publicationHead:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),external});
  await atomicJson(path.join(root,'grant.json'),envelope);await fs.appendFile(process.env.GITHUB_OUTPUT,'should_run='+envelope.shouldRun+'\n');console.log(JSON.stringify({mode,shouldRun:envelope.shouldRun,reason:envelope.reason,budgetCommit:envelope.budgetGrant?.head}));
 }else if(process.argv[2]==='collect'){
  const envelope=JSON.parse(await fs.readFile(path.join(root,'grant.json'),'utf8'));
  const result=await collectRun({envelope,mode,runId:process.env.GITHUB_RUN_ID,flag,budgetStore,publicationStore:store,loadExisting,bootstrap:()=>bootstrapReal(store,root),dir:root,incomplete:false,key:process.env.FMP_API_KEY});console.log(JSON.stringify(result));
 }else throw Error('未知工作流步骤');
}
module.exports={gate,boundedSource,buildCandidate,existingBundle,GENESIS,externalFor,prepareRun,collectRun};
if(require.main===module)main().catch(e=>{reportFailure(e);console.error('任务安全停止；预算预留不退回，上一发布版本保留。');process.exitCode=1;});
