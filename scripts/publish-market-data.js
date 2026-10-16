'use strict';
// Cloud-only publisher: the only writable paths are an immutable white-list release and its pointer.
const {createHash}=require('node:crypto');
const {checkBundle}=require('./public-market-data');
const {checkIndustryBundle}=require('./market-taxonomy');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const REPO='kkshow0105/ynm3000-data-lab-20261016';
function prepare({bundle,previous=null,kind='SYNTHETIC_TEST_ONLY',allowReal=false,now=new Date()}){
 if(!['SYNTHETIC_TEST_ONLY','REAL_MARKET_DATA'].includes(kind)||kind==='REAL_MARKET_DATA'&&!allowReal)throw Error('Real publication is disabled until final user confirmation');
 checkIndustryBundle(bundle);
 const checked=checkBundle(bundle,now);
 for(const date of checked.dates)for(const r of bundle['snapshots/'+date+'.json'].indices){const previous=bundle['snapshots/'+r.previousDate+'.json']?.indices.find(v=>v.symbol===r.symbol);if(previous&&previous.close!==r.previousClose)throw Error('相邻快照收盘价不一致');}
 if(previous){checkIndustryBundle(previous);const old=checkBundle(previous,now);for(const date of old.dates)if(!checked.dates.includes(date)||JSON.stringify(previous['snapshots/'+date+'.json'])!==JSON.stringify(bundle['snapshots/'+date+'.json']))throw Error('Publication must preserve every existing historical snapshot');for(const name of ['sox.json','nbi.json'])for(const row of previous[name].observations){const fresh=bundle[name].observations.find(r=>r.date===row.date);if(!fresh||fresh.close!==row.close)throw Error('Existing index history cannot be removed or revised silently');}}
 const prefix=kind==='REAL_MARKET_DATA'?'market/v1':'lab/publishing/v1';
 const ordered=Object.fromEntries(Object.keys(bundle).sort().map(k=>[k,bundle[k]])),release=hash({kind,bundle:ordered});
 const pointer={version:1,kind,release,latest:checked.latest,publishedAt:now.toISOString(),manifestHash:hash(bundle['manifest.json'])};
 const files=Object.fromEntries(checked.files.map(name=>[prefix+'/releases/'+release+'/'+name,JSON.stringify(bundle[name],null,2)+'\n']));
 files[prefix+'/latest.json']=JSON.stringify(pointer,null,2)+'\n';
 for(const secret of [process.env.FMP_API_KEY,process.env.FRED_API_KEY].filter(v=>v&&v.length>6))if(Object.values(files).some(text=>text.includes(secret)))throw Error('Private credential detected; publication blocked');
 return {pointer,prefix,files,coverage:checked.coverage,dates:checked.dates};
}
async function publish({bundle,previous,kind,allowReal,now,store,expectedHead}){
 const release=prepare({bundle,previous,kind,allowReal,now});
 // Check once before creating objects; a concurrent branch update cannot be overwritten.
 if(await store.head()!==expectedHead)throw Error('Data repository changed; keep the previous version and run later');
 const commit=await store.commit({parent:expectedHead,files:release.files,message:kind==='REAL_MARKET_DATA'?'data: publish complete market close '+release.pointer.latest:'test: publish clearly labelled synthetic close '+release.pointer.latest});
 await store.advance({from:expectedHead,to:commit});return {...release,commit};
}
function githubStore({token,fetchImpl=fetch}={}){
 if(!token)throw Error('GitHub runner credential required');
 async function api(suffix,method='GET',body){const r=await fetchImpl('https://api.github.com/repos/'+REPO+suffix,{method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw Error('GitHub publication HTTP '+r.status);return r.json();}
 return {api,async head(){return (await api('/git/ref/heads/main')).object.sha;},async commit({parent,files,message}){const old=await api('/git/commits/'+parent),tree=await api('/git/trees','POST',{base_tree:old.tree.sha,tree:Object.entries(files).map(([path,content])=>({path,content,mode:'100644',type:'blob'}))});const result=await api('/git/commits','POST',{message,tree:tree.sha,parents:[parent]});return result.sha;},async advance({from,to}){if(await this.head()!==from)throw Error('Concurrent update; previous release retained');await api('/git/refs/heads/main','PATCH',{sha:to,force:false});}};
}
module.exports={hash,prepare,publish,githubStore,REPO};
