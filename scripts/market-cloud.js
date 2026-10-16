'use strict';
// Copied to the independent data repository, not run by Netlify or the browser.
const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');
const core=require('../tools/us-market/market-core'),{collect,atomicJson,budgetDay}=require('./collect-us-market'),{collectSox}=require('./collect-sox'),{collectExtra}=require('./collect-market-extras'),{syncPublic,loadBundle,checkBundle}=require('./public-market-data');
const {publish,githubStore,REPO,hash}=require('./publish-market-data'),{sourceFetch}=require('./market-simulation');
const MODE=()=>process.env.MARKET_MODE||'simulation';
function gate(mode,flag){if(!['simulation','real'].includes(mode)||mode==='real'&&flag!=='USER_CONFIRMED')throw Error('真实行情公开发布未获最终确认，已在采集前阻止');}
function reserveQuota({prior=[],mode,day,runId,external=0}){
 if(!['simulation','real'].includes(mode)||!Number.isInteger(external)||external<0||external>250)throw Error('额度配置无效');
 let fmp=0,fred=0;for(const q of prior){if(q.version!==1||q.mode!==mode||q.day!==day||!Number.isSafeInteger(q.reservedFmp)||!Number.isSafeInteger(q.reservedFred)||q.reservedFmp<0||q.reservedFred<0)throw Error('预算工件校验失败，停止而非归零');fmp=Math.max(fmp,q.reservedFmp);fred=Math.max(fred,q.reservedFred);external=Math.max(external,q.externalFmpBaseline||0);}
 const add=mode==='real'?{fmp:6,fred:2}:{fmp:0,fred:0};if(fmp+add.fmp>20||fmp+add.fmp+external>250||fred+add.fred>4)throw Error('每日预算不足，未发送请求');
 return {version:1,mode,day,runId:String(runId),reservedFmp:fmp+add.fmp,reservedFred:fred+add.fred,externalFmpBaseline:external,state:'reserved'};
}
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
 if(previous){const old=checkBundle(previous,now);if(old.dates.includes(date))return {alreadyComplete:true,bundle:previous,counts:{FMP:0,FRED:0}};}
 const raw=path.join(dir,'private-input'),out=path.join(dir,'validated-output');await fs.mkdir(raw,{recursive:true});
 if(previous){await writeBundle(raw,previous);await writeBundle(out,previous);}
 const source=boundedSource(fetchImpl||(mode==='simulation'?sourceFetch(date,{incomplete}):fetch),date),opts={dir:raw,date,now,budget:6,key:mode==='simulation'?'MOCK_ONLY_NOT_A_CREDENTIAL':key,fetchImpl:source.request,testMode:mode==='simulation'};
 // Wait for both slower FRED sources before spending any FMP calls.
 await collectSox(opts);await collectExtra({...opts,symbol:'NBI'});
 const sox=JSON.parse(await fs.readFile(path.join(raw,'sox.json'))),nbi=JSON.parse(await fs.readFile(path.join(raw,'nbi.json')));
 if(core.soxForDate(sox,date).status!=='current'||core.dailySeriesForDate(nbi,'NBI',date).status!=='current')throw Error('FRED目标日尚未就绪；保留上一完整版本');
 await collect(opts);await syncPublic({sourceDir:raw,dir:out,now});const bundle=await loadBundle(out);checkBundle(bundle,now);return {alreadyComplete:false,bundle,counts:source.counts};
}
async function priorQuota(store,{mode,day,runId,root}){
 const prior=[];let page=1,finished=false;
 while(!finished){if(page>5)throw Error('当日任务过多，停止自动核对预算');const r=await store.api('/actions/workflows/update-market.yml/runs?per_page=100&page='+page);if(!r.workflow_runs?.length)break;
 for(const run of r.workflow_runs){if(String(run.id)===String(runId))continue;if(budgetDay(new Date(run.created_at))!==day){if(new Date(run.created_at)<new Date(day+'T00:00:00+08:00'))finished=true;continue;}
 const artifacts=await store.api('/actions/runs/'+run.id+'/artifacts?per_page=100');const names=artifacts.artifacts.filter(a=>a.name.startsWith('quota-'+mode+'-'+day+'-'));
 if(!names.length){if(artifacts.artifacts.some(a=>/^quota-(real|simulation)-/.test(a.name)))continue;const jobs=await store.api('/actions/runs/'+run.id+'/jobs');const reserved=jobs.jobs?.some(j=>j.steps?.some(s=>s.name==='Persist reservation before collection'&&s.conclusion==='success'));if(reserved)throw Error('既有预算工件缺失；为保护额度已停止');continue;}
 for(const item of names){if(item.expired)throw Error('预算工件过期，无法安全恢复');const dest=path.join(root,'quota-download',String(item.id));await fs.mkdir(dest,{recursive:true});try{cp.execFileSync('gh',['run','download',String(run.id),'--repo',REPO,'--name',item.name,'--dir',dest],{stdio:['ignore','pipe','pipe']});prior.push(JSON.parse(await fs.readFile(path.join(dest,'quota.json'),'utf8')));}catch{throw Error('无法恢复预算工件，停止而非重置');}}
 }if(r.workflow_runs.length<100)finished=true;page++;}
 return prior;
}
async function existingBundle(prefix){
 let pointer;try{pointer=JSON.parse(await fs.readFile(path.join(prefix,'latest.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!/^[a-f0-9]{64}$/.test(pointer.release)||pointer.kind!==(prefix==='market/v1'?'REAL_MARKET_DATA':'SYNTHETIC_TEST_ONLY'))throw Error('无效发布指针');
 const bundle=await loadBundle(path.join(prefix,'releases',pointer.release));checkBundle(bundle);if(pointer.manifestHash!==hash(bundle['manifest.json'])||pointer.latest!==bundle['manifest.json'].latest)throw Error('已发布清单不完整，停止而非覆盖');return {pointer,bundle};
}
async function bootstrapReal(store,root){
 // Executed only AFTER the real-publication gate. Seed all previously published real history.
 const origin='kkshow0105/monster-slayer-kit',ref='8996c60cd125dfd78736c3064eebfefa7cf94f11';
 async function read(name){const r=await fetch('https://api.github.com/repos/'+origin+'/contents/public-data/us-market/'+name+'?ref='+ref,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('既有真实历史种子不可用');const d=await r.json();return JSON.parse(Buffer.from(d.content,'base64').toString());}
 const m=await read('manifest.json'),files=['manifest.json','status.json','sox.json','nbi.json',...m.dates.map(d=>'snapshots/'+d+'.json')],bundle={};for(const f of files)bundle[f]=f==='manifest.json'?m:await read(f);checkBundle(bundle);return bundle;
}
async function main(){
 if(process.env.GITHUB_REPOSITORY!==REPO||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||!process.env.RUNNER_TEMP)throw Error('只允许独立仓库main手动任务');
 const mode=MODE();gate(mode,process.env.ALLOW_REAL_MARKET_PUBLICATION);const root=path.join(process.env.RUNNER_TEMP,'market-update');await fs.mkdir(root,{recursive:true});
 const action=process.argv[2],store=githubStore({token:process.env.GH_TOKEN}),date=process.env.TARGET_DATE||core.expectedSession(),day=budgetDay(new Date()),prefix=mode==='real'?'market/v1':'lab/publishing/v1';
 if(action==='prepare'){
  const existing=await existingBundle(prefix);if(existing?.bundle['manifest.json'].dates.includes(date)){await fs.appendFile(process.env.GITHUB_OUTPUT,'should_run=false\n');console.log('该交易日已完整保存；0次行情请求');return;}
  if(!core.isTradingDay(date)||date>core.expectedSession())throw Error('目标尚未收盘或为休市日');
  const prior=await priorQuota(store,{mode,day,runId:process.env.GITHUB_RUN_ID,root});
  const quota=reserveQuota({prior,mode,day,runId:process.env.GITHUB_RUN_ID,external:Number(process.env.EXTERNAL_FMP_CALLS||0)});await fs.mkdir(path.join(root,'quota'),{recursive:true});await atomicJson(path.join(root,'quota/quota.json'),quota);
  await atomicJson(path.join(root,'grant.json'),{mode,date,day,runId:process.env.GITHUB_RUN_ID,head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()});await fs.appendFile(process.env.GITHUB_OUTPUT,'should_run=true\nday='+day+'\n');console.log('预算已准备；等待工件持久化成功后才允许采集');
 }else if(action==='collect'){
  const grant=JSON.parse(await fs.readFile(path.join(root,'grant.json'),'utf8'));
  if(grant.runId!==process.env.GITHUB_RUN_ID||grant.day!==day||!/^\d+$/.test(process.env.RESERVATION_ARTIFACT_ID||''))throw Error('缺少当日持久化预算凭证');
  const artifact=await store.api('/actions/artifacts/'+process.env.RESERVATION_ARTIFACT_ID);if(artifact.expired||artifact.name!=='quota-'+mode+'-'+day+'-'+grant.runId+'-reserved')throw Error('持久化预算凭证不匹配');
  const quota=JSON.parse(await fs.readFile(path.join(root,'quota/quota.json'),'utf8'));
  try{
   if(mode==='real'&&!process.env.FMP_API_KEY?.trim())throw Error('缺少FMP Secret');
   const old=await existingBundle(prefix);const previous=old?.bundle||(mode==='real'?await bootstrapReal(store,root):null);
   const candidate=await buildCandidate({dir:root,date:grant.date,previous,mode,incomplete:process.env.SIMULATE_INCOMPLETE==='true',key:process.env.FMP_API_KEY});
   if(!candidate.alreadyComplete){const result=await publish({bundle:candidate.bundle,previous,kind:mode==='real'?'REAL_MARKET_DATA':'SYNTHETIC_TEST_ONLY',allowReal:mode==='real'&&process.env.ALLOW_REAL_MARKET_PUBLICATION==='USER_CONFIRMED',store,expectedHead:grant.head});console.log(JSON.stringify({mode,kind:result.pointer.kind,targetDate:grant.date,published:true,release:result.pointer.release,dates:result.dates,sourceRequests:mode==='real'?candidate.counts:{FMP:0,FRED:0},mockCalls:mode==='simulation'?candidate.counts:undefined}));}
   quota.state='complete';quota.completedDate=grant.date;
  }catch{quota.state='incomplete_or_failed';process.exitCode=1;console.error('未发布新版本；请查看来源是否就绪及配置，旧版保持不变。');}
  finally{await atomicJson(path.join(root,'quota/quota.json'),quota);}
 }else throw Error('未知工作流步骤');
}
module.exports={gate,reserveQuota,boundedSource,buildCandidate};
if(require.main===module)main().catch(()=>{console.error('任务安全停止，未启用真实发布或预算校验失败；没有输出原始响应。');process.exitCode=1;});
