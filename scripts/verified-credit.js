'use strict';
// Verified account credits; no clock-based replenishment, no source HTTP, no separate storage.
const {createHash}=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const MAX_EVIDENCE_AGE_MS=86400000;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fields=(x,n)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...n].sort().join(',');
const integer=(n,max=250)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
const iso=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
function fail(code,text){const e=Error(text+'；禁止API请求');e.code=code;throw e;}
function validateEvidence(e,now){
 if(!fields(e,['version','id','source','observedAt','used','remaining','accountedThroughRevision','verified'])||e.version!==1||e.source!=='USER_VERIFIED_FMP_DASHBOARD'||e.verified!==true||!iso(e.observedAt)||!integer(e.used)||!integer(e.remaining)||e.used+e.remaining!==250||!integer(e.accountedThroughRevision,10000))fail('BUDGET_EVIDENCE_INVALID','账户额度证据不完整');
 const unsigned={...e};delete unsigned.id;if(e.id!==sha(unsigned))fail('BUDGET_EVIDENCE_INVALID','额度证据身份不匹配');
 const age=now.getTime()-Date.parse(e.observedAt);if(age<0||age>MAX_EVIDENCE_AGE_MS)fail('BUDGET_EVIDENCE_STALE','账户额度证据超过24小时或来自未来，请更新用量证据');
 return e;
}
function makeEvidence({observedAt,used,remaining,accountedThroughRevision,verified}){const x={version:1,source:'USER_VERIFIED_FMP_DASHBOARD',observedAt,used,remaining,accountedThroughRevision,verified};return {...x,id:sha(x)};}
function creditPlan(ledger,request,now){
 const evidence=validateEvidence(request.credit,now),external=request.external,rows=ledger.reservations;
 if(!external||external.known!==true||!integer(external.fmp)||!integer(external.fred,100)||!iso(external.observedAt)||!iso(external.coversFrom)||Math.abs(now.getTime()-Date.parse(external.observedAt))>300000||Date.parse(external.observedAt)<Date.parse(evidence.observedAt)||Date.parse(external.coversFrom)>Date.parse(evidence.observedAt))fail('BUDGET_EXTERNAL_UNKNOWN','必须核实截图后账本外FMP/FRED消耗，不能默认0');
 if(request.namespace!=='real'||!equal(request.cost,{fmp:6,fred:2}))fail('BUDGET_COST','额度证据只用于真实批次最大6+2预留');
 const creditRows=rows.filter(r=>r.namespace==='real'&&r.credit),latest=creditRows.at(-1),same=creditRows.filter(r=>r.credit.evidence.id===evidence.id);
 let checkpoint;
 if(same.length){if(!equal(same[0].credit.evidence,evidence)||latest.credit.evidence.id!==evidence.id)fail('BUDGET_EVIDENCE_ROLLBACK','不能改写或重新使用旧额度池');checkpoint=same[0].credit.checkpoint;
  if(external.fmp<Math.max(...same.map(r=>r.external.fmp))||external.fred<Math.max(...same.map(r=>r.external.fred)))fail('BUDGET_EXTERNAL_LOW','截图后累计外部消耗不能减少');
 }else{
  if(evidence.accountedThroughRevision!==rows.length||rows.some(r=>r.namespace==='real'&&Date.parse(r.at)>=Date.parse(evidence.observedAt))||latest&&Date.parse(evidence.observedAt)<=Date.parse(latest.credit.evidence.observedAt))fail('BUDGET_EVIDENCE_RECONCILE','新证据必须晚于已有真实预留并明确覆盖当前历史，不能改日期清空额度');
  checkpoint={revision:rows.length,reservationsHash:sha(rows)};
 }
 if(checkpoint.revision!==evidence.accountedThroughRevision||checkpoint.reservationsHash!==sha(rows.slice(0,checkpoint.revision)))fail('BUDGET_EVIDENCE_RECONCILE','额度池历史锚点损坏');
 const held=rows.slice(checkpoint.revision).filter(r=>r.namespace==='real').reduce((n,r)=>n+r.cost.fmp,0),available=evidence.remaining-held-external.fmp;
 if(available<request.cost.fmp)fail('BUDGET_EXHAUSTED','已核实额度池余额不足，不自动恢复额度');
 const rolling=now.getTime()-86400000,recent=rows.filter(r=>r.namespace==='real'&&Date.parse(r.at)>rolling),groups=new Map();
 for(const r of recent){const key=r.credit?.evidence.id||'legacy';const v=groups.get(key)||{fmp:0,fred:0};v.fmp=Math.max(v.fmp,r.external.fmp);v.fred=Math.max(v.fred,r.external.fred);groups.set(key,v);}
 const current=groups.get(evidence.id)||{fmp:0,fred:0};current.fmp=Math.max(current.fmp,external.fmp);current.fred=Math.max(current.fred,external.fred);groups.set(evidence.id,current);
 const outside=[...groups.values()].reduce((a,v)=>({fmp:a.fmp+v.fmp,fred:a.fred+v.fred}),{fmp:0,fred:0}),known=Date.parse(ledger.knownExternal.at)>rolling?ledger.knownExternal:{fmp:0,fred:0};
 const projectFmp=recent.reduce((n,r)=>n+r.cost.fmp,0)+Math.max(known.fmp,evidence.used)+outside.fmp+request.cost.fmp,projectFred=recent.reduce((n,r)=>n+r.cost.fred,0)+known.fred+outside.fred+request.cost.fred;
 if(projectFmp>20||projectFred>4)fail('BUDGET_EXHAUSTED','滚动24小时项目保护额度不足；账户截图不清除项目调用历史');
 return {credit:{mode:'VERIFIED_REMAINING',evidence:structuredClone(evidence),checkpoint:structuredClone(checkpoint),remainingBefore:available,remainingAfter:available-request.cost.fmp},expiresAt:new Date(Math.min(now.getTime()+600000,Date.parse(evidence.observedAt)+MAX_EVIDENCE_AGE_MS)).toISOString()};
}
function validateCreditRow(ledger,row,index){if(!fields(row.credit,['mode','evidence','checkpoint','remainingBefore','remainingAfter'])||row.credit.mode!=='VERIFIED_REMAINING'||!fields(row.credit.checkpoint,['revision','reservationsHash']))fail('BUDGET_EVIDENCE_INVALID','已保存额度凭证字段错误');const expected=creditPlan({...ledger,reservations:ledger.reservations.slice(0,index)},{...row,credit:row.credit.evidence},new Date(row.at));if(!equal(expected.credit,row.credit))fail('BUDGET_EVIDENCE_INVALID','已保存额度扣减与历史不一致');}
module.exports={MAX_EVIDENCE_AGE_MS,makeEvidence,validateEvidence,creditPlan,validateCreditRow};
