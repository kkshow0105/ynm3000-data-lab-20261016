'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {buildCandidate}=require('../scripts/market-cloud'),{prepare}=require('../scripts/publish-market-data');
const NOW=new Date('2026-10-16T06:30:00Z');
async function makeBundle(date='2026-10-14',previous=null){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'market-publish-mock-'));try{return (await buildCandidate({dir,date,previous,now:NOW,mode:'simulation'})).bundle;}finally{await fs.rm(dir,{recursive:true,force:true});}}
function transport(publication){let reads=0;return {get reads(){return reads;},async fetch(url){reads++;const u=new URL(url),name=u.pathname.split('/main/')[1]||u.pathname.slice(1);const content=publication.files[name];return new Response(content||'missing',{status:content?200:404,headers:{'Content-Type':'application/json'}});}};}
function memoryStore(){let head='initial',files={},candidate;return {get files(){return files;},get tip(){return head;},fail:false,async head(){return head;},async commit(p){candidate=p;return 'commit-'+Object.keys(p.files).length;},async advance({from,to}){if(this.fail||head!==from)throw Error('Mock Git ref failure');files={...files,...candidate.files};head=to;}};}
module.exports={NOW,makeBundle,transport,memoryStore,prepare};
