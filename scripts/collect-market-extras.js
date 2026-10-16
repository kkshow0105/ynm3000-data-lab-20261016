'use strict';
// Supplemental FRED daily series, manual only. SOX remains on its existing collector.
const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('../tools/us-market/market-core');
const { readJson, atomicJson, budgetDay, DATA_DIR } = require('./collect-us-market');
async function collectExtra(options = {}) {
  const symbol = options.symbol;
  if (!Object.hasOwn(core.DAILY_SERIES,symbol)) throw new Error('只支持NBI或BRENT');
  if ((options.testMode && !options.fetchImpl) || (process.env.NODE_TEST_CONTEXT && !options.testMode)) throw new Error('测试必须显式注入Mock');
  const definition = core.DAILY_SERIES[symbol], now = options.now || new Date(), dir = options.dir || DATA_DIR;
  const date = options.date || core.expectedSession(now);
  if (!core.isTradingDay(date) || date > core.expectedSession(now)) throw new Error('仅允许已收盘的美股观察日期');
  await fs.mkdir(dir,{recursive:true});
  const prefix = symbol.toLowerCase(), file = path.join(dir,prefix+'.json'), ledgerFile = path.join(dir,prefix+'-requests.json'), lockFile = path.join(dir,'collect-'+prefix+'.lock');
  let lock;
  try { lock = await fs.open(lockFile,'wx'); } catch { throw new Error('已有采集进程或锁，停止重复请求'); }
  try {
    const existing = core.validateDailySeries(await readJson(file,{version:1,observations:[]}),symbol);
    if (core.dailySeriesForDate(existing,symbol,date).status === 'current') return {symbol,skipped:true,requests:0};
    const ledger = await readJson(ledgerFile,{version:1,days:{}});
    if (ledger.version !== 1 || !ledger.days || typeof ledger.days !== 'object' || Array.isArray(ledger.days)) throw new Error('请求计数无效');
    const day = ledger.days[budgetDay(now)] ||= {requests:0,events:[]};
    if (!Number.isInteger(day.requests) || day.requests<0 || !Array.isArray(day.events)) throw new Error('请求计数无效');
    if (day.events.some(e=>e.date===date&&['current','stale'].includes(e.status))) return {symbol,skipped:true,requests:0};
    if (day.requests>=2) throw new Error('已达此来源每日2次预算');
    const event = {at:now.toISOString(),date,series:definition.series,endpoint:'FRED/fredgraph.csv',status:'reserved'};
    day.requests++;day.events.push(event);await atomicJson(ledgerFile,ledger);
    const url = new URL('https://fred.stlouisfed.org/graph/fredgraph.csv');
    Object.entries({id:definition.series,cosd:core.shift(date,-20),coed:date}).forEach(([k,v])=>url.searchParams.set(k,v));
    try {
      const response = await (options.fetchImpl || fetch)(url,{signal:AbortSignal.timeout(25000),redirect:'error'});
      event.http=response.status;
      if (!response.ok) throw new Error('HTTP '+response.status+'（不自动重试）');
      const fresh=core.parseDailyCsv(await response.text(),(options.now||new Date()).toISOString(),symbol);
      if (fresh.observations.some(r=>r.date>date)) throw new Error('来源返回未来记录，不发布');
      const merged = new Map((existing?.observations || []).map(r=>[r.date,r]));
      for (const row of fresh.observations) {
        const old=merged.get(row.date);
        if (row.previousDate===null&&old?.close===row.close&&old.previousDate) {row.previousDate=old.previousDate;row.previousClose=old.previousClose;}
        merged.set(row.date,row);
      }
      fresh.observations=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));core.validateDailySeries(fresh,symbol);
      const result=core.dailySeriesForDate(fresh,symbol,date);
      if (!result.record) throw new Error('观察日期内无有效价格，不发布');
      event.status=result.status;await atomicJson(ledgerFile,ledger);await atomicJson(file,fresh);
      return {symbol,requests:1,status:result.status,tradingDate:result.record.date,hasPreviousPrice:result.record.change!==null};
    } catch (e) {event.status='failed';await atomicJson(ledgerFile,ledger);throw new Error((e.message.startsWith('HTTP')?e.message:'来源采集或校验失败')+'；保留上次有效数据，不自动重试');}
  } finally {await lock.close();await fs.unlink(lockFile);}
}
module.exports={collectExtra};
if (require.main===module) {
 const args=process.argv.slice(2);
 (async()=>{
  if (args.length===1&&args[0]==='--test') {
   const records={};for(const symbol of Object.keys(core.DAILY_SERIES)){const data=core.validateDailySeries(await readJson(path.join(DATA_DIR,symbol.toLowerCase()+'.json'),{version:1,observations:[]}),symbol);records[symbol]=data?.observations.length||0;}
   console.log(JSON.stringify({mode:'local-validation-only',requests:0,records}));return;
  }
  if (!args.includes('--manual')||args.some(a=>a!=='--manual'&&!/^--symbol=(NBI|BRENT)$/.test(a)&&!/^--date=\d{4}-\d{2}-\d{2}$/.test(a))) throw new Error('仅允许 --manual --symbol=NBI|BRENT [--date=YYYY-MM-DD]；--test不请求网络');
  console.log(JSON.stringify(await collectExtra({symbol:args.find(a=>a.startsWith('--symbol='))?.slice(9),date:args.find(a=>a.startsWith('--date='))?.slice(7)})));
 })().catch(e=>{console.error(e.message);process.exitCode=1;});
}
