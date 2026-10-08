/* City of Austin Hydromet acquisition and display interpretation stay separate.
   The endpoint returns LCRA's unfiltered all-sites response. LCRA allows only its own
   site to read the feed from a browser, so a server relays it: the chatgpt.site Worker
   on its own origin, or, for the static GitHub Pages copy, the proxy that
   scripts/build-proxy.cjs builds from the same Worker template. */
'use strict';
const LCRA_PROXY='https://austin-swim-map-lcra.austin-swim-map-public-site.workers.dev';
const CITY_HYDROMET_API=String(globalThis.location?.hostname||'').endsWith('.github.io')?LCRA_PROXY:'';
const CITY_HYDROMET_SOURCE='https://hydromet.lcra.org/api/GetDataForAllSites';
const CITY_HYDROMET_VIEWER='https://hydromet.lcra.org/HistoricalData/Coa';
// City urban-creek observations can change within one 15-minute reporting interval.
const CITY_HYDROMET_MAX_AGE_MS=30*60000;
const BLUNN_PLANNING_MAX_AGE_MS=2*3600000;
const BLUNN_TREND_WINDOW_MS=3*3600000;
const BLUNN_RULE_ID='blunn-visit-reference-v3';
const BLUNN_RULE_SOURCE='method.html#blunn-visit-band';
const BLUNN_PLACES=['blunn-big-stacey','blunn-little-stacey'];

async function acquireCityHydromet(){
  const response=await fetch(CITY_HYDROMET_API+'/api/city-hydromet/raw',{cache:'no-store'});
  if(!response.ok) throw new Error(`City Hydromet: HTTP ${response.status}`);
  const raw=await response.json();
  if(!Array.isArray(raw)) throw new Error('City Hydromet response was not an array');
  window.cityHydrometRaw=raw;
  return {raw,retrieved_at:response.headers.get('X-Retrieved-At')||new Date().toISOString(),
    source_url:response.headers.get('X-Source-URL')||CITY_HYDROMET_SOURCE};
}
async function acquireBlunnHistory(days=2){
  if(![2,8].includes(days))throw new Error('Unsupported Blunn history window');
  const response=await fetch(CITY_HYDROMET_API+'/api/city-hydromet/blunn-history/raw'+(days===8?'?days=8':''),{cache:'no-store'});
  if(!response.ok)throw new Error(`Blunn history: HTTP ${response.status}`);
  const raw=await response.json();
  if(String(raw.siteNumber)!=='122'||raw.value2Type!=='Flow'||!Array.isArray(raw.records))throw new Error('Unexpected Blunn flow history');
  window.blunnHistoryRaw=raw;
  return raw;
}
function parseBlunnHistory(raw){
  return raw.records.map(row=>({observed_at:row.dateTime,flow_cfs:hydrometNumber(row.value2),stage_ft:hydrometNumber(row.value1)}))
    .filter(row=>Number.isFinite(Date.parse(row.observed_at))&&row.flow_cfs!==null)
    .sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));
}
function sustainedBlunnFlow(station,history){
  if(!Array.isArray(history)||station.flow_cfs===null)return false;
  const end=Date.parse(station.observed_at),start=end-BLUNN_TREND_WINDOW_MS;
  if(history.some(row=>Date.parse(row.observed_at)>end+60000))return false;
  const readings=history.filter(row=>{const time=Date.parse(row.observed_at);return time>=start&&time<=end+60000;});
  if(!readings.length||Date.parse(readings[0].observed_at)>start+30*60000||
      Math.abs(Date.parse(readings[readings.length-1].observed_at)-end)>10*60000)return false;
  if(readings.some(row=>row.flow_cfs<5||row.flow_cfs>=12))return false;
  return readings.slice(1).every((row,i)=>Date.parse(row.observed_at)-Date.parse(readings[i].observed_at)<=30*60000);
}
function hydrometNumber(value){
  if(value===null||value===undefined||value==='') return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
}
function parseCityHydromet(capture){
  const stations=capture.raw.filter(row=>{
    const lat=hydrometNumber(row.latitude),lon=hydrometNumber(row.longitude);
    return row.agency==='COA'&&row.siteType==='river'&&/creek/i.test(row.siteName||'')
      &&lat!==null&&lon!==null&&lat>=30.16&&lat<=30.44&&lon>=-97.93&&lon<=-97.66
      &&(hydrometNumber(row.flow)!==null||hydrometNumber(row.stage)!==null);
  }).map(row=>({id:String(row.siteNumber),name:String(row.siteName),lat:Number(row.latitude),lon:Number(row.longitude),
    flow_cfs:hydrometNumber(row.flow),stage_ft:hydrometNumber(row.stage),
    rainfall_1h:hydrometNumber(row.rainfall1Hour),observed_at:row.dateTime,
    rainfall_6h:hydrometNumber(row.rainfall6Hours),
    source:CITY_HYDROMET_VIEWER})).sort((a,b)=>a.name.localeCompare(b.name));
  return {stations,checked_at:capture.retrieved_at,source_url:capture.source_url};
}
function cityHydrometCurrent(station,at=Date.now()){
  if(!station) return false;
  const age=at-Date.parse(station.observed_at);
  return Number.isFinite(age)&&age>=-300000&&age<CITY_HYDROMET_MAX_AGE_MS;
}
function assessBlunnFlow(station,at=Date.now(),history=null){
  const age=station?at-Date.parse(station.observed_at):NaN;
  if(!station||station.id!=='122'||!Number.isFinite(age)||age< -300000||age>=BLUNN_PLANNING_MAX_AGE_MS||station.flow_cfs===null)
    return {status:'gray',reason:'No current City Hydromet discharge reading for the Blunn reference band',
      evidence:'City station check or flow unavailable',observed_at:null,valid_until:null,rule_source:null};
  const current=age<CITY_HYDROMET_MAX_AGE_MS;
  const flow=station.flow_cfs;
  const status=flow<0.5?'red':flow<5?'yellow':flow<12?'green':flow<22?'yellow':'red';
  if(!current&&(status!=='green'||station.rainfall_6h!==0||!sustainedBlunnFlow(station,history)))
    return {status:'gray',reason:'Earlier Blunn reading lacks the sustained flow and dry-station history needed for a dated planning cue',
      evidence:'Measurement is older than 30 minutes; no supported earlier flow cue',observed_at:station.observed_at,valid_until:null,rule_source:null};
  if(status!=='red'&&(station.rainfall_1h==null||station.rainfall_1h>0))
    return {status:'gray',reason:station.rainfall_1h==null
      ?'City Hydromet has no recent-rain reading; Blunn flow cue paused'
      :'Rain recorded at the City station in the past hour; Blunn flow cue paused while the creek may change',
      evidence:'Station rainfall gate · no green or yellow flow cue during recent rain',
      observed_at:station.observed_at,
      valid_until:new Date(Date.parse(station.observed_at)+CITY_HYDROMET_MAX_AGE_MS).toISOString(),rule_source:null};
  const meaning=flow<0.5?'near-zero station flow':flow<5?'below the reported good-visit flow range':flow<12?'near the reported good-visit flow range':flow<22?'above the visit range':'high relative to the station’s May–June daily record';
  return {status,reason:`City Hydromet 122 measured ${flow} cfs; ${current?'current reading':'earlier planning cue after a favorable three-hour station-history window and no reported six-hour station rain'}; ${BLUNN_RULE_ID} is a provisional ${meaning} cue at this downstream station`,
    evidence:`Estimate · limited evidence · ${current?'measurement current':'earlier station flow, not a current measurement'} · two reported good visits at different upstream reaches; band not independently validated`,
    observed_at:station.observed_at,valid_until:new Date(Date.parse(station.observed_at)+(current?CITY_HYDROMET_MAX_AGE_MS:BLUNN_PLANNING_MAX_AGE_MS)).toISOString(),
    rule_source:BLUNN_RULE_SOURCE};
}
async function cityHydrometStatus(){return parseCityHydromet(await acquireCityHydromet());}
if(typeof module!=='undefined')module.exports={hydrometNumber,parseCityHydromet,parseBlunnHistory,sustainedBlunnFlow,cityHydrometCurrent,assessBlunnFlow};
