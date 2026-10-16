'use strict';
// Only synthetic fixtures; this module never requests or reads actual market files.
const core=require('../tools/us-market/market-core');
const price=d=>1000+Math.round((Date.parse(d)-Date.parse('2026-01-01'))/86400000);
const sectors=['Basic Materials','Communication Services','Consumer Cyclical','Consumer Defensive','Energy','Financial Services','Healthcare','Industrials','Real Estate','Technology','Utilities'];
function sourceFetch(target,{incomplete=false}={}){return async url=>{
 const u=new URL(url),q=u.searchParams,previous=core.previousSession(target);
 if(u.hostname==='fred.stlouisfed.org'){
  const dates=[];let d=core.shift(target,-25);for(;d<=target;d=core.shift(d,1))if(core.isTradingDay(d)&&!(incomplete&&d===target))dates.push(d);
  return new Response('observation_date,'+q.get('id')+'\n'+dates.map(d=>d+','+price(d)).join('\n')+'\n');
 }
 if(u.pathname.endsWith('/full'))return Response.json([{symbol:q.get('symbol'),date:target,close:price(target),changePercent:-999},{symbol:q.get('symbol'),date:previous,close:price(previous)}]);
 const kind=u.pathname.includes('industry')?'industry':'sector',exchange=q.get('exchange'),names=kind==='sector'?sectors:Array.from({length:exchange==='NASDAQ'?127:128},(_,i)=>'Synthetic Industry '+i);
 return Response.json(names.map((name,i)=>({date:target,exchange,[kind]:name,averageChange:i%2?1.25:-2.5})));
};}
module.exports={sourceFetch};
