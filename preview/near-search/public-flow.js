/* Read USGS measurements on open and while the page stays open. Acquisition and
   rule assessment stay separate. An older reading can remain a dated planning cue. */
'use strict';
const FLOW_COLOR_MAX_AGE_MS=90*60000;
const FLOW_COLOR_PLANNING_MAX_AGE_MS=6*3600000;
const FLOW_CAPTURE_CACHE_KEY='austin-swim-map-usgs-batch-v1';
function storedFlowCapture(stations){
  try{
    if(typeof localStorage==='undefined') return null;
    const capture=JSON.parse(localStorage.getItem(FLOW_CAPTURE_CACHE_KEY)||'null');
    const age=Date.now()-Date.parse(capture?.retrieved_at);
    return capture&&Array.isArray(capture.stations)&&capture.stations.join(',')===stations.join(',')&&
      Number.isFinite(age)&&age>=0&&age<FLOW_COLOR_MAX_AGE_MS?capture:null;
  }catch(e){return null;}
}
function saveFlowCapture(capture){try{if(typeof localStorage!=='undefined')localStorage.setItem(FLOW_CAPTURE_CACHE_KEY,JSON.stringify(capture));}catch(e){/* Browser storage can be disabled. */}}

async function acquirePublicFlowBatch(stations) {
  // One official request covers the whole map. The 19 parallel OGC requests
  // exhausted the unauthenticated hourly limit as visitors opened new tabs.
  const query = new URLSearchParams({format:'json',sites:stations.join(','),parameterCd:'00060,00065',period:'PT7H'});
  const source = `https://waterservices.usgs.gov/nwis/iv/?${query}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(source,{signal:controller.signal,cache:'no-store'});
    if(!response.ok) throw Error(`USGS batch: HTTP ${response.status}`);
    const payload = await response.json();
    if(!Array.isArray(payload.value?.timeSeries)) throw Error('USGS batch: missing time series');
    return {stations,source,retrieved_at:new Date().toISOString(),payload};
  } finally { clearTimeout(timeout); }
}
async function acquireModernFlowBatch(stations){
  const source='https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items?f=json&limit=100';
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(source,{method:'POST',headers:{'Content-Type':'application/query-cql-json'},
      body:JSON.stringify({op:'in',args:[{property:'monitoring_location_id'},stations.map(id=>'USGS-'+id)]}),signal:controller.signal,cache:'no-store'});
    if(!response.ok) throw Error(`USGS modern batch: HTTP ${response.status}`);
    const payload=await response.json();
    if(!Array.isArray(payload.features)) throw Error('USGS modern batch: missing features');
    return {stations,source,retrieved_at:new Date().toISOString(),payload};
  }finally{clearTimeout(timeout);}
}

function parsePublicFlowBatch(capture) {
  const byStation=Object.fromEntries(capture.stations.map(id=>[id,{latest:{},series:{}}]));
  for(const item of capture.payload.value.timeSeries) {
    const station=item.sourceInfo?.siteCode?.[0]?.value,parameter=item.variable?.variableCode?.[0]?.value;
    const unit=item.variable?.unit?.unitCode;
    if(!byStation[station]||!['00060','00065'].includes(parameter)) continue;
    if(parameter==='00060'&&!['ft^3/s','ft3/s','cfs'].includes(unit)) continue;
    if(parameter==='00065'&&unit!=='ft') continue;
    for(const raw of (item.values||[]).flatMap(group=>group.value||[])) {
      const value=Number(raw.value),time=Date.parse(raw.dateTime);
      if(raw.value===null||raw.value===undefined||raw.value===''||!Number.isFinite(value)||!Number.isFinite(time)||time>Date.now()+300000) continue;
      const reading={parameter,unit,observed_at:raw.dateTime,value,qualifiers:raw.qualifiers||[],source:capture.source,retrieved_at:capture.retrieved_at};
      (byStation[station].series[parameter] ||= []).push([raw.dateTime,value]);
      const previous=byStation[station].latest[parameter];
      if(!previous||Date.parse(previous.observed_at)<time) byStation[station].latest[parameter]=reading;
    }
  }
  for(const station of capture.stations) for(const series of Object.values(byStation[station].series))
    series.sort((a,b)=>Date.parse(a[0])-Date.parse(b[0]));
  return byStation;
}
function parseModernFlowBatch(capture){
  const timeSeries=capture.payload.features.map(feature=>{
    const p=feature.properties||{},station=String(p.monitoring_location_id||'').replace(/^USGS-/, '');
    return {sourceInfo:{siteCode:[{value:station}]},variable:{variableCode:[{value:p.parameter_code}],unit:{unitCode:p.unit_of_measure}},
      values:[{value:[{dateTime:p.time,value:p.value,qualifiers:p.qualifier||[]}]}]};
  });
  return parsePublicFlowBatch({...capture,payload:{value:{timeSeries}}});
}
function parseFlowCapture(capture){return Array.isArray(capture.payload.value?.timeSeries)?parsePublicFlowBatch(capture):parseModernFlowBatch(capture);}
function publicFlowTrend(series,now=Date.now()){
  if(!series||series.length<2) return null;
  const latest=series.at(-1),latestAt=Date.parse(latest[0]),age=now-latestAt;
  if(!Number.isFinite(age)||age< -300000||age>=FLOW_COLOR_MAX_AGE_MS) return null;
  const target=latestAt-6*3600000;
  const earlier=series.slice(0,-1).filter(p=>Math.abs(Date.parse(p[0])-target)<=30*60000)
    .sort((a,b)=>Math.abs(Date.parse(a[0])-target)-Math.abs(Date.parse(b[0])-target))[0];
  if(!earlier) return null;
  const delta=latest[1]-earlier[1],tolerance=Math.max(0.05,0.05*Math.max(Math.abs(earlier[1]),Math.abs(latest[1])));
  return {direction:Math.abs(delta)<=tolerance?'steady':delta>0?'rising':'falling',earlier_at:earlier[0],latest_at:latest[0],earlier_value:earlier[1],latest_value:latest[1],hours:Math.round((latestAt-Date.parse(earlier[0]))/360000)/10};
}

const HISTORY_UNITS={'00060':['ft^3/s','ft3/s','cfs'],'00065':['ft']};
async function acquirePublicGaugeHistory(station,hours=24,parameter='00060'){
  if(!/^\d{8,15}$/.test(station)||![24,168].includes(hours)||!HISTORY_UNITS[parameter])throw Error('Unsupported history request');
  const end=new Date(),start=new Date(end.getTime()-hours*3600000);
  const query=new URLSearchParams({f:'json',monitoring_location_id:'USGS-'+station,parameter_code:parameter,
    datetime:start.toISOString()+'/'+end.toISOString(),limit:'5000'});
  const modern=`https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items?${query}`;
  async function request(source){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(source,{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw Error(`USGS history ${station}: HTTP ${response.status}`);
      return await response.json();
    }finally{clearTimeout(timeout);}
  }
  try{
    const payload=await request(modern);
    if(!Array.isArray(payload.features)||payload.features.length>=5000||payload.links?.some(link=>link.rel==='next'))
      throw Error('USGS history was incomplete');
    return {station,parameter,source:modern,retrieved_at:new Date().toISOString(),payload};
  }catch(modernError){
    const legacyQuery=new URLSearchParams({format:'json',sites:station,parameterCd:parameter,period:hours===24?'P1D':'P7D'});
    const source=`https://waterservices.usgs.gov/nwis/iv/?${legacyQuery}`;
    const payload=await request(source);
    if(!Array.isArray(payload.value?.timeSeries))throw Error('USGS history missing from both official endpoints');
    return {station,parameter,source,retrieved_at:new Date().toISOString(),payload};
  }
}
function parsePublicGaugeHistory(capture){
  const parameter=capture.parameter||'00060';
  let series;
  if(Array.isArray(capture.payload.features)){
    series=capture.payload.features.map(feature=>feature.properties||{}).filter(p=>
      p.monitoring_location_id==='USGS-'+capture.station&&p.parameter_code===parameter&&
      HISTORY_UNITS[parameter].includes(p.unit_of_measure)&&p.value!==null&&p.value!==''&&
      Number.isFinite(Number(p.value))&&Number.isFinite(Date.parse(p.time)))
      .map(p=>[p.time,Number(p.value)]).sort((a,b)=>Date.parse(a[0])-Date.parse(b[0]));
  }else{
    const parsed=parsePublicFlowBatch({...capture,stations:[capture.station]});
    series=parsed[capture.station]?.series?.[parameter]||[];
  }
  return {series,parameter,source:capture.source,retrieved_at:capture.retrieved_at};
}

function assessPublicFlow(rule,reading,checkedAt) {
  if(!reading||reading.parameter!==rule.parameter) return {status:'gray',reason:'No compatible official discharge reading'};
  const age=checkedAt-Date.parse(reading.observed_at);
  if(age < -300000||age >= FLOW_COLOR_PLANNING_MAX_AGE_MS) return {status:'gray',reason:'Official USGS discharge reading is too old for a planning cue or future-dated'};
  const band=rule.bands.find(b=>('lt' in b?reading.value<b.lt:true)&&('gte' in b?reading.value>=b.gte:true));
  if(!band) return {status:'gray',reason:'Reading falls outside the documented flow bands'};
  return {status:band.status,reason:`${rule.station_id} measured ${reading.value} ft^3/s; ${rule.id} applies${age>=FLOW_COLOR_MAX_AGE_MS?'; earlier observation, planning cue only':''}`,
    evidence:rule.evidence_label||'Flow estimate · recorded third-party flow bands, unvalidated',
    observed_at:reading.observed_at,valid_until:new Date(Date.parse(reading.observed_at)+FLOW_COLOR_PLANNING_MAX_AGE_MS).toISOString(),
    planning_only:age>=FLOW_COLOR_MAX_AGE_MS,hypothetical:rule.hypothetical===true,
    rule_source:rule.source};
}
function assessGeorgetownHypothesis(rule,reading,stage,series,checkedAt){
  const answer=assessPublicFlow(rule,reading,checkedAt);
  if(answer.status==='gray') return answer;
  const age=checkedAt-Date.parse(reading.observed_at);
  const stageAge=stage?checkedAt-Date.parse(stage.observed_at):Infinity;
  const freshStage=stage&&stageAge>=-300000&&stageAge<FLOW_COLOR_MAX_AGE_MS;
  const target=Number.isFinite(rule.rapid_rise_hours)?Date.parse(reading.observed_at)-rule.rapid_rise_hours*3600000:null;
  const prior=target===null?null:(series||[]).filter(p=>Math.abs(Date.parse(p[0])-target)<=30*60000)
    .sort((a,b)=>Math.abs(Date.parse(a[0])-target)-Math.abs(Date.parse(b[0])-target))[0];
  const rapidRise=prior&&reading.value-prior[1]>=rule.rapid_rise_min_cfs&&reading.value>=prior[1]*rule.rapid_rise_ratio;
  if(Number.isFinite(rule.red_stage_ft)&&freshStage&&stage.value>=rule.red_stage_ft){answer.status='red';answer.reason+=`; station stage ${stage.value} ft meets the NWS action stage of ${rule.red_stage_ft} ft`;}
  else if(rapidRise&&answer.status==='green'){answer.status='yellow';answer.reason+='; rapid upstream rise pauses the favorable-flow guess';}
  if(age>=FLOW_COLOR_MAX_AGE_MS&&answer.status==='green'){
    answer.status='yellow';answer.reason+='; earlier favorable snapshot is only a dated planning hint';
  }
  answer.reason+='; '+(rule.hypothesis_note||'hypothetical station-flow context; depth at this place unmeasured');
  return answer;
}

async function publicFlowStatus(stationIds) {
  const [saved,rules]=await Promise.all([getJson('status.json?v=20261003-place-history-v35'),getJson('data/public-flow-rules.json?v=20261009-sync12')]);
  const stations=[...new Set([...rules.map(r=>r.station_id),...stationIds])];
  const prior=storedFlowCapture(stations);
  let capture=null,parsed={},failure=null,firstError=null,cacheMode=null;
  if(prior&&Date.now()-Date.parse(prior.retrieved_at)<15*60000){capture=prior;parsed=parseFlowCapture(capture);cacheMode='recent cross-tab capture';}
  else{
    try{capture=await acquirePublicFlowBatch(stations);parsed=parsePublicFlowBatch(capture);saveFlowCapture(capture);}
    catch(e){firstError=String(e);
      try{capture=await acquireModernFlowBatch(stations);parsed=parseModernFlowBatch(capture);saveFlowCapture(capture);}
      catch(modernError){failure=`${firstError}; ${modernError}`;
        if(prior){capture=prior;parsed=parseFlowCapture(capture);cacheMode='earlier live capture after source failure';}
      }
    }
  }
  window.publicFlowCapture=capture;
  window.publicFlowFirstError=firstError;
  window.publicFlowCacheMode=cacheMode;
  const byStation={},failures=[],stationChecks={},trends={};
  for(const station of stations){
    byStation[station]=parsed[station]?.latest||{};
    trends[station]=publicFlowTrend(parsed[station]?.series?.['00060']);
    if(failure) failures.push(station);
    const observations=Object.values(byStation[station]);
    const hasCurrent=observations.some(r=>{const age=Date.now()-Date.parse(r.observed_at);return Number.isFinite(age)&&age>=-300000&&age<FLOW_COLOR_MAX_AGE_MS;});
    stationChecks[station]={checked_at:failure?new Date().toISOString():capture?.retrieved_at||new Date().toISOString(),source:capture?.source,
      state:failure?'check failed':hasCurrent?'current':observations.length?'observations old':'no compatible reading',
      ...(failure?{error:failure,last_success_at:capture?.retrieved_at||null}:{})};
  }
  // Every displayed gauge gets a live-check result. A failed check must not fall back
  // to the older, bundled gauge-readings.json as though it were current.
  window.publicLiveReadings=Object.fromEntries(stations.map(station=>['USGS-'+station,Object.values(byStation[station]||{})]));
  window.publicFlowStationChecks=stationChecks;
  window.publicFlowTrends=trends;
  const checkedAt=Date.now(),updates={};
  for(const rule of rules) {
    const reading=byStation[rule.station_id]?.[rule.parameter];
    const assessment=failure?{status:'gray',reason:'USGS source check failed; earlier fetched observation is station context only'}:
      rule.hypothetical?assessGeorgetownHypothesis(rule,reading,byStation[rule.station_id]?.['00065'],parsed[rule.station_id]?.series?.['00060'],checkedAt):assessPublicFlow(rule,reading,checkedAt);
    for(const id of rule.place_ids) updates[id]={...assessment,valid_until:assessment.valid_until||null,
      observed_at:assessment.observed_at||null,rule_source:assessment.rule_source||null};
  }
  return {...saved,generated_at:new Date(checkedAt).toISOString(),live_flow_checked_at:cacheMode==='recent cross-tab capture'?capture.retrieved_at:new Date(checkedAt).toISOString(),
    live_flow_failures:failures,live_flow_station_checks:stationChecks,live_flow_trends:trends,live_flow_cache_mode:cacheMode,live_flow_place_ids:Object.keys(updates),
    places:saved.places.map(p=>updates[p.id]?{...p,...updates[p.id]}:{...p,status:'gray',reason:'No current public flow rule applies to this place',observed_at:null,valid_until:null,rule_source:null})};
}
