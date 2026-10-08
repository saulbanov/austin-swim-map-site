/* Official NWS alert and NWPS gauge checks for the public map. Raw responses
   remain separate from the deterministic place assessment in this page session. */
'use strict';
const HAZARD_BLOCKING=new Set(['Flash Flood Warning','Flash Flood Emergency','Flood Warning','Severe Thunderstorm Warning','Tornado Warning']);
const HAZARD_CAUTION=new Set(['Flash Flood Watch','Flood Watch','Flood Advisory','Flood Statement','Hydrologic Outlook','Severe Thunderstorm Watch','Tornado Watch','Special Weather Statement']);
const HAZARD_HEAT=new Set(['Excessive Heat Warning','Extreme Heat Warning','Heat Advisory','Excessive Heat Watch','Extreme Heat Watch']);
const HAZARD_FLOODING=new Set(['action','minor','moderate','major']);
async function acquireHazardJson(url){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(url,{signal:controller.signal,cache:'no-store'});
    if(!response.ok) throw Error(`NWS HTTP ${response.status}`);
    return {url,retrieved_at:new Date().toISOString(),payload:await response.json()};
  }finally{clearTimeout(timer);}
}
function hazardWindow(p,now){
  const start=Date.parse(p.onset||p.effective),end=Date.parse(p.ends||p.expires);
  if(Number.isFinite(end)&&end<=now) return null;
  if(Number.isFinite(start)&&start>now) return start<=now+86400000?'upcoming':null;
  return 'active';
}
function hazardGauge(raw,now){
  if(!raw) return null;
  const d=raw.payload,obs=d.status?.observed||{},fc=d.status?.forecast||{};
  const cats=Object.fromEntries(Object.entries(d.flood?.categories||{}).map(([k,v])=>[k,v?.stage]).filter(([,v])=>v!==null&&v!==undefined&&v!==-9999));
  const at=Date.parse(obs.validTime),fresh=Number.isFinite(at)&&Math.abs(now-at)<=3*3600000;
  let signal='unknown',reason='no official flood categories published for this gauge';
  if(Object.keys(cats).length&&!fresh) reason=`observation not fresh (${obs.validTime||'missing'})`;
  else if(Object.keys(cats).length&&HAZARD_FLOODING.has(obs.floodCategory)){signal='flooding';reason=`observed ${obs.primary} ${obs.primaryUnit} is in the ${obs.floodCategory} flood category`;}
  else if(Object.keys(cats).length&&HAZARD_FLOODING.has(fc.floodCategory)){signal='forecast-flooding';reason=`forecast reaches the ${fc.floodCategory} flood category`;}
  else if(Object.keys(cats).length){signal='none';reason=`observed ${obs.primary} ${obs.primaryUnit}, below ${cats.action?'action':'minor flood'} stage`;}
  return {lid:d.lid,name:d.name,usgs_id:d.usgsId,observed_stage:obs.primary,unit:obs.primaryUnit,observed_at:obs.validTime,
    observed_category:obs.floodCategory,forecast_category:fc.floodCategory,categories_ft:cats,signal,reason,source:`https://water.noaa.gov/gauges/${d.lid}`};
}
function assessPublicHazards(links,alertsCapture,gaugeCaptures,now=new Date()){
  const epoch=now.getTime(),features=alertsCapture?.payload?.features;
  if(!Array.isArray(features)) throw Error('NWS alert feed unavailable');
  const alerts=features.map(f=>{const p=f.properties||{},window=hazardWindow(p,epoch);return {event:p.event||'',ugc:p.geocode?.UGC||[],onset:p.onset||p.effective,ends:p.ends||p.expires,
    url:p['@id']||f.id,window,class:HAZARD_BLOCKING.has(p.event)?'blocking':HAZARD_CAUTION.has(p.event)?'caution':HAZARD_HEAT.has(p.event)?'heat':'other'};}).filter(a=>a.window);
  const gauges=Object.fromEntries(Object.entries(gaugeCaptures).map(([lid,raw])=>[lid,hazardGauge(raw,epoch)]));
  const places=links.places.map(pl=>{
    const dest=new Set([pl.county_ugc,pl.zone_ugc]),up=new Set(pl.upstream_applies?pl.upstream_ugc:[]);
    const hits=alerts.flatMap(a=>{const scope=a.ugc.some(k=>dest.has(k))?'destination':a.ugc.some(k=>up.has(k))?'upstream':null;return scope?[{...a,scope}]:[];});
    const lid=pl.flood_gauge?.lid,g=lid?gauges[lid]||null:null;
    let status='none found in checked sources';const reasons=[];
    for(const h of hits){const tag=`NWS ${h.event} (${h.scope}, ${h.window}, until ${h.ends||'not stated'})`;
      if(h.class==='blocking'&&h.window==='active'){status='active';reasons.push(tag);}
      else if(h.class==='blocking'||h.class==='caution'){if(status!=='active')status='caution';reasons.push(tag);}
      else if(h.class==='heat') reasons.push(tag);
    }
    if(g?.signal==='flooding'){status='active';reasons.push(`${lid} ${g.reason}`);}
    else if(g?.signal==='forecast-flooding'){if(status!=='active')status='caution';reasons.push(`${lid} ${g.reason}`);}
    else if(lid&&!g){if(status==='none found in checked sources')status='unknown';reasons.push(`${lid}: NWS flood gauge unavailable`);}
    else if(g?.signal==='unknown'){if(status==='none found in checked sources')status='unknown';reasons.push(`${lid}: ${g.reason}`);}
    const endTimes=hits.filter(h=>h.window==='active').map(h=>Date.parse(h.ends)).filter(Number.isFinite);
    const until=new Date(Math.min(epoch+7200000,...endTimes)).toISOString();
    return {id:pl.id,name:pl.name,hazard_notice:status,
      reason:reasons.join('; ')||`no active NWS warning, watch, or advisory for ${pl.county_ugc}`+(up.size?` or upstream ${[...up].join(', ')}`:'')+(g?.signal==='none'?`; ${lid} ${g.reason}`:''),
      evidence:'Official notice check · NWS alerts by county code'+(g?' + NWS flood-stage category':lid?' (flood gauge unavailable)':' (no linked flood forecast point)'),
      checked_at:now.toISOString(),valid_until:until,alerts:hits.map(h=>({event:h.event,class:h.class,scope:h.scope,window:h.window,onset:h.onset,ends:h.ends,url:h.url})),
      flood_gauge:g,source:'https://api.weather.gov/alerts/active?area=TX'};
  });
  return {generated_at:now.toISOString(),places};
}
async function publicHazardsStatus(){
  const links=await getJson('data/hazard-links.json?v=20261003-place-history-v35'),lids=[...new Set(links.places.map(p=>p.flood_gauge?.lid).filter(Boolean))];
  const [alerts,...results]=await Promise.allSettled([
    acquireHazardJson('https://api.weather.gov/alerts/active?area=TX'),
    ...lids.map(lid=>acquireHazardJson(`https://api.water.noaa.gov/nwps/v1/gauges/${lid}`))]);
  const captures={alerts:alerts.status==='fulfilled'?alerts.value:null,gauges:{}};
  results.forEach((r,i)=>{if(r.status==='fulfilled')captures.gauges[lids[i]]=r.value;});
  window.publicHazardCaptures=captures;
  return assessPublicHazards(links,captures.alerts,captures.gauges);
}
