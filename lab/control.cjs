'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const core=require('../tools/us-market/market-core'),{budgetDay}=require('../scripts/collect-us-market'),{ID}=require('./verify-cloud.cjs');
const repo='kkshow0105/ynm3000-data-lab-20261016',file='lab/cloud-budget.json';
function reserve(old,{runId,targetDate,now=new Date()}){
 const ledger=structuredClone(old),day=budgetDay(now);
 if(ledger.version!==1||ledger.kind!=='CLOUD_VALIDATION_BUDGET_ONLY'||ledger.containsMarketData!==false||ledger.dailyLimit!==20||!Array.isArray(ledger.experiments)||!ledger.days)throw Error('Budget schema invalid');
 if(ledger.experiments.some(e=>e.id===ID))return {skip:true,reason:'Experiment already reserved or completed; no duplicate requests'};
 if(!core.isTradingDay(targetDate)||targetDate>core.expectedSession(now))throw Error('Not a completed trading session');
 const d=ledger.days[day];if(!d||![d.reservedFmp,d.reservedFred,d.externalFmpBaseline].every(Number.isSafeInteger)||Math.min(d.reservedFmp,d.reservedFred,d.externalFmpBaseline)<0)throw Error('Approved daily baseline required');
 if(d.reservedFmp+6>20||d.reservedFmp+d.externalFmpBaseline+6>250||d.reservedFred+2>2)throw Error('Persistent budget exhausted');
 const grant={experiment:ID,runId:String(runId),targetDate,day,fmp:6,fred:2};
 d.reservedFmp+=6;d.reservedFred+=2;ledger.experiments.push({id:ID,runId:String(runId),targetDate,day,reservedAt:now.toISOString(),fmp:6,fred:2,state:'reserved'});
 return {skip:false,ledger,grant};
}
function finish(old,runId,summary){
 const next=structuredClone(old),e=next.experiments.find(e=>e.id===ID&&e.runId===String(runId));if(!e)throw Error('Reservation not found');
 // Do not refund reservations, even if the job failed or was cancelled before all HTTP requests.
 e.state=summary?'verification_finished':'interrupted';e.finishedAt=new Date().toISOString();
 if(summary){if(summary.kind!=='CLOUD_CONNECTION_CHECK_ONLY'||summary.experiment!==ID||summary.containsMarketPrices!==false||summary.publication!=='DISABLED'||summary.targetDate!==e.targetDate||!Number.isInteger(summary.counts.FMP)||summary.counts.FMP<0||summary.counts.FMP>6||!Number.isInteger(summary.counts.FRED)||summary.counts.FRED<0||summary.counts.FRED>2)throw Error('Unsafe summary');e.attemptedFmp=summary.counts.FMP;e.attemptedFred=summary.counts.FRED;e.validationComplete=summary.complete===true;}
 return next;
}
async function main(){
 if(process.env.GITHUB_REPOSITORY!==repo||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REF!=='refs/heads/main'||!process.env.GH_TOKEN||!process.env.RUNNER_TEMP)throw Error('Approved manual runner required');
 const mode=process.argv[2],root=path.resolve(process.env.RUNNER_TEMP);
 async function api(suffix,options={}){const r=await fetch('https://api.github.com/repos/'+repo+suffix,{...options,headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('Ledger GitHub HTTP '+r.status);return r.json();}
 const before=await api('/contents/'+file+'?ref=main'),old=JSON.parse(Buffer.from(before.content,'base64').toString('utf8'));
 let next;
 if(mode==='reserve'){
  const r=reserve(old,{runId:process.env.GITHUB_RUN_ID,targetDate:core.expectedSession(new Date())});
  if(r.skip){await fs.appendFile(process.env.GITHUB_OUTPUT,'should_run=false\n');console.log(r.reason);return;}
  next=r.ledger;
  // The successful remote SHA-guarded commit MUST precede the local grant and all market requests.
  await api('/contents/'+file,{method:'PUT',body:JSON.stringify({message:'test: reserve bounded cloud verification budget',sha:before.sha,branch:'main',content:Buffer.from(JSON.stringify(next,null,2)+'\n').toString('base64')})});
  await fs.writeFile(path.join(root,'ynm-cloud-grant.json'),JSON.stringify(r.grant),{mode:0o600});await fs.appendFile(process.env.GITHUB_OUTPUT,'should_run=true\n');console.log('Reserved FMP 6 / FRED 2; no raw market data committed.');
 }else if(mode==='finish'){
  let summary=null;try{summary=JSON.parse(await fs.readFile(path.join(root,'ynm-cloud-summary.json'),'utf8'));}catch{}
  next=finish(old,process.env.GITHUB_RUN_ID,summary);
  await api('/contents/'+file,{method:'PUT',body:JSON.stringify({message:'test: record cloud verification request counts only',sha:before.sha,branch:'main',content:Buffer.from(JSON.stringify(next,null,2)+'\n').toString('base64')})});console.log('Persisted counts only. Reservations retained conservatively.');
 }else throw Error('Unknown control action');
}
module.exports={reserve,finish};
if(require.main===module)main().catch(()=>{console.error('Budget control stopped safely. No market requests authorized without reservation.');process.exitCode=1;});
