'use strict';
// Frozen publication baseline. Source taxonomy changes require a reviewed configuration change.
const taxonomy=require('./market-industry-taxonomy.json');
const COUNTS={NASDAQ:127,NYSE:128};
for(const [exchange,count]of Object.entries(COUNTS)){
 const names=taxonomy.exchanges[exchange];
 if(taxonomy.version!==1||taxonomy.baselineTradingDate!=='2026-10-14'||!Array.isArray(names)||names.length!==count||new Set(names).size!==count||names.some(n=>typeof n!=='string'||!n||n.length>120))throw Error('细分行业基准配置损坏，禁止发布');
}
function checkIndustrySnapshot(snapshot){
 const rows=snapshot?.datasets?.industry,details={date:snapshot?.tradingDate,baseline:taxonomy.baselineTradingDate,invalidRows:[],exchanges:{}};
 if(!Array.isArray(rows))throw coverageError({...details,invalidRows:[{index:null,reason:'industry不是数组'}]});
 const actual={NASDAQ:[],NYSE:[]};
 for(const [index,row]of rows.entries()){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='change,exchange,name'){details.invalidRows.push({index,reason:'缺少必要字段或包含额外字段'});continue;}
  if(!Object.hasOwn(COUNTS,row.exchange)){details.invalidRows.push({index,reason:'交易所无效'});continue;}
  if(typeof row.name!=='string'||!row.name||row.name.length>120){details.invalidRows.push({index,reason:'分类身份类型或长度无效'});continue;}
  actual[row.exchange].push(row.name);
  if(typeof row.change!=='number'||!Number.isFinite(row.change)||row.change< -100)details.invalidRows.push({index,reason:'涨跌幅类型或数值无效'});
 }
 let invalid=details.invalidRows.length>0;
 for(const [exchange,count]of Object.entries(COUNTS)){
  const expected=new Set(taxonomy.exchanges[exchange]),seen=new Set(),duplicates=new Set();
  for(const name of actual[exchange]){if(seen.has(name))duplicates.add(name);seen.add(name);}
  const missing=[...expected].filter(n=>!seen.has(n)).sort(),unexpected=[...seen].filter(n=>!expected.has(n)).sort();
  details.exchanges[exchange]={expectedCount:count,actualCount:actual[exchange].length,missing,unexpected,duplicates:[...duplicates].sort()};
  if(actual[exchange].length!==count||missing.length||unexpected.length||duplicates.size)invalid=true;
 }
 if(invalid)throw coverageError(details);return details;
}
function coverageError(details){const e=Error('细分行业分类与已核实基准不符；禁止发布，需人工核对分类变化');e.code='INDUSTRY_COVERAGE';e.details=details;return e;}
function checkIndustryBundle(bundle){for(const [file,snapshot]of Object.entries(bundle))if(/^snapshots\/\d{4}-\d{2}-\d{2}\.json$/.test(file))checkIndustrySnapshot(snapshot);}
function coverageDiagnostic(error){
 if(error?.code!=='INDUSTRY_COVERAGE')return null;
 let text=JSON.stringify({code:error.code,...error.details});
 for(const key of [process.env.FMP_API_KEY,process.env.FRED_API_KEY,process.env.GH_TOKEN,process.env.GITHUB_TOKEN].filter(v=>v&&v.length>6))text=text.split(key).join('[REDACTED]');
 return text;
}
module.exports={taxonomy,checkIndustrySnapshot,checkIndustryBundle,coverageDiagnostic};
