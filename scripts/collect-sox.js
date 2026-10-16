'use strict';
// Optional SOX collector. Manual only; never imported by the browser or the FMP collector.
const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('../tools/us-market/market-core');
const { readJson, atomicJson, budgetDay, DATA_DIR } = require('./collect-us-market');
async function collectSox(options = {}) {
  if ((options.testMode && !options.fetchImpl) || (process.env.NODE_TEST_CONTEXT && !options.testMode)) throw new Error('SOX自动化测试必须注入Mock');
  const now = options.now || new Date(), date = options.date || core.expectedSession(now), dir = options.dir || DATA_DIR;
  if (!core.isTradingDay(date) || date > core.expectedSession(now)) throw new Error('SOX仅允许已收盘的有效交易日');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'sox.json'), ledgerFile = path.join(dir, 'sox-requests.json'), lockFile = path.join(dir, 'collect-sox.lock');
  let lock;
  try { lock = await fs.open(lockFile, 'wx'); } catch { throw new Error('已有SOX采集进程或锁，停止重复请求'); }
  try {
    const existing = core.validateSox(await readJson(file, { version:1, observations:[] }));
    if (core.soxForDate(existing, date).status === 'current') return { skipped:true, tradingDate:date, requests:0 };
    const ledger = await readJson(ledgerFile, { version:1, days:{} });
    if (ledger.version !== 1 || !ledger.days || typeof ledger.days !== 'object' || Array.isArray(ledger.days)) throw new Error('SOX请求计数无效，停止采集');
    const day = ledger.days[budgetDay(now)] ||= { requests:0, events:[] };
    if (!Number.isInteger(day.requests) || day.requests < 0 || !Array.isArray(day.events)) throw new Error('SOX请求计数无效，停止采集');
    if (day.requests >= 2) throw new Error('SOX已达到每日2次预算，停止请求');
    const url = new URL('https://fred.stlouisfed.org/graph/fredgraph.csv');
    Object.entries({ id:core.SOX.series, cosd:core.shift(date,-12), coed:date }).forEach(([k,v])=>url.searchParams.set(k,v));
    const event = { at:now.toISOString(), date, endpoint:'FRED/fredgraph.csv', status:'reserved' };
    day.requests++; day.events.push(event); await atomicJson(ledgerFile, ledger);
    try {
      const response = await (options.fetchImpl || fetch)(url, { signal:AbortSignal.timeout(25000), redirect:'error' });
      event.http = response.status;
      if (!response.ok) throw new Error('SOX FRED HTTP ' + response.status + '（不自动重试）');
      const fresh = core.parseSoxCsv(await response.text(), (options.now || new Date()).toISOString());
      if (fresh.observations.some(r=>r.date>date)) throw new Error('SOX返回超出所请求日期的记录');
      const selected = core.soxForDate(fresh,date);
      if (!selected.record) throw new Error('SOX缺少相邻交易日收盘价，不覆盖原记录');
      const merged = new Map((existing?.observations || []).map(r=>[r.date,r]));
      fresh.observations.forEach(r=>merged.set(r.date,r));
      fresh.observations = [...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));
      core.validateSox(fresh);
      const retained = core.soxForDate(fresh,date);
      event.status = retained.status; await atomicJson(ledgerFile,ledger);
      await atomicJson(file,fresh);
      return { tradingDate:retained.record.date, requestedDate:date, status:retained.status, requests:1, requestsToday:day.requests };
    } catch (e) {
      event.status = 'failed'; await atomicJson(ledgerFile,ledger);
      throw new Error((e.message.startsWith('SOX') ? e.message : 'SOX采集失败（不自动重试）') + '；上次有效数据已保留');
    }
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
module.exports = { collectSox };
if (require.main === module) {
  const args = process.argv.slice(2);
  (async()=>{
    if (args.length === 1 && args[0] === '--test') {
      const data = core.validateSox(await readJson(path.join(DATA_DIR,'sox.json'), {version:1,observations:[]}));
      console.log(JSON.stringify({ mode:'local-validation-only', observations:data?.observations.length || 0, requests:0 })); return;
    }
    if (!args.includes('--manual') || args.some(a=>a!=='--manual'&&!/^--date=\d{4}-\d{2}-\d{2}$/.test(a))) throw new Error('仅允许手动执行SOX采集：--manual [--date=YYYY-MM-DD]；--test仅校验本地数据');
    console.log(JSON.stringify(await collectSox({ date:args.find(a=>a.startsWith('--date='))?.slice(7) })));
  })().catch(e=>{console.error(e.message);process.exitCode=1;});
}
