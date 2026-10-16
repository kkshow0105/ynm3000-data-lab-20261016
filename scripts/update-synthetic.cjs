'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const kind='SYNTHETIC_TEST_ONLY',encode=v=>JSON.stringify(v,null,2)+'\n',hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function identity(v){if(v?.schemaVersion!==1||v.kind!==kind||v.containsMarketData!==false)throw Error('Not synthetic data');}
function validate(root,m){identity(m);if(!Array.isArray(m.history)||!m.history.length)throw Error('Missing history');const seen=new Set();for(const e of m.history){if(!Number.isSafeInteger(e.sequence)||!/^snapshots\/synthetic-\d+\.json$/.test(e.path)||seen.has(e.batch)||!Number.isFinite(Date.parse(e.generatedAt)))throw Error('Invalid manifest entry');seen.add(e.batch);const text=fs.readFileSync(path.join(root,e.path),'utf8'),s=JSON.parse(text);identity(s);if(hash(text)!==e.sha256||s.sequence!==e.sequence||s.batch!==e.batch||s.complete!==true||s.generatedAt!==e.generatedAt)throw Error('Incomplete or corrupt snapshot');}if(JSON.stringify(m.latest)!==JSON.stringify(m.history.at(-1)))throw Error('Latest/history mismatch');}
function update(root,env=process.env){
 if(env.EVENT_NAME!=='workflow_dispatch')throw Error('Manual event required');
 const file=path.join(root,'manifest.json'),m=JSON.parse(fs.readFileSync(file,'utf8'));validate(root,m);
 const batch=env.BATCH||'';if(!/^[a-z0-9-]{1,40}$/.test(batch))throw Error('Invalid synthetic batch');
 if(env.SIMULATE_FAILURE==='true')throw Error('Intentional failure before publication');
 if(env.SIMULATE_INCOMPLETE==='true')throw Error('Readiness validation failed; previous data retained');
 if(m.history.some(e=>e.batch===batch))return {changed:false,sequence:m.latest.sequence,reason:'Batch already complete'};
 const sequence=m.latest.sequence+1;if(sequence>8)throw Error('Experiment sample limit reached');
 const s={schemaVersion:1,kind,containsMarketData:false,sequence,batch,complete:true,generatedAt:new Date().toISOString(),trigger:env.EVENT_NAME,runId:env.RUN_ID||'LOCAL_MOCK',message:'Synthetic transport sample. No market prices or trading dates.'};
 const text=encode(s),entry={sequence,batch,path:'snapshots/synthetic-'+sequence+'.json',sha256:hash(text),generatedAt:s.generatedAt};
 const next={schemaVersion:1,kind,containsMarketData:false,updatedAt:s.generatedAt,latest:entry,history:[...m.history,entry]};
 const target=path.join(root,entry.path);if(fs.existsSync(target))throw Error('Refusing to replace existing history');fs.writeFileSync(target,text);validate(root,next);fs.writeFileSync(file,encode(next));fs.writeFileSync(path.join(root,'test.json'),text);return {changed:true,sequence,batch};
}
module.exports={update,validate,encode,hash,identity};
if(require.main===module)console.log(JSON.stringify(update(process.cwd())));
