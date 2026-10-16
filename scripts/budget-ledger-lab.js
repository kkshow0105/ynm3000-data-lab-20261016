'use strict';
// Mock-only Actions harness: there is no market URL, provider key, or market collector import.
const fs=require('node:fs/promises'),assert=require('node:assert/strict');
const {REPO,createGitBudgetStore,reserveAndVerify,verifyGrant}=require('./git-budget-ledger');
async function main(){
 if(process.env.GITHUB_REPOSITORY!==REPO||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_RUN_ATTEMPT!=='1'||process.env.ALLOW_REAL_MARKET_PUBLICATION!=='DISABLED')throw Error('Only the approved manual Mock run with real publication DISABLED is allowed');
 const token=process.env.GH_TOKEN;if(!token)throw Error('GitHub runner token missing');
 const api=async(p,method='GET',body)=>{const response=await fetch('https://api.github.com/repos/'+REPO+p,{method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000),redirect:'error'});if(!response.ok){const e=Error('GitHub budget HTTP '+response.status);e.status=response.status;e.httpBody=await response.text();e.method=method;e.path=p;e.requestId=response.headers.get('x-github-request-id');e.category=classifyGitError(e);throw e;}return response.json();};
 const store=createGitBudgetStore({api,genesis:process.env.BUDGET_GENESIS_SHA}),before=await store.read(),now=new Date();
 const request={id:'github-'+process.env.GITHUB_RUN_ID,namespace:'simulation',targetDate:now.toISOString().slice(0,10),cost:{fmp:1,fred:0},external:{known:true,fmp:0,fred:0,observedAt:now.toISOString(),coversFrom:new Date(now.getTime()-172800000).toISOString()}};
 const grant=await reserveAndVerify(store,request,{now});assert.equal(grant.status,'reserved');assert.equal(grant.authorized,true);let virtualCalls=0;
 if(grant.authorized){await verifyGrant(store,grant);virtualCalls++;} // A counter only, never HTTP.
 const duplicate=await reserveAndVerify(store,request);if(duplicate.authorized||duplicate.status!=='duplicate')throw Error('Duplicate task unexpectedly authorized');
 const after=await store.read();assert.equal(after.head,grant.head);assert.equal(after.ledger.revision,before.ledger.revision+1);assert.deepEqual(after.ledger.reservations.slice(0,-1),before.ledger.reservations);assert.equal(after.ledger.reservations.at(-1).namespace,'simulation');assert.equal(virtualCalls,1);
 const proof={kind:'BUDGET_MOCK_PROOF',runId:process.env.GITHUB_RUN_ID,priorReservations:before.ledger.reservations.length,priorHead:before.head,reservedCommit:grant.head,readbackCommit:after.head,readbackHash:after.ledger.integrity,revision:after.ledger.revision,virtualCalls,duplicateBlocked:true,realRequests:{FMP:0,FRED:0},realPublication:'DISABLED'};
 console.log(JSON.stringify(proof,null,2));if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'## Git budget Mock proof\n```json\n'+JSON.stringify(proof,null,2)+'\n```\n');
}
function classifyGitError(e,context={}){
 if(e.status===422){let message='';try{const body=JSON.parse(e.httpBody);message=[body.message,...(body.errors||[]).map(x=>typeof x==='string'?x:x.message||x.code||'')].join(' ');}catch{}
  const explicit=/(?:not (?:a )?fast[ -]forward|fast[ -]forward update|reference update failed.*expected)/i.test(message);
  const proven=context.force===false&&context.candidateParent===context.expectedHead&&context.actualHead!==context.expectedHead&&/^[a-f0-9]{40}$/.test(context.actualHead||'')&&context.comparisonStatus==='diverged';
  return explicit||(/^Reference cannot be updated$/i.test(message.trim())&&proven)?'version_conflict':'unprocessable_request';
 }
 return e.status?'http_error':'transport_error';
}
function diagnostic(e){
 const value={name:e.name,code:e.code,message:e.message,stack:e.stack,status:e.status,httpBody:e.httpBody,method:e.method,path:e.path,requestId:e.requestId,transportCode:e.transportCode,transportDetail:e.transportDetail,category:e.category||(e.code?.startsWith('BUDGET_')?'budget_stop':classifyGitError(e)),conflictEvidence:e.conflictEvidence,operator:e.operator,actual:e.actual,expected:e.expected,phase:e.phase,expectedParent:e.expectedParent,expectedHead:e.expectedHead,actualHead:e.actualHead,reconciliation:e.reconciliation,cause:e.cause?diagnostic(e.cause):undefined,readbackCause:e.readbackCause?diagnostic(e.readbackCause):undefined};
 let text=JSON.stringify(value);for(const key of ['GH_TOKEN','GITHUB_TOKEN','FMP_API_KEY','FRED_API_KEY']){const secret=process.env[key];if(secret&&secret.length>6)text=text.split(secret).join('[REDACTED]');}return JSON.parse(text);
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({status:'stopped',realRequests:{FMP:0,FRED:0},error:diagnostic(e)}));process.exitCode=1;});

module.exports={classifyGitError,diagnostic};
