'use strict';
// Node-only. Explicit manual collection; browser code never imports this file.
const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('../tools/us-market/market-core.js');
const DATA_DIR = path.resolve(__dirname, '../local-data/us-market');
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('本地JSON损坏，保护原文件并停止'); }
}
async function atomicJson(file, value) {
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}
function budgetDay(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
async function collect(options = {}) {
  const dir = options.dir || DATA_DIR, now = options.now || new Date();
  const date = options.date || core.expectedSession(now);
  if (!core.isTradingDay(date) || date > core.expectedSession(now)) throw new Error('只能采集已收盘的有效交易日（纽约18:00后）');
  const budget = options.budget ?? 20;
  if (!Number.isInteger(budget) || budget < 1 || budget > 20) throw new Error('开发预算须为1—20次');
  if (options.testMode && !options.fetchImpl) throw new Error('测试模式必须注入Mock，禁止真实网络');
  if (process.env.NODE_TEST_CONTEXT && !options.testMode) throw new Error('自动化测试禁止真实采集');
  const key = options.key || process.env.FMP_API_KEY;
  await fs.mkdir(path.join(dir, 'snapshots'), { recursive: true });
  const lockPath = path.join(dir, 'collect.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); } catch { throw new Error('已有采集进程或未清理的锁；停止重复请求'); }
  let ledger, day, dayKey;
  try {
    const existing = await readJson(path.join(dir, 'snapshots', date + '.json'), null);
    if (existing) {
      core.validateSnapshot(existing);
      // Recover a crash between the snapshot rename and the manifest rename, without another API call.
      const manifest = await readJson(path.join(dir, 'manifest.json'), { version: 1, dates: [], latest: null });
      if (manifest.version !== 1 || !Array.isArray(manifest.dates) || manifest.dates.some(d => !core.isTradingDay(d))) throw new Error('历史清单无效，保护原文件');
      if (!manifest.dates.includes(date)) {
        manifest.dates = [...new Set([...manifest.dates, date])].sort().reverse(); manifest.latest = manifest.dates[0];
        await atomicJson(path.join(dir, 'manifest.json'), manifest);
      }
      return { skipped: true, tradingDate: date, requests: 0 };
    }
    if (!key || !key.trim()) throw new Error('未检测到FMP_API_KEY，请设置进程或Windows用户环境变量');
    dayKey = budgetDay(now);
    ledger = await readJson(path.join(dir, 'requests.json'), { version: 1, days: {} });
    if (ledger.version !== 1 || !ledger.days || typeof ledger.days !== 'object') throw new Error('请求计数文件无效，停止采集');
    day = ledger.days[dayKey] ||= { requests: 0, externalBaseline: 0, events: [] };
    if (!Number.isInteger(day.requests) || day.requests < 0 || !Number.isInteger(day.externalBaseline) || day.externalBaseline < 0 || !Array.isArray(day.events)) throw new Error('请求计数异常，停止采集');
    const batchRequests = 4 + Object.keys(core.ACTIVE_INDEXES).length;
    if (day.requests + batchRequests > budget || day.requests + day.externalBaseline + batchRequests > 250) throw new Error('剩余请求预算不足一批'+batchRequests+'次，未发送请求');
    const startCount = day.requests;
    async function request(endpoint, params) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (day.requests >= budget || day.requests + day.externalBaseline >= 250) throw new Error('已达到每日请求预算，停止采集');
        const event = { at: new Date().toISOString(), endpoint, params, attempt: attempt + 1, status: 'reserved' };
        day.requests++; day.events.push(event);
        await atomicJson(path.join(dir, 'requests.json'), ledger); // Reserve before sending, including failed attempts.
        const url = new URL('https://financialmodelingprep.com/stable/' + endpoint);
        Object.entries({ ...params, apikey: key.trim() }).forEach(([k, v]) => url.searchParams.set(k, v));
        let response;
        try {
          response = await (options.fetchImpl || fetch)(url, { signal: AbortSignal.timeout(25000), redirect: 'error' });
        } catch {
          event.status = 'network_error';
          await atomicJson(path.join(dir, 'requests.json'), ledger);
          if (attempt === 1) throw new Error(endpoint + ' 网络失败，已重试一次');
          continue;
        }
        event.http = response.status;
        event.status = response.ok ? 'received' : response.status === 402 ? 'permission_denied' : response.status === 429 ? 'rate_limited' : 'http_error';
        // Storage failures stop the batch; they must never trigger another HTTP request.
        await atomicJson(path.join(dir, 'requests.json'), ledger);
        if (!response.ok) throw new Error(endpoint + ' HTTP ' + response.status + '（不自动重试）');
        try { return await response.json(); }
        catch { throw new Error(endpoint + ' 返回无效JSON（不自动重试）'); }
      }
    }
    const datasets = { sector: [], industry: [] };
    for (const kind of ['sector', 'industry']) {
      for (const exchange of core.EXCHANGES) {
        const rows = await request(kind + '-performance-snapshot', { date, exchange });
        datasets[kind].push(...core.normalizeRows(rows, kind, exchange, date));
      }
    }
    const indices = [];
    for (const symbol of Object.keys(core.ACTIVE_INDEXES)) {
      const rows = await request('historical-price-eod/full', { symbol, from: core.shift(date, -12), to: date });
      indices.push(core.indexFromCloses(rows, symbol, date));
    }
    const data = core.validateSnapshot({ version: 1, tradingDate: date, updatedAt: new Date().toISOString(), source: 'FMP',
      isProxy: false, calculation: { industry: 'FMP averageChange，按交易所分类的当日平均涨跌幅', index: '(本次收盘价 / 上一交易日收盘价 - 1) × 100',
        calendar: core.calendarSource, calendarYears: '2024—2028', scope: 'NASDAQ + NYSE交易所行业记录排行' }, datasets, indices });
    // Publish manifest last; no partial batch ever becomes the latest valid snapshot.
    const manifest = await readJson(path.join(dir, 'manifest.json'), { version: 1, dates: [], latest: null });
    if (manifest.version !== 1 || !Array.isArray(manifest.dates) || manifest.dates.some(d => !core.isTradingDay(d))) throw new Error('历史清单无效，保护原文件');
    await atomicJson(path.join(dir, 'snapshots', date + '.json'), data);
    manifest.dates = [...new Set([...manifest.dates, date])].sort().reverse();
    manifest.latest = manifest.dates[0];
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    await atomicJson(path.join(dir, 'status.json'), { version: 1, lastAttempt: { at: new Date().toISOString(), date, success: true }, requestsToday: day.requests, budget });
    return { tradingDate: date, requests: day.requests - startCount, requestsToday: day.requests,
      coverage: Object.fromEntries(['sector', 'industry'].map(kind => [kind, Object.fromEntries(core.EXCHANGES.map(e => [e, datasets[kind].filter(r => r.exchange === e).length]))])) };
  } catch (e) {
    const safe = String(e.message).includes('http') || /HTTP|预算|日期|交易|分类|无数据|日线|收盘价|JSON|计数|FMP_API_KEY|网络|指数|行业/.test(e.message)
      ? String(e.message).split(key || '\0').join('[REDACTED]') : '采集失败，上一份有效行情已保留';
    await atomicJson(path.join(dir, 'status.json'), { version: 1, lastAttempt: { at: new Date().toISOString(), date, success: false, message: safe }, requestsToday: day?.requests ?? null, budget });
    throw new Error(safe);
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
module.exports = { collect, readJson, atomicJson, budgetDay, DATA_DIR };
if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length === 1 && args[0] === '--test') {
      const manifest = await readJson(path.join(DATA_DIR, 'manifest.json'), null);
      if (!manifest) throw new Error('没有本地数据；测试模式不会请求FMP');
      for (const date of manifest.dates) core.validateSnapshot(await readJson(path.join(DATA_DIR, 'snapshots', date + '.json'), null));
      console.log(JSON.stringify({ mode: 'local-validation-only', snapshots: manifest.dates.length, requests: 0 })); return;
    }
    if (!args.includes('--manual') || args.some(a => a !== '--manual' && !/^--date=\d{4}-\d{2}-\d{2}$/.test(a))) throw new Error('仅允许手动执行：node scripts/collect-us-market.js --manual [--date=YYYY-MM-DD]；--test仅校验本地数据');
    const date = args.find(a => a.startsWith('--date='))?.slice(7);
    console.log(JSON.stringify(await collect({ date }), null, 2));
  })().catch(e => { console.error(e.message); process.exitCode = 1; });
}
