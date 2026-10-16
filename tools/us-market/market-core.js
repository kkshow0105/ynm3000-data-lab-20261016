/* Shared by the offline page and the Node collector; no network or storage here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.USMarket = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const EXCHANGES = ['NASDAQ', 'NYSE'];
  const INDEXES = { '^GSPC': '标普500', '^IXIC': '纳斯达克综合', '^DJI': '道琼斯' };
  const ACTIVE_INDEXES = { '^GSPC': '标普500', '^IXIC': '纳斯达克综合' }; // DJI remains readable in existing history only.
  const calendarSource = 'https://www.nyse.com/trade/hours-calendars';
  function iso(date) { return date.toISOString().slice(0, 10); }
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(value)) && iso(new Date(value)) === value;
  }
  function shift(date, days) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return iso(d); }
  function nth(year, month, weekday, n) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    return iso(new Date(Date.UTC(year, month - 1, 1 + (weekday - first.getUTCDay() + 7) % 7 + (n - 1) * 7)));
  }
  function observed(year, month, day) {
    const date = iso(new Date(Date.UTC(year, month - 1, day)));
    const weekday = new Date(date).getUTCDay();
    return shift(date, weekday === 6 ? -1 : weekday === 0 ? 1 : 0);
  }
  function easter(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = (h + l - 7 * m + 114) % 31 + 1;
    return iso(new Date(Date.UTC(year, month - 1, day)));
  }
  function isTradingDay(date) {
    if (!validDate(date)) return false;
    const year = Number(date.slice(0, 4));
    // Fail closed outside the reviewed calendar window. Early closes are still sessions.
    if (year < 2024 || year > 2028) return false;
    const weekday = new Date(date).getUTCDay();
    if (weekday === 0 || weekday === 6) return false;
    const newYear = new Date(Date.UTC(year, 0, 1));
    const holidays = [iso(newYear), ...(newYear.getUTCDay() === 0 ? [shift(iso(newYear), 1)] : []),
      nth(year, 1, 1, 3), nth(year, 2, 1, 3), shift(easter(year), -2),
      shift(nth(year, 6, 1, 1), -7), observed(year, 6, 19), observed(year, 7, 4),
      nth(year, 9, 1, 1), nth(year, 11, 4, 4), observed(year, 12, 25), '2025-01-09'];
    return !holidays.includes(date);
  }
  // EIA Europe Brent is a London spot assessment, not a NYSE or ICE futures session.
  // Reviewed London bank holidays (2024–2028): https://www.gov.uk/bank-holidays
  // Platts confirms no London oil assessments on UK public holidays; this is a
  // display freshness calendar only. Never discard real observations using it.
  const LONDON_SPOT_HOLIDAYS = {
    2024:['01-01','03-29','04-01','05-06','05-27','08-26','12-25','12-26'],
    2025:['01-01','04-18','04-21','05-05','05-26','08-25','12-25','12-26'],
    2026:['01-01','04-03','04-06','05-04','05-25','08-31','12-25','12-28'],
    2027:['01-01','03-26','03-29','05-03','05-31','08-30','12-27','12-28'],
    2028:['01-03','04-14','04-17','05-01','05-29','08-28','12-25','12-26']
  };
  function brentBusinessDayLag(actualDate, observationDate) {
    if (![actualDate,observationDate].every(d=>validDate(d)&&Object.hasOwn(LONDON_SPOT_HOLIDAYS,d.slice(0,4))) || actualDate>observationDate) return null;
    let days=0;
    for(let date=shift(actualDate,1);date<=observationDate;date=shift(date,1)) {
      const weekday=new Date(date).getUTCDay();
      if(weekday!==0&&weekday!==6&&!LONDON_SPOT_HOLIDAYS[date.slice(0,4)].includes(date.slice(5))) days++;
    }
    return days;
  }
  function previousSession(date) {
    let d = date;
    for (let i = 0; i < 15; i++) { d = shift(d, -1); if (isTradingDay(d)) return d; }
    throw new Error('交易日历超出支持范围（2024—2028）');
  }
  function expectedSession(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    // Wait until 18:00 New York even on early-close days, allowing EOD processing.
    return Number(parts.hour) >= 18 && isTradingDay(date) ? date : previousSession(date);
  }
  function normalizeRows(rows, kind, exchange, date) {
    if (!Array.isArray(rows) || !rows.length) throw new Error(`${kind}/${exchange} 无数据`);
    if (!isTradingDay(date)) throw new Error('拒绝非交易日数据');
    const field = kind === 'sector' ? 'sector' : 'industry';
    const seen = new Set();
    const result = rows.map(row => {
      if (row.date !== date || row.exchange !== exchange || typeof row[field] !== 'string' || !row[field].trim()
        || row[field].length > 120 || typeof row.averageChange !== 'number' || !Number.isFinite(row.averageChange)) {
        throw new Error(`${kind}/${exchange} 日期、分类或数值无效`);
      }
      if (seen.has(row[field])) throw new Error(`${kind}/${exchange} 分类重复`);
      seen.add(row[field]);
      return { name: row[field], exchange, change: row.averageChange };
    });
    if (kind === 'sector' && result.length !== 11) throw new Error(`${exchange} 大行业不完整，预期11类`);
    return result;
  }
  function indexFromCloses(rows, symbol, date) {
    const previousDate = previousSession(date);
    if (!Array.isArray(rows)) throw new Error(`${symbol} 日线无效`);
    const today = rows.filter(r => r.date === date && r.symbol === symbol);
    const previous = rows.filter(r => r.date === previousDate && r.symbol === symbol);
    if (today.length !== 1 || previous.length !== 1 || ![today[0].close, previous[0].close].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
      throw new Error(`${symbol} 缺少相邻交易日有效收盘价`);
    }
    const close = today[0].close, previousClose = previous[0].close;
    return { symbol, name: INDEXES[symbol], date, previousDate, close, previousClose, change: (close / previousClose - 1) * 100 };
  }
  // Kept separate from INDEXES: the FMP collector must continue requesting only its three permitted symbols.
  const SOX = { symbol: 'SOX', name: '费城半导体指数', english: 'Philadelphia Semiconductor Index',
    series: 'NASDAQSOX', source: 'Nasdaq via FRED', sourceUrl: 'https://fred.stlouisfed.org/series/NASDAQSOX',
    copyright: 'Copyright © 2025, NASDAQ, Inc.' };
  function validateSox(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.observations)) throw new Error('SOX数据格式无效');
    if (!data.observations.length) return null;
    if (data.source !== SOX.source || data.series !== SOX.series || data.sourceUrl !== SOX.sourceUrl || data.copyright !== SOX.copyright
      || typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error('SOX来源或获取时间无效');
    const seen = new Set();
    for (const row of data.observations) {
      if (!isTradingDay(row.date) || typeof row.close !== 'number' || !Number.isFinite(row.close) || row.close <= 0 || typeof row.fetchedAt !== 'string' || !Number.isFinite(Date.parse(row.fetchedAt)) || seen.has(row.date)) throw new Error('SOX日期、收盘价或重复记录无效');
      seen.add(row.date);
    }
    return data;
  }
  function parseSoxCsv(text, fetchedAt) {
    if (typeof text !== 'string') throw new Error('SOX CSV无效');
    const [header, ...lines] = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (header !== 'observation_date,NASDAQSOX' && header !== 'DATE,NASDAQSOX') throw new Error('SOX CSV列名无效');
    const observations = [];
    for (const line of lines) {
      const fields = line.split(',');
      if (fields.length !== 2 || !validDate(fields[0])) throw new Error('SOX CSV记录无效');
      const [date, value] = fields;
      // FRED uses a dot or empty value for missing observations; never interpret these as zero.
      if (value === '.' || value === '') continue;
      if (!/^(?:\d+)(?:\.\d+)?$/.test(value)) throw new Error('SOX收盘价无效');
      observations.push({ date, close: Number(value), fetchedAt });
    }
    const data = { version: 1, source: SOX.source, series: SOX.series, sourceUrl: SOX.sourceUrl,
      copyright: SOX.copyright, fetchedAt, observations: observations.sort((a,b) => a.date.localeCompare(b.date)) };
    if (observations.length < 2) throw new Error('SOX不足两个有效交易日');
    return validateSox(data);
  }
  function soxForDate(data, date) {
    if (!data || !isTradingDay(date)) return { status: 'missing', record: null };
    validateSox(data);
    const latest = data.observations.filter(r => r.date <= date).sort((a,b) => b.date.localeCompare(a.date))[0];
    if (!latest) return { status: 'missing', record: null };
    try {
      const rows = data.observations.map(r => ({ ...r, symbol: SOX.symbol }));
      const record = { ...indexFromCloses(rows, SOX.symbol, latest.date), name: SOX.name, fetchedAt: latest.fetchedAt };
      return { status: latest.date === date ? 'current' : 'stale', record };
    } catch { return { status: 'incomplete', record: null, date: latest.date }; }
  }
  const DAILY_SERIES = {
    NBI: { symbol:'NBI', name:'生物科技 NBI', english:'NASDAQ Biotechnology Index', series:'NASDAQNBI', source:'Nasdaq via FRED',
      sourceUrl:'https://fred.stlouisfed.org/series/NASDAQNBI', copyright:SOX.copyright, unit:'', basis:'Nasdaq指数日收盘', calendar:'NYSE' },
    BRENT: { symbol:'BRENT', name:'布伦特原油', english:'Europe Brent Spot Price FOB', series:'DCOILBRENTEU', source:'EIA via FRED',
      sourceUrl:'https://fred.stlouisfed.org/series/DCOILBRENTEU', copyright:'Source: U.S. Energy Information Administration, via FRED', unit:'USD/bbl', basis:'EIA欧洲Brent现货日收盘报价，非期货连续合约', calendar:'source' }
  };
  function seriesDay(date, definition) {
    return definition.calendar === 'NYSE' ? isTradingDay(date) : validDate(date) && ![0,6].includes(new Date(date).getUTCDay());
  }
  function validateDailySeries(data, symbol) {
    const definition = DAILY_SERIES[symbol];
    if (!definition || !data || data.version !== 1 || !Array.isArray(data.observations)) throw new Error('日度数据格式无效');
    if (!data.observations.length) return null;
    for (const key of ['series','source','sourceUrl','copyright','unit','basis']) if (data[key] !== definition[key]) throw new Error('日度来源或口径无效');
    if (typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error('日度获取时间无效');
    const seen = new Set();
    for (const row of data.observations) {
      if (!seriesDay(row.date,definition) || typeof row.close !== 'number' || !Number.isFinite(row.close) || row.close <= 0 || seen.has(row.date)
        || typeof row.fetchedAt !== 'string' || !Number.isFinite(Date.parse(row.fetchedAt))) throw new Error('日度日期或价格无效');
      seen.add(row.date);
      if (row.previousDate === null && row.previousClose === null) continue;
      if (!seriesDay(row.previousDate,definition) || row.previousDate >= row.date || typeof row.previousClose !== 'number' || !Number.isFinite(row.previousClose) || row.previousClose <= 0
        || (definition.calendar === 'NYSE' && row.previousDate !== previousSession(row.date))) throw new Error('前一有效交易期无效');
    }
    return data;
  }
  function parseDailyCsv(text, fetchedAt, symbol) {
    const definition = DAILY_SERIES[symbol];
    if (!definition || typeof text !== 'string') throw new Error('未知日度来源');
    const [header,...lines] = text.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
    if (![ 'observation_date,'+definition.series, 'DATE,'+definition.series ].includes(header)) throw new Error('日度CSV列名无效');
    const observations = [];
    for (const line of lines) {
      const fields = line.split(',');
      if (fields.length !== 2 || !validDate(fields[0])) throw new Error('日度CSV记录无效');
      const [date,value] = fields;
      if (value === '.' || value === '') continue;
      if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('日度价格无效');
      observations.push({ date,close:Number(value),fetchedAt });
    }
    observations.sort((a,b)=>a.date.localeCompare(b.date));
    observations.forEach((row,index)=>{
      const previous = observations[index-1];
      const adjacent = previous && (definition.calendar !== 'NYSE' || previous.date === previousSession(row.date));
      row.previousDate = adjacent ? previous.date : null; row.previousClose = adjacent ? previous.close : null;
    });
    const data = { version:1, ...Object.fromEntries(['series','source','sourceUrl','copyright','unit','basis'].map(key=>[key,definition[key]])), fetchedAt, observations };
    if (!observations.length) throw new Error('日度数据为空');
    return validateDailySeries(data,symbol);
  }
  function dailySeriesForDate(data, symbol, date) {
    if (!data || !isTradingDay(date)) return { status:'missing',record:null };
    validateDailySeries(data,symbol);
    const row = data.observations.filter(r=>r.date<=date).sort((a,b)=>b.date.localeCompare(a.date))[0];
    if (!row) return { status:'missing',record:null };
    return { status:row.date === date ? 'current' : 'stale', record:{ ...row, symbol, name:DAILY_SERIES[symbol].name,
      change:row.previousClose === null ? null : (row.close/row.previousClose-1)*100 } };
  }
  function indexForDate(rows, symbol, date) {
    if (!Array.isArray(rows) || !isTradingDay(date)) return { status:'missing', record:null };
    // The observation date, never the download timestamp, controls historical visibility.
    const candidates = rows.filter(r => r?.symbol === symbol && isTradingDay(r.date) && r.date <= date).sort((a,b) => b.date.localeCompare(a.date));
    const row = candidates[0];
    if (!row || candidates.filter(r => r.date === row.date).length !== 1) return { status:'missing', record:null };
    if (typeof row.close !== 'number' || !Number.isFinite(row.close) || row.close <= 0) return { status:'missing',record:null };
    if (row.previousDate == null || row.previousClose == null) return { status:row.date === date ? 'current' : 'stale',record:{...row,change:null} };
    try {
      const check = indexFromCloses([{ symbol, date:row.date, close:row.close }, { symbol, date:row.previousDate, close:row.previousClose }], symbol, row.date);
      if (typeof row.change !== 'number' || !Number.isFinite(row.change) || Math.abs(row.change-check.change)>1e-8) return { status:'missing', record:null };
      return { status:row.date === date ? 'current' : 'stale', record:{ ...row, change:check.change } };
    } catch { return { status:'missing', record:null }; }
  }
  function validateSnapshot(data, { forDisplay = false } = {}) {
    if (!data || data.version !== 1 || data.source !== 'FMP' || data.isProxy !== false || !isTradingDay(data.tradingDate)
      || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) || !data.datasets) throw new Error('行情快照格式或交易日期无效');
    for (const kind of ['sector', 'industry']) {
      const rows = data.datasets[kind];
      if (!Array.isArray(rows)) throw new Error('缺少行业数据');
      for (const exchange of EXCHANGES) {
        normalizeRows(rows.filter(r => r.exchange === exchange).map(r => ({ date: data.tradingDate, exchange: r.exchange,
          [kind === 'sector' ? 'sector' : 'industry']: r.name, averageChange: r.change })), kind, exchange, data.tradingDate);
      }
      if (rows.some(r => !EXCHANGES.includes(r.exchange))) throw new Error('未知交易所');
    }
    // Only the page opts into per-index display validation; collection remains strict by default.
    if (forDisplay) return data;
    if (!Array.isArray(data.indices) || ![2,3].includes(data.indices.length) || data.indices.some(r=>!r || !Object.hasOwn(INDEXES,r.symbol))) throw new Error('指数数据不完整');
    const required = [...Object.keys(ACTIVE_INDEXES), ...(data.indices.some(r=>r.symbol==='^DJI') ? ['^DJI'] : [])];
    for (const symbol of required) {
      const matches = data.indices.filter(r => r.symbol === symbol);
      if (matches.length !== 1) throw new Error('指数代码重复或缺失');
      const r = matches[0];
      const check = indexFromCloses([{ symbol, date: r.date, close: r.close }, { symbol, date: r.previousDate, close: r.previousClose }], symbol, data.tradingDate);
      if (typeof r.change !== 'number' || !Number.isFinite(r.change) || Math.abs(r.change - check.change) > 1e-8) throw new Error('指数涨跌幅口径错误');
    }
    return data;
  }
  function rank(rows, exchange = 'both', limit = 5) {
    const pool = rows.filter(r => (exchange === 'both' || r.exchange === exchange) && typeof r.change === 'number' && Number.isFinite(r.change));
    const tie = (a, b) => a.name.localeCompare(b.name, 'en') || a.exchange.localeCompare(b.exchange);
    return { ordered: [...pool].sort((a, b) => b.change - a.change || tie(a, b)), up: pool.filter(r => r.change > 0).sort((a, b) => b.change - a.change || tie(a, b)).slice(0, limit),
      down: pool.filter(r => r.change < 0).sort((a, b) => a.change - b.change || tie(a, b)).slice(0, limit),
      total: pool.length, upCount: pool.filter(r => r.change > 0).length, downCount: pool.filter(r => r.change < 0).length,
      flat: pool.filter(r => r.change === 0).sort(tie), flatCount: pool.filter(r => r.change === 0).length };
  }
  function relatedIndustries(rows, sector, mappings) {
    return sector ? rows.filter(row => Object.hasOwn(mappings, row.name) && mappings[row.name].sector === sector) : rows;
  }
  function percent(value) { return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`; }
  return { EXCHANGES, INDEXES, calendarSource, validDate, shift, isTradingDay, previousSession, expectedSession,
    brentBusinessDayLag, normalizeRows, indexFromCloses, validateSnapshot, rank, relatedIndustries, percent, SOX, validateSox, parseSoxCsv, soxForDate, indexForDate,
    ACTIVE_INDEXES, DAILY_SERIES, validateDailySeries, parseDailyCsv, dailySeriesForDate };
});
