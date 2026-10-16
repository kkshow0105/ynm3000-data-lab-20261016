'use strict';
// Git-only budget protocol. No market API, Raw CDN, artifact, or implicit initialization.
const {createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const REPO='kkshow0105/ynm3000-data-lab-20261016',BRANCH='budget-ledger';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const integer=(x,max=100000)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const keys=(x,n)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...n].sort().join(',');
function stop(code,message){const e=Error(message+'；禁止API请求');e.code=code;return e;}
function seal(value){const x=structuredClone(value);delete x.integrity;x.integrity=hash(x);return x;}
function initialLedger({now=new Date(),knownExternal={fmp:6,fred:2,at:'2026-10-16T06:14:11.884Z'}}={}){
 return seal({version:1,kind:'SANITIZED_BUDGET_LEDGER',containsMarketData:false,revision:0,previousHash:null,createdAt:now.toISOString(),updatedAt:now.toISOString(),policy:{projectRollingHours:24,projectFmpLimit:20,projectFredLimit:4,providerFmpDailyLimit:250,providerReset:{status:'UNCONFIRMED',utcHour:null},simulationResetUtcHour:20},knownExternal,reservations:[]});
}
function validateLedger(x){
 if(!keys(x,['version','kind','containsMarketData','revision','previousHash','createdAt','updatedAt','policy','knownExternal','reservations','integrity'])||x.version!==1||x.kind!=='SANITIZED_BUDGET_LEDGER'||x.containsMarketData!==false||!integer(x.revision)||!iso(x.createdAt)||!iso(x.updatedAt)||Date.parse(x.updatedAt)<Date.parse(x.createdAt)||!Array.isArray(x.reservations)||x.reservations.length>10000)throw stop('BUDGET_SCHEMA','预算格式或日期错误');
 const unsigned={...x};delete unsigned.integrity;if(x.integrity!==hash(unsigned))throw stop('BUDGET_INTEGRITY','预算内容完整性错误');
 if(x.revision===0?x.previousHash!==null:!(/^[a-f0-9]{64}$/.test(x.previousHash)))throw stop('BUDGET_CHAIN','预算链错误');
 const p=x.policy;if(!keys(p,['projectRollingHours','projectFmpLimit','projectFredLimit','providerFmpDailyLimit','providerReset','simulationResetUtcHour'])||p.projectRollingHours!==24||p.projectFmpLimit!==20||p.projectFredLimit!==4||p.providerFmpDailyLimit!==250||p.simulationResetUtcHour!==20||!keys(p.providerReset,['status','utcHour'])||!['UNCONFIRMED','ACCOUNT_CONFIRMED_FIXED_UTC'].includes(p.providerReset.status)||(p.providerReset.status==='UNCONFIRMED'?p.providerReset.utcHour!==null:!integer(p.providerReset.utcHour,23)))throw stop('BUDGET_POLICY','配额策略缺失或不明');
 const k=x.knownExternal;if(!keys(k,['fmp','fred','at'])||!integer(k.fmp,250)||!integer(k.fred,100)||!iso(k.at))throw stop('BUDGET_EXTERNAL','已知外部基线损坏');
 const ids=new Set();let last=Date.parse(x.createdAt);
 for(const r of x.reservations){
  if(!keys(r,['id','namespace','at','targetDate','cost','external','periodStart'])||typeof r.id!=='string'||!/^[-A-Za-z0-9:]{1,100}$/.test(r.id)||ids.has(r.id)||!['simulation','real'].includes(r.namespace)||!iso(r.at)||Date.parse(r.at)<last||Date.parse(r.at)>Date.parse(x.updatedAt)||!/^\d{4}-\d\d-\d\d$/.test(r.targetDate)||!keys(r.cost,['fmp','fred'])||!integer(r.cost.fmp,6)||!integer(r.cost.fred,2)||r.cost.fmp+r.cost.fred===0||!keys(r.external,['known','fmp','fred','observedAt','coversFrom'])||r.external.known!==true||!integer(r.external.fmp,250)||!integer(r.external.fred,100)||!iso(r.external.observedAt)||!iso(r.external.coversFrom)||!iso(r.periodStart))throw stop('BUDGET_RESERVATION','预算记录身份或字段错误');
  if(r.namespace==='real'&&(r.cost.fmp!==6||r.cost.fred!==2))throw stop('BUDGET_RESERVATION','真实采集预留必须覆盖最大6+2请求');
  ids.add(r.id);last=Date.parse(r.at);
 }
 if(x.revision!==x.reservations.length)throw stop('BUDGET_CHAIN','预算版本与预留数量不一致');return x;
}
function period(now,hour){const t=new Date(now);let start=Date.UTC(t.getUTCFullYear(),t.getUTCMonth(),t.getUTCDate(),hour);if(t.getTime()<start)start-=86400000;return {start,end:start+86400000};}
function planReservation(ledger,request,now=new Date()){
 validateLedger(ledger);const ms=now.getTime();if(ms<Date.parse(ledger.updatedAt))throw stop('BUDGET_CLOCK','时钟落后于已持久化预算');
 if(ledger.reservations.some(r=>r.id===request.id))return {status:'duplicate',authorized:false};
 const {namespace,external,cost}=request;if(!['simulation','real'].includes(namespace))throw stop('BUDGET_NAMESPACE','预算范围错误');
 const reset=ledger.policy.providerReset;if(namespace==='real'&&reset.status!=='ACCOUNT_CONFIRMED_FIXED_UTC')throw stop('BUDGET_RESET_UNCONFIRMED','供应商账户重置规则尚未确认');
 const window=period(now,namespace==='simulation'?ledger.policy.simulationResetUtcHour:reset.utcHour),rolling=ms-86400000,coverage=Math.min(rolling,window.start);
 if(!external||external.known!==true||!integer(external.fmp,250)||!integer(external.fred,100)||!iso(external.observedAt)||Math.abs(ms-Date.parse(external.observedAt))>300000||!iso(external.coversFrom)||Date.parse(external.coversFrom)>coverage)throw stop('BUDGET_EXTERNAL_UNKNOWN','外部消耗未知、未覆盖额度窗口或确认已过期');
 const known=ledger.knownExternal;if(namespace==='real'&&Date.parse(known.at)>=coverage&&(external.fmp<known.fmp||external.fred<known.fred))throw stop('BUDGET_EXTERNAL_LOW','外部声明低于已知旧实验消耗');
 const previous=ledger.reservations.filter(r=>r.namespace===namespace),recent=previous.filter(r=>Date.parse(r.at)>rolling),daily=previous.filter(r=>Date.parse(r.at)>=window.start);
 const ext={fmp:external.fmp,fred:external.fred};for(const r of recent){ext.fmp=Math.max(ext.fmp,r.external.fmp);ext.fred=Math.max(ext.fred,r.external.fred);}
 const sum=(rows,k)=>rows.reduce((n,r)=>n+r.cost[k],0);
 if(!cost||!integer(cost.fmp,6)||!integer(cost.fred,2)||cost.fmp+cost.fred===0||namespace==='real'&&(cost.fmp!==6||cost.fred!==2))throw stop('BUDGET_COST','预留量无效');
 if(sum(recent,'fmp')+ext.fmp+cost.fmp>20||sum(recent,'fred')+ext.fred+cost.fred>4||sum(daily,'fmp')+ext.fmp+cost.fmp>250)throw stop('BUDGET_EXHAUSTED','额度不足（含滚动24小时及外部消耗）');
 const row={id:request.id,namespace,at:now.toISOString(),targetDate:request.targetDate,cost:{...cost},external:{...external},periodStart:new Date(window.start).toISOString()};
 const candidate=seal({...ledger,revision:ledger.revision+1,previousHash:ledger.integrity,updatedAt:now.toISOString(),reservations:[...ledger.reservations,row]});validateLedger(candidate);
 return {status:'planned',candidate,row,expiresAt:new Date(Math.min(ms+600000,window.end)).toISOString()};
}
function validateTransition(parent,child){validateLedger(parent);validateLedger(child);if(child.previousHash!==parent.integrity||child.revision!==parent.revision+1||!equal(child.reservations.slice(0,-1),parent.reservations)||!equal(child.policy,parent.policy)||!equal(child.knownExternal,parent.knownExternal)||child.createdAt!==parent.createdAt)throw stop('BUDGET_CHAIN','预算历史被覆盖或策略未经单独审核');}
async function reserveAndVerify(store,request,{now=new Date()}={}){
 const before=await store.read();const plan=planReservation(before.ledger,request,now);if(plan.status==='duplicate')return plan;
 let commit;try{commit=await store.commit(before,plan.candidate);}catch(cause){
  const error=stop('BUDGET_WRITE_UNCERTAIN','预留写入失败或结果不确定；不重试、不退款');error.cause=cause;
  error.phase='commit';error.reservationId=plan.row.id;error.expectedParent=before.head;
  // Diagnostic read only: even a confirmed persisted row NEVER grants source access after a failed write response.
  try{const observed=await store.read();validateLedger(observed.ledger);error.reconciliation={status:equal(observed.ledger.reservations.find(r=>r.id===plan.row.id),plan.row)?'persisted':'not_observed',head:observed.head,ledgerHash:observed.ledger.integrity,authorized:false};}
  catch(readError){error.reconciliation={status:'unknown',authorized:false};error.readbackCause=readError;}
  throw error;
 }
 let after;try{after=await store.read();}catch(cause){const error=stop('BUDGET_READBACK_FAILED','预留提交后读回失败；保留预留');error.cause=cause;error.phase='readback';error.expectedHead=commit;throw error;}
 if(after.head!==commit||!equal(after.ledger,plan.candidate))throw stop('BUDGET_READBACK_MISMATCH','读回版本与预留提交不一致');
 return {status:'reserved',authorized:true,head:commit,id:plan.row.id,ledgerHash:after.ledger.integrity,row:plan.row,expiresAt:plan.expiresAt};
}
async function verifyGrant(store,grant,{now=new Date()}={}){
 if(grant?.authorized!==true||!iso(grant.expiresAt)||Date.parse(grant.expiresAt)<=now.getTime())throw stop('BUDGET_GRANT','授权缺失或已过期');
 const current=await store.read();if(current.head!==grant.head||current.ledger.integrity!==grant.ledgerHash||!equal(current.ledger.reservations.find(r=>r.id===grant.id),grant.row))throw stop('BUDGET_GRANT','持久化授权无法核对');return grant;
}
function createGitBudgetStore({api,genesis}){
 if(typeof api!=='function'||!(/^[a-f0-9]{40}$/.test(genesis)))throw stop('BUDGET_CONFIG','必须固定预算分支初始化提交');
 const ref='/git/ref/heads/'+BRANCH;
 async function fileAt(commit){const r=await api('/contents/ledger.json?ref='+commit);if(r.encoding!=='base64'||typeof r.content!=='string'||r.size>2000000)throw stop('BUDGET_FILE','预算文件缺失或过大');let value;try{value=JSON.parse(Buffer.from(r.content,'base64').toString('utf8'));}catch{throw stop('BUDGET_FILE','预算JSON损坏');}return validateLedger(value);}
 async function read(){
  let head;try{head=(await api(ref)).object.sha;}catch{throw stop('BUDGET_BRANCH_MISSING','预算分支缺失或无法读取；禁止自动初始化');}
  const c=await api('/git/commits/'+head),tree=await api('/git/trees/'+c.tree.sha+'?recursive=1');
  if(tree.truncated||!equal(tree.tree.map(f=>f.path).sort(),['README.md','ledger.json'])||tree.tree.some(f=>f.type!=='blob'||f.mode!=='100644'))throw stop('BUDGET_TREE','预算分支文件不符合白名单');
  const ancestry=await api('/compare/'+genesis+'...'+head);if(!['identical','ahead'].includes(ancestry.status)||ancestry.behind_by!==0)throw stop('BUDGET_ANCESTRY','预算分支偏离固定初始化历史');
  const ledger=await fileAt(head);
  if(ledger.revision===0){if(head!==genesis||c.parents.length!==0)throw stop('BUDGET_GENESIS','初始化提交身份不符');}
  else{if(c.parents.length!==1)throw stop('BUDGET_CHAIN','预算分支不得合并');validateTransition(await fileAt(c.parents[0].sha),ledger);}
  return {head,ledger,tree:c.tree.sha};
 }
 async function commit(before,candidate){
  validateTransition(before.ledger,candidate);const actualHead=(await api(ref)).object.sha;if(actualHead!==before.head){const error=stop('BUDGET_CONFLICT','预算分支已更新');error.expectedHead=before.head;error.actualHead=actualHead;throw error;}
  const tree=await api('/git/trees','POST',{base_tree:before.tree,tree:[{path:'ledger.json',mode:'100644',type:'blob',content:JSON.stringify(candidate,null,2)+'\n'}]});
  const c=await api('/git/commits','POST',{message:'budget: reserve '+candidate.reservations.at(-1).namespace+' '+candidate.reservations.at(-1).id,tree:tree.sha,parents:[before.head]});
  await api('/git/refs/heads/'+BRANCH,'PATCH',{sha:c.sha,force:false});return c.sha;
 }
 return {read,commit};
}
module.exports={REPO,BRANCH,hash,seal,initialLedger,validateLedger,period,planReservation,validateTransition,reserveAndVerify,verifyGrant,createGitBudgetStore,stop};
