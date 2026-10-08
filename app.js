/* Austin Swim Map — browser checks free public sources with fixed, auditable rules.
   Static files provide the place inventory, rules and geometry. Personal visit records are excluded. */
'use strict';
const $=s=>document.querySelector(s);
const APP_VERSION='2026-10-08-pages';
const detailBody=$('#detail-body'), detailPanel=$('#detail'), list=$('#place-list'), poolList=$('#pool-list'), freshness=$('#freshness');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const AUSTIN_BOUNDS=[[30.16,-97.93],[30.44,-97.66]];
const BARTON_BOUNDS=[[30.235,-97.86],[30.285,-97.76]];
const ALL_BOUNDS=[[29.45,-100.0],[30.85,-97.5]];
const DOWNTOWN=[30.2672,-97.7431]; // orientation anchor for rim distances: downtown Austin, straight-line miles
const isAustin=p=>p.region==='Austin'||(p.region||'').startsWith('Austin /')||p.region==='Barton Creek Greenbelt';
const NOW=()=>Date.now();
const FLOW_READING_MAX_AGE_MS=90*60000;
const FLOW_PLANNING_MAX_AGE_MS=6*3600000;

let places=[],gauges=[],cityGauges=[],cityHydrometMeta={},readings={},visits=[],flowMeta={},operatorMeta={},noticeContext={},hazards={},outdoor={},context={stations:{}},relationships={places:{}},layers=[],selectedId=null,creekLayer=null,parkLayer=null,groupsBeyond=[];
const layerChoice={holes:true,pools:true,context:false,gauges:false,cityGauges:false};
let cityHoursView='today';
try{ const saved=JSON.parse(localStorage.getItem('austin-swim-map-layers')||'{}'); layerChoice.holes=saved.holes!==false; layerChoice.pools=saved.pools!==false; layerChoice.context=saved.context===true; layerChoice.gauges=saved.gauges===true; layerChoice.cityGauges=saved.cityGauges===true;
  cityHoursView=localStorage.getItem('austin-swim-map-city-hours')==='now'?'now':'today'; }catch(e){}
const CLASS_LABEL={rule_linked_product_baseline:'Rule link · recorded third-party product baseline',rule_linked_provisional_personal:'Rule link · provisional band from recorded visits (limited evidence)',rule_linked_hypothesis:'Hypothetical flow link · station relationship and local depth uncertain',context_station_upstream:'Context · station upstream of this place',context_station_downstream:'Context · station downstream of this place',context_same_waterbody_unpositioned:'Context · same creek, position not computed',spring_discharge_context:'Context · spring discharge feeding the pool',none:'No station relationship'};
let map=null; const hasLeaflet=typeof L!=='undefined';

/* ---------- time helpers ---------- */
function fmt(s){ if(!s) return 'not recorded'; const d=new Date(s); if(Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' CT'; }
function fmtDate(s){ if(!s) return ''; const [y,m,d]=s.split('-').map(Number); return new Date(Date.UTC(y,m-1,d,12)).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}); }
function ago(s){ const ms=NOW()-Date.parse(s); if(!Number.isFinite(ms)) return ''; const m=Math.round(ms/60000); if(m<60) return `${m} min ago`; const h=Math.round(m/60); if(h<48) return `${h} h ago`; return `${Math.round(h/24)} days ago`; }

/* ---------- status semantics ---------- */
/* City captures carry both day and instant assessments. The chosen view changes only
   their display; the same checked source pages underlie both. */
function assessmentForView(p){
  return cityHoursView==='today'&&p.today_status?{...p,status:p.today_status,reason:p.today_reason,valid_until:p.today_valid_until}:p;
}
/* effective() applies the browser-side expiry: a saved color is only shown while its valid_until holds. */
function ratingDeadline(p){
  const limits=[Date.parse(p.valid_until)];
  if(p.rule_source&&!p.operator_override) limits.push(Date.parse(p.observed_at)+FLOW_PLANNING_MAX_AGE_MS);
  if(p.category==='managed_pool'||p.category==='lake_park'||p.place_role==='managed_pool'){
    const sources=[p.source_retrieved_at,p.closure_retrieved_at];
    if(p.category==='managed_pool'||p.place_role==='managed_pool') sources.push(p.index_retrieved_at);
    if(p.hours_source) sources.push(p.hours_source_retrieved_at);
    limits.push(...sources.map(s=>Date.parse(s)+7200000));
  }
  return limits.every(Number.isFinite)?Math.min(...limits):NaN;
}
function effective(p){
  p=assessmentForView(p);
  const closure=p.operator_notice;
  if(closure&&(!closure.closed_until||NOW()<Date.parse(closure.closed_until))){
    if(NOW()<Date.parse(closure.reviewed_until)) p={...p,status:'red',reason:closure.reason,evidence:'Official operator swimming closure; independent of station flow',observed_at:closure.checked_at,valid_until:closure.reviewed_until,rule_source:closure.source,hypothetical:false,operator_override:true};
    else p={...p,status:'gray',reason:'Official swimming closure needs a new operator check; flow alone cannot establish access',evidence:'Operator status stale',observed_at:null,valid_until:null,rule_source:null,hypothetical:false,operator_override:false};
  }
  if(p.hypothetical&&hasRating(p.status)){
    const hazard=hazards[p.id];
    if(!hazard||sidecarExpired(hazard)){
      if(p.status==='green') p={...p,status:'yellow',reason:`Current official hazard check unavailable; favorable guess paused. ${p.reason}`};
    }else if(hazard.hazard_notice==='unknown'){
      if(p.status==='green') p={...p,status:'yellow',reason:`Official flood or severe-weather status unresolved: ${hazard.reason}; favorable guess paused. ${p.reason}`};
    }else if(hazard.hazard_notice==='active') p={...p,status:'red',hazard_override:true,reason:`Active official flood or severe-weather notice: ${hazard.reason}. ${p.reason}`};
    else if(hazard.hazard_notice==='caution'&&p.status==='green') p={...p,status:'yellow',reason:`Official flood or severe-weather caution: ${hazard.reason}. ${p.reason}`};
  }
  const deadline=hasRating(p.status)?ratingDeadline(p):Date.parse(p.valid_until),missingDeadline=hasRating(p.status)&&!Number.isFinite(deadline);
  const expired=missingDeadline||(p.valid_until&&Number.isFinite(deadline)&&NOW()>=deadline);
  if(expired&&p.status&&p.status!=='gray'){
    return {...p,status:'gray',expired:true,last_status:p.status,
      reason:missingDeadline?'Rating has no verifiable expiry time; the map will retry its source check.':`Assessment expired at ${fmt(p.valid_until)}. It was ${p.status} then (${p.reason}). The map will retry its source check.`,
      evidence:'Stale local snapshot'};
  }
  if(expired) return {...p,expired:true,last_status:'gray',reason:`Check expired at ${fmt(p.valid_until)}. It was already uncertain then (${p.reason}). The map will retry its source check.`};
  return p;
}
function hasRating(status){ return ['red','yellow','green'].includes(status); }
function flowCurrentAgeMs(p){return BLUNN_PLACES.includes(p.id)?CITY_HYDROMET_MAX_AGE_MS:FLOW_READING_MAX_AGE_MS;}
function displayStatus(status){ return hasRating(status)?status:'unrated'; }
function freshZeroFlow(reading,at=NOW()){
  if(!reading||reading.parameter!=='00060'||reading.value!==0) return false;
  const age=at-Date.parse(reading.observed_at);
  return Number.isFinite(age)&&age>=-300000&&age<FLOW_READING_MAX_AGE_MS;
}
function gaugeFlowColor(g){
  if(flowMeta.live_flow_failures?.includes(g.id)) return null;
  const q=(readings['USGS-'+g.id]||[]).find(r=>r.parameter==='00060');
  return freshZeroFlow(q)?'red':null;
}
function currentHistoryReading(kind,id,parameter='00060'){
  if(kind==='city'){
    const station=cityGauges.find(g=>g.id===id),value=parameter==='00065'?station?.stage_ft:station?.flow_cfs;
    return !cityHydrometMeta.failed&&cityHydrometMeta.checked_at&&station&&cityHydrometCurrent(station)&&Number.isFinite(value)
      ?{value,observed_at:station.observed_at}:null;
  }
  if(flowMeta.live_flow_failures?.includes(id)||flowMeta.live_flow_failures?.includes('source check'))return null;
  const check=flowMeta.live_flow_station_checks?.[id];
  if(!check||check.state!=='current')return null;
  const reading=(readings['USGS-'+id]||[]).find(row=>row.parameter===parameter);
  const age=NOW()-Date.parse(reading?.observed_at);
  return reading&&Number.isFinite(reading.value)&&Number.isFinite(age)&&age>=-300000&&age<FLOW_READING_MAX_AGE_MS
    ?{value:reading.value,observed_at:reading.observed_at}:null;
}
function currentHistoryReadings(kind,id){return {'00060':currentHistoryReading(kind,id,'00060'),'00065':currentHistoryReading(kind,id,'00065')};}
/* kindOf() names the *type* of answer, separately from its color. */
function kindOf(p){
  const a=effective(p);
  if(a.expired) return {key:'expired',label:'Snapshot expired'};
  if(a.operator_override) return {key:'closed',label:'Official swimming closure'};
  if(a.category==='managed_pool'||a.category==='lake_park'||p.place_role==='managed_pool'){
    if(a.status==='green') return {key:'scheduled',label:cityHoursView==='today'?'Open sometime today':'Scheduled open now'};
    if(a.status==='red') return {key:'closed',label:'Closed / outside hours'};
    if(a.conflict) return {key:'unknown',label:'Conflicting City notices'};
    return {key:'unknown',label:'Unknown'};
  }
  if(a.rule_source&&a.status!=='gray') return a.hazard_override?{key:'warning',label:'Official warning · flow guess suspended'}:a.hypothetical?{key:'hypothesis',label:'Pale hypothetical flow guess'}:{key:'measured',label:NOW()-Date.parse(a.observed_at)>=flowCurrentAgeMs(p)?'Earlier flow · planning cue':'Measured flow · rule applied'};
  if(p.map_display==='list_only') return {key:'unknown',label:'Location unresolved'};
  if(!p.gauge&&!p.gauge_context) return {key:'unknown',label:'No gauge linked'};
  if(p.creek==='Blunn Creek') return {key:'unknown',label:'City station linked · no current flow cue'};
  if(p.gauge&&!a.rule_source) return {key:'unknown',label:'Station linked · no rule'};
  return {key:'unknown',label:'Unknown'};
}
function shortTag(p){
  const a=effective(p),k=kindOf(p);
  if(k.key==='expired') return 'rating expired';
  if(k.key==='warning') return 'official warning · red';
  if(a.operator_override) return 'official swimming closure · check operator';
  if(k.key==='hypothesis') return `pale ${a.status} flow guess · ${a.observed_at?(NOW()-Date.parse(a.observed_at)>=FLOW_READING_MAX_AGE_MS?'earlier planning cue; station observed ':'current station observation; observed ')+ago(a.observed_at):'station time unavailable'} · depth here unknown`;
  if(k.key==='measured'){ const m=/measured ([0-9.]+) (ft\^3\/s|cfs|ft3\/s)/.exec(a.reason||''); const word=a.status==='green'?'flow in band':a.status==='yellow'?'borderline flow':'flow outside band'; return (m?`${word} · ${m[1]} ${m[2].replace('ft^3/s','cfs')}`:word)+(NOW()-Date.parse(a.observed_at)>=flowCurrentAgeMs(p)?' · earlier planning cue':'')+' · depth unmeasured'; }
  if(k.key==='scheduled') return cityHoursView==='today'?'open today':'scheduled open now';
  if(k.key==='closed') return cityHoursView==='today'?'closed today':'closed now';
  if(a.conflict) return 'notices conflict';
  if(p.map_display==='list_only') return 'not on map · unresolved';
  if(p.place_role==='park_reference') return 'reference · no verdict';
  if(p.place_role==='creek_context') return 'context only';
  if(p.creek==='Blunn Creek') return /rain/i.test(a.reason||'')?'station rain · flow cue paused':a.observed_at&&NOW()-Date.parse(a.observed_at)>=CITY_HYDROMET_MAX_AGE_MS?'earlier station reading · no supported flow cue':'City station linked · no current flow cue';
  if(p.gauge&&!a.rule_source) return 'station only · no rule';
  return 'no gauge linked';
}
function symbolFor(p){ return p.place_role==='managed_pool'?'◉':p.place_role==='park_reference'?'⌂':p.place_role==='creek_context'?'○':'★'; }
function shapeClass(p){ return p.place_role==='managed_pool'?'pool':p.place_role==='park_reference'?'park':p.place_role==='creek_context'?'ctx':'star'; }
function unverified(p){ return ['derived_on_centerline','park_centroid','park_reference','unresolved'].includes(p.coordinate_method)||(!p.coordinate_method&&isAustin(p)); }
function categoryOf(p){ return p.place_role==='managed_pool'?'pool':p.place_role==='park_reference'?'park':p.place_role==='creek_context'?'context':'creek'; }
function layerForPlace(p){ return p.place_role==='managed_pool'?'pools':p.place_role==='creek_context'?'context':'holes'; }
function visiblePlace(p){ return layerChoice[layerForPlace(p)]; }
function revealPlaceLayer(p){ const key=layerForPlace(p); if(layerChoice[key]) return; layerChoice[key]=true; $('#show-'+key).checked=true; saveLayerChoice(); buildGroups(); renderRim(); }
function saveLayerChoice(){ try{localStorage.setItem('austin-swim-map-layers',JSON.stringify(layerChoice));}catch(e){} }
function areaOf(p){
  if(p.place_role==='creek_context') return 'Creek and gauge context (not swimming places)';
  if(p.region==='Barton Creek Greenbelt') return 'Barton Creek Greenbelt';
  if(p.creek==='Bull Creek') return 'Bull Creek';
  if(p.region==='Austin / Lake Austin') return 'Lake Austin parks';
  if(p.place_role==='managed_pool') return 'City pools (individually checked)';
  return 'Other Austin creeks';
}

/* ---------- map ---------- */
if(hasLeaflet){
  map=L.map('map',{scrollWheelZoom:true,zoomControl:true,attributionControl:false});
  L.control.attribution({position:'bottomleft',prefix:false}).addTo(map);
  map.fitBounds(AUSTIN_BOUNDS,{padding:[10,10]});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap contributors · parks & creek lines © City of Austin'}).addTo(map);
  map.createPane('parks'); map.getPane('parks').style.zIndex=380;
  map.createPane('creekHalo'); map.getPane('creekHalo').style.zIndex=390;
  map.createPane('creekWater'); map.getPane('creekWater').style.zIndex=400;
}
function creekWeight(){ const z=map.getZoom(); return z<=11?1.6:z===12?2.2:z===13?3:z===14?3.6:4.4; }
function styleCreeks(){ if(!creekLayer) return; const w=creekWeight();
  creekLayer.halo.setStyle({weight:w+2.2}); creekLayer.water.setStyle({weight:w}); }
async function loadGeometry(){
  if(!hasLeaflet) return;
  try{
    const parks=await getJson('austin-parks.geojson');
    parkLayer=L.geoJSON(parks,{pane:'parks',interactive:false,style:{color:'#6a8f5a',weight:1,fillColor:'#a7cb88',fillOpacity:.32}}).addTo(map);
  }catch(e){ note('City park boundaries unavailable; markers still work.'); }
  try{
    let creeks; try{ creeks=await getJson('austin-creeks-city.geojson'); }catch(e){ creeks=await getJson('austin-creeks.geojson'); note('Showing the older OpenStreetMap creek ways; City creek lines did not load.'); }
    const filter=f=>f.properties.feature_kind==='waterway'&&!/UNDERGROUND|STORMDRAIN/.test(f.properties.creek_type||'');
    const halo=L.geoJSON(creeks,{pane:'creekHalo',interactive:false,filter,style:{color:'#2f5f66',weight:4,opacity:.55,lineCap:'round',lineJoin:'round'}}).addTo(map);
    const water=L.geoJSON(creeks,{pane:'creekWater',interactive:false,filter,style:{color:'#6db6c8',weight:2,opacity:1,lineCap:'round',lineJoin:'round'}}).addTo(map);
    creekLayer={halo,water}; styleCreeks();
  }catch(e){ note('Creek geometry unavailable; map markers and cards still work.'); }
}
function note(t){ const n=$('#geometry-note'); if(n) n.textContent=(n.textContent?n.textContent+' ':'')+t; }

function markerIcon(kind,status,label,extra=''){
  return L.divIcon({className:'',html:`<span class="geo-marker ${kind} ${displayStatus(status)} ${extra}" aria-hidden="true">${label}</span>`,iconSize:[40,40],iconAnchor:[20,20]});
}
function addPlace(p){
  const a=effective(p); const extra=`${shapeClass(p)}${a.hypothetical&&!a.hazard_override?' hypothetical':''}${unverified(p)?' unverified':''}${p.id===selectedId?' selected':''}`;
  const label=symbolFor(p);
  const m=L.marker([p.lat,p.lon],{icon:markerIcon('place',a.status,label,extra),title:`${p.name} — ${shortTag(p)}`,keyboard:true,alt:`${p.name}, ${shortTag(p)}`}).addTo(map);
  m.bindTooltip(`${esc(p.name)} · ${esc(shortTag(p))}`,{direction:'top',offset:[0,-20]});
  m.on('click',()=>selectPlace(p)); layers.push(m);
}
function groupPie(group){
  const counts={red:0,yellow:0,green:0,unrated:0};
  group.forEach(p=>{const status=effective(p).status;counts[hasRating(status)?status:'unrated']++;});
  const colors={red:'var(--red)',yellow:'var(--yellow)',green:'var(--green)',unrated:'var(--paper)'};
  let cursor=0;
  const slices=Object.entries(counts).filter(([,count])=>count).map(([status,count])=>{
    const start=cursor;cursor+=count/group.length*100;
    return `${colors[status]} ${start}% ${cursor}%`;
  });
  const kind=categoryOf(group[0]);
  const kinds={pool:['City pools','◉'],park:['park references','⌂'],context:['creek context points','○'],creek:['swimming holes','★']};
  return {counts,background:slices.length?`conic-gradient(from -90deg, ${slices.join(', ')})`:'var(--paper)',
    what:kinds[kind][0],glyph:kinds[kind][1],
    summary:Object.entries(counts).filter(([,count])=>count).map(([status,count])=>`${count} ${status==='unrated'?'without a current rating':status}`).join(' · ')};
}
function addGroup(group){
  const lat=group.reduce((s,p)=>s+p.lat,0)/group.length, lon=group.reduce((s,p)=>s+p.lon,0)/group.length;
  const pie=groupPie(group);
  const icon=L.divIcon({className:'',html:`<span class="cluster-pie" style="background:${pie.background}" aria-hidden="true"><span class="cluster-total">${group.length}</span><span class="cluster-kind">${pie.glyph}</span></span>`,iconSize:[52,52],iconAnchor:[26,26]});
  const label=`${group.length} ${pie.what} nearby: ${pie.summary}. Open for place names.`;
  const marker=L.marker([lat,lon],{icon,title:label,alt:label,keyboard:true}).addTo(map);
  marker.bindTooltip(esc(label),{direction:'top',offset:[0,-26]});
  marker.on('click',()=>{ if(map.getZoom()<15) map.flyTo([lat,lon],Math.min(map.getZoom()+2,16)); showGroup(group); });
  layers.push(marker);
}
function addGauge(g){
  const zero=gaugeFlowColor(g)==='red';
  const m=L.marker([g.lat,g.lon],{icon:markerIcon('gauge',zero?'red':null,'◆',g.id===selectedId?'selected':''),title:`USGS gauge: ${g.name}${zero?' — 0 cfs at station':''}`,keyboard:true,alt:`USGS gauge ${g.name}${zero?', fresh reading of 0 cfs at station':''}`}).addTo(map);
  m.bindTooltip(`Gauge · ${esc(g.name)}${zero?' · 0 cfs at station':''}`,{direction:'bottom',offset:[0,18]}); m.on('click',()=>selectGauge(g)); layers.push(m);
}
function addCityGauge(g){
  const zero=!cityHydrometMeta.failed&&cityHydrometCurrent(g)&&g.flow_cfs===0;
  const m=L.marker([g.lat,g.lon],{icon:markerIcon('city-gauge',zero?'red':null,'▣',`city-gauge${'city-'+g.id===selectedId?' selected':''}`),
    title:`City Hydromet: ${g.name}${zero?' — 0 cfs at station':''}`,keyboard:true,alt:`City Hydromet ${g.name}`}).addTo(map);
  m.bindTooltip(`City Hydromet · ${esc(g.name)}${zero?' · 0 cfs at station':''}`,{direction:'bottom',offset:[0,18]});
  m.on('click',()=>selectCityGauge(g));layers.push(m);
}
function render(){
  if(!hasLeaflet) return;
  layers.forEach(x=>x.remove()); layers=[];
  // Extent buttons move the camera; panning or zooming must never hide saved places.
  const local=places.filter(p=>p.map_display!=='list_only'&&visiblePlace(p));
  const z=map.getZoom();
  if(z<15){
    const groups=[];
    for(const p of local){
      const pt=map.latLngToLayerPoint([p.lat,p.lon]);
      const match=groups.find(g=>categoryOf(g[0])===categoryOf(p)&&Math.hypot(pt.x-map.latLngToLayerPoint([g[0].lat,g[0].lon]).x,pt.y-map.latLngToLayerPoint([g[0].lat,g[0].lon]).y)<56);
      if(match) match.push(p); else groups.push([p]);
    }
    groups.forEach(g=>g.length>1?addGroup(g):addPlace(g[0]));
  } else local.forEach(addPlace);
  if(layerChoice.gauges) gauges.forEach(addGauge);
  if(layerChoice.cityGauges) cityGauges.forEach(addCityGauge);
  styleCreeks();
}

/* ---------- detail card ---------- */
function openSheet(){ detailPanel.classList.add('open'); $('#sheet-close').hidden=false; }
function closeSheet(){ detailPanel.classList.remove('open'); }
$('#sheet-close').onclick=closeSheet;

function stationReadings(g){
  const rs=readings['USGS-'+g.id]||readings[g.id]||[];
  const check=flowMeta.live_flow_station_checks?.[g.id];
  if(!rs.length) return `<div class="muted">${check?.state==='check failed'?'USGS check failed; retrying automatically.':'No compatible current USGS reading returned for this station.'}${check?.checked_at?` Checked ${fmt(check.checked_at)}.`:''}</div>`;
  const measurement=rs.filter(r=>['00060','00065'].includes(r.parameter)).map(r=>{
    const label=r.parameter==='00060'?'Discharge':'Gage height'; const age=NOW()-Date.parse(r.observed_at);
    if(!Number.isFinite(age)||age< -300000||age>=FLOW_PLANNING_MAX_AGE_MS) return `<div class="stale"><b>${label}:</b> No recent reading${Number.isFinite(age)?` · last reported ${fmt(r.observed_at)} (${ago(r.observed_at)})`:''}.</div>`;
    const value=r.parameter==='00060'&&r.value===0?'0.00 (a real reading of no measurable flow)':`${r.value}`;
    return `<div${age>=FLOW_READING_MAX_AGE_MS?' class="stale"':''}><b>${label}:</b> ${age>=FLOW_READING_MAX_AGE_MS?'Earlier reading · ':''}${esc(value)} ${esc(r.unit.replace('ft^3/s','cfs').replace('ft3/s','cfs'))} · observed ${fmt(r.observed_at)} <span class="muted">(${ago(r.observed_at)})</span></div>`;
  }).join('');
  const trend=flowMeta.live_flow_trends?.[g.id];
  return measurement+(rs.some(r=>r.parameter==='00065')?'<div class="muted">Gage height is water level above this station’s reference point; it is not depth at a swimming place.</div>':'')
    +(trend?`<div><b>Discharge trend:</b> ${esc(trend.direction)} over ${esc(trend.hours)} h · ${esc(trend.earlier_value)} → ${esc(trend.latest_value)} cfs</div>`:'')
    +(check?.checked_at?`<div class="evidence">USGS checked ${fmt(check.checked_at)} · ${esc(check.state)}${check.last_success_at?` · last successful fetch ${fmt(check.last_success_at)}`:''}</div>`:'');
}
function visitRows(p){ return visits.filter(v=>v.place_id===p.id||((p.id==='bull-creek-district'||p.id==='st-edwards')&&v.place_id==='bull-creek-unresolved')||((p.id==='mckinney-upper'||p.id==='mckinney-lower')&&v.place_id==='mckinney-falls-unspecified')); }
function visitDate(v){ if(v.id==='bull-july-unknown') return 'July 18 weekend (year unresolved)'; if(v.date==='--06-21') return 'June 21 (year unresolved)'; return v.date?fmtDate(v.date.length===7?v.date+'-01':v.date).replace(/^(\w+) 1, /,v.date.length===7?'$1 ':'$1 1, '):'Date unresolved'; }
function showVisits(p){
  const rows=visitRows(p), holder=$('#visits'); if(!holder) return;
  holder.innerHTML=rows.filter(v=>v.date_precision!=='none').map(v=>`<p><b>${esc(visitDate(v))}</b> · ${esc(v.reported_quality||'rating not recorded')} · ${esc(v.date_precision)} precision${v.reach?` · ${esc(v.reach)}`:' · reach unresolved'}</p>`).join('')
    +(rows.some(v=>v.id==='bull-order')?'<p>The July visit was rated above the May and June visits; the exact reach and the July year remain unresolved.</p>':'')
    +'<p class="muted">These are remembered visits, kept as historical references. No flow rule was fitted from them, and today’s notices do not describe those days.</p>';
  holder.hidden=false;
}
function noticeHtml(n){
  const cls=n.in_effect?'in-effect':''; const when=n.in_effect===true?'in effect today':n.in_effect===false?'not in effect today':'dates not machine-readable';
  return `<div class="notice ${cls}"><b>${esc(n.title)}</b>${esc(n.dates_text)} · ${when} · City entry updated ${esc(fmtDate(n.updated)||'unknown')}<br><span class="muted">${esc(n.description.slice(0,260))}${n.description.length>260?'…':''}</span></div>`;
}
/* Hydrologic context (tools/hydro_context.py) and authored place relationships (data/model/place-relationships.json).
   Context describes a station; the relationship record says how a station relates to a place and what is still missing. */
function sparkline(series,unit,label=''){ if(!series||series.length<2) return ''; const vals=series.map(x=>x[1]); const min=Math.min(...vals),max=Math.max(...vals),w=280,h=44,pad=3;
  const y=v=>max===min?h/2:pad+(h-2*pad)*(1-(v-min)/(max-min));
  const pts=series.map((x,i)=>`${(pad+i*(w-2*pad)/(series.length-1)).toFixed(1)},${y(x[1]).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Last ${context.window_hours||48} hours: ${esc(min)} to ${esc(max)} ${esc(unit)}"><polyline points="${pts}" fill="none" stroke="#2d6f7a" stroke-width="2"/></svg><p class="evidence">${label?esc(label)+' · ':''}${context.window_hours||48} h · ${esc(min)}–${esc(max)} ${esc(unit.replace('ft^3/s','cfs'))} · ${series.length} points</p>`; }
function stationContext(id){ const c=context.stations?.[id]; if(!c) return '<p class="muted">No hydrologic-context snapshot for this station.</p>';
  const q=c.parameters?.['00060'],h=c.parameters?.['00065']; const stale=context.generated_at&&NOW()-Date.parse(context.generated_at)>7200000;
  return `<p class="narrative">${esc(c.narrative)}</p>${q?sparkline(q.series,q.unit,h?'Discharge':''):''}${h?sparkline(h.series,h.unit,'Gage height'):''}<p class="evidence">${esc(c.evidence_strength||'')} · generated ${fmt(context.generated_at)}${stale?' · <span class="stale">context older than two hours</span>':''}</p>`; }
function relationRows(p){ const rec=relationships.places?.[p.id]; const rows=rec?.stations||[];
  if(!rows.length&&p.gauge){ const g=gauges.find(x=>x.id===p.gauge); return g?[{station_id:g.id,relationship_class:'none',position:g.link_status,confidence:'none'}]:[]; }
  return rows; }
let waterMap={stations:{}};
function waterMapLink(id){const w=waterMap.stations?.[id];if(!w)return '';return `<a class="water-map-link" href="${esc(waterMap.water_map_url+'#'+w.anchor)}" target="_blank" rel="noreferrer">Full record ${esc(w.first)}–${esc(w.last)} and earlier floods on the water map ↗</a>`;}
function openFromAddress(){const m=/^#gauge\.([0-9A-Za-z]+)$/.exec(location.hash||'');if(!m)return;const g=gauges.find(x=>x.id===m[1]);if(!g)return;if(hasLeaflet&&Number.isFinite(g.lat))map.setView([g.lat,g.lon],Math.max(map.getZoom(),13),{animate:false});selectGauge(g);}
function stationBlock(s){ const g=gauges.find(x=>x.id===s.station_id); if(!g) return '';
  return `<div class="reading"><b>${esc(g.name)}</b> <span class="muted">(USGS ${esc(g.id)})</span>${gaugeFlowColor(g)==='red'?'<span class="gauge-zero-note">Red at station · 0 cfs</span>':''}<div class="relation-class">${esc(CLASS_LABEL[s.relationship_class]||s.relationship_class)} · confidence ${esc(s.confidence)}</div><div class="muted">${esc(s.position)}</div>${stationReadings(g)}<a href="${esc(g.source)}" target="_blank" rel="noreferrer">USGS station page ↗</a>${waterMapLink(g.id)?'<br>'+waterMapLink(g.id):''}</div>`; }
function relationBlock(p){ const rec=relationships.places?.[p.id]; if(!rec) return '';
  return `<div class="fact relation"><h3>Relationship · evidence and limits</h3><p><b>Water:</b> ${esc(rec.waterbody)} · <b>type:</b> ${esc(String(rec.archetype||'').replaceAll('_',' '))}</p>${rec.missing_for_color?.length?`<p><b>Remaining gaps:</b></p><ul>${rec.missing_for_color.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}<p class="muted">${esc(rec.current_treatment||'')}</p></div>`; }
function hydroBlock(rows){ const withCtx=rows.filter(s=>context.stations?.[s.station_id]); if(!withCtx.length) return '';
  return `<div class="fact hydro"><h3>Hydrologic context · station, not a swim verdict</h3>${withCtx.map(s=>stationContext(s.station_id)).join('')}</div>`; }
function renderStations(){ const holder=$('#station-list'); if(!holder) return;
  holder.innerHTML=gauges.length?gauges.map(g=>{const q=(readings['USGS-'+g.id]||[]).find(r=>r.parameter==='00060'),h=(readings['USGS-'+g.id]||[]).find(r=>r.parameter==='00065');
    const age=q?NOW()-Date.parse(q.observed_at):NaN,stageAge=h?NOW()-Date.parse(h.observed_at):NaN;
    const current=Number.isFinite(age)&&age>=-300000&&age<FLOW_READING_MAX_AGE_MS;
    const earlier=Number.isFinite(age)&&age>=FLOW_READING_MAX_AGE_MS&&age<FLOW_PLANNING_MAX_AGE_MS;
    const stageCurrent=Number.isFinite(stageAge)&&stageAge>=-300000&&stageAge<FLOW_READING_MAX_AGE_MS;
    const stageRecent=Number.isFinite(stageAge)&&stageAge>=-300000&&stageAge<FLOW_PLANNING_MAX_AGE_MS,stage=stageRecent?` · ${h.value} ft`:'';
    const trend=flowMeta.live_flow_trends?.[g.id];
    const failed=flowMeta.live_flow_failures?.includes(g.id),zero=gaugeFlowColor(g)==='red',tag=zero?`0 cfs${stage} · no measurable flow`:q&&current?`${q.value} cfs${stage} · ${failed?'last fetched':trend?trend.direction:'current'}`:q&&earlier?`${q.value} cfs${stage} · earlier reading`
      :stageRecent?`${h.value} ft stage · ${stageCurrent?(failed?'last fetched':'current'):'earlier reading'}`:'no recent reading';
    return `<div class="place-row"><button data-station="${esc(g.id)}" type="button"><span class="sym gauge-list ${zero?'red':''}" aria-hidden="true">◆</span><span>${esc(g.name)}</span></button><span class="tag ${zero?'red':''}">${esc(tag)}</span></div>`; }).join(''):'<p class="muted">No USGS gauges in this inventory.</p>';
  holder.querySelectorAll('button[data-station]').forEach(b=>b.onclick=()=>{ const g=gauges.find(x=>x.id===b.dataset.station); if(g){ if(hasLeaflet) map.flyTo([g.lat,g.lon],14); selectGauge(g); if(window.innerWidth>780) detailPanel.scrollIntoView({behavior:'smooth',block:'nearest'}); } }); }
function cityMeasurement(g){
  const age=NOW()-Date.parse(g.observed_at),recent=Number.isFinite(age)&&age>=-300000&&age<FLOW_PLANNING_MAX_AGE_MS;
  const current=!cityHydrometMeta.failed&&cityHydrometCurrent(g);
  const note=cityHydrometMeta.failed?'last captured · source check failed':current?`current measurement (${ago(g.observed_at)})`:recent?`earlier station observation (${ago(g.observed_at)})`:'no recent reading';
  const flow=!recent?'No recent discharge reading':g.flow_cfs===null?'No discharge value reported':`Discharge: <b>${esc(g.flow_cfs)} cfs</b>${current&&g.flow_cfs===0?' · no measurable flow at this station':''}`;
  const stage=!recent?'No recent stage reading':g.stage_ft===null?'No stage value reported':`Stage: <b>${esc(g.stage_ft)} ft</b> above the station datum`;
  const rain=!recent?'No recent station rain reading':g.rainfall_1h==null?'Past-hour station rain not reported':g.rainfall_1h>0?'Rain reported at station in the past hour':'No station rain reported in the past hour';
  return `<p>${flow}<br>${stage}<br>${rain}</p><p class="evidence">Observed ${fmt(g.observed_at)} · ${note} · source checked ${fmt(cityHydrometMeta.checked_at)}</p>
    <p class="muted">Stage is water level at this gauge, not depth at a swimming reach. The station reading alone does not rate a place.</p>`;
}
function renderCityStations(){const holder=$('#city-station-list');if(!holder)return;
  holder.innerHTML=cityGauges.length?cityGauges.map(g=>{const current=!cityHydrometMeta.failed&&cityHydrometCurrent(g),zero=current&&g.flow_cfs===0;
    const age=NOW()-Date.parse(g.observed_at),recent=Number.isFinite(age)&&age>=-300000&&age<FLOW_PLANNING_MAX_AGE_MS;
    const label=current?(g.flow_cfs!==null?`${g.flow_cfs} cfs${g.stage_ft!==null?` · ${g.stage_ft} ft`:''}`:`${g.stage_ft} ft stage`):cityHydrometMeta.failed?'check failed':recent?'earlier reading':'no recent reading';
    return `<div class="place-row"><button data-city-station="${esc(g.id)}" type="button"><span class="sym city-gauge-list ${zero?'red':''}" aria-hidden="true">▣</span><span>${esc(g.name)}</span></button><span class="tag ${zero?'red':''}">${esc(label)}</span></div>`;}).join('')
    :`<p class="muted">${cityHydrometMeta.failed?'City Hydromet check failed; the map will retry.':'Checking City Hydromet stations…'}</p>`;
  holder.querySelectorAll('button[data-city-station]').forEach(button=>button.onclick=()=>{const g=cityGauges.find(item=>item.id===button.dataset.cityStation);
    if(g){if(hasLeaflet)map.flyTo([g.lat,g.lon],14);selectCityGauge(g);if(window.innerWidth>780)detailPanel.scrollIntoView({behavior:'smooth',block:'nearest'});}});
}
function blunnCityBlock(p){
  if(!['blunn-big-stacey','blunn-little-stacey'].includes(p.id))return '';
  const g=cityGauges.find(item=>item.id==='122');
  return g?`<div class="reading"><b>Blunn Creek at Stacy Park</b> <span class="muted">(City Hydromet 122)</span>
    <p class="muted">Downstream on the same mapped creek; measured at the station, not at this reach.</p>${cityMeasurement(g)}
    <a href="${esc(g.source)}" target="_blank" rel="noreferrer">City Hydromet station history ↗</a></div>`
    :`<p>City Hydromet site 122 has no live reading here${cityHydrometMeta.failed?' because its check failed':''}; the map will retry. <a href="https://hydromet.lcra.org/HistoricalData/Coa" target="_blank" rel="noreferrer">Check the official station ↗</a>.</p>`;
}
/* Sidecars from the switchboard inbox, copied by this map's manual refresh command.
   Both are shown on the card only; neither ever touches a marker color. */
function sidecarExpired(x){ return !x||(x.valid_until&&NOW()>Date.parse(x.valid_until)); }
function hazardBlock(p){
  const h=hazards[p.id];
  if(!h) return '<p class="muted">Checking current NWS notices…</p>';
  if(sidecarExpired(h)) return `<p class="muted">Saved NWS check expired (${fmt(h.checked_at)}). This context has no current result here; check the <a target="_blank" rel="noreferrer" href="https://api.weather.gov/alerts/active?area=TX">current NWS alerts ↗</a>.</p>`;
  const cls=h.hazard_notice==='active'?'active':h.hazard_notice==='caution'?'caution':h.hazard_notice==='none found in checked sources'?'none':'unknown';
  const g=h.flood_gauge?` · <a target="_blank" rel="noreferrer" href="${esc(h.flood_gauge.source)}">NWS gauge ${esc(h.flood_gauge.lid)} ↗</a>`:'';
  if(cls==='none') return `<p class="hazard none"><b>${esc(h.hazard_notice)}</b> · checked ${fmt(h.checked_at)}</p><details class="notice-detail"><summary>What was checked</summary><p>${esc(h.reason)}${g}</p><p class="evidence">${esc(h.evidence)} · <a target="_blank" rel="noreferrer" href="${esc(h.source)}">NWS alerts ↗</a></p></details>`;
  return `<p class="hazard ${cls}"><b>${esc(h.hazard_notice)}</b> · ${esc(h.reason)}${g}</p><p class="evidence">${esc(h.evidence)} · checked ${fmt(h.checked_at)} · <a target="_blank" rel="noreferrer" href="${esc(h.source)}">NWS alerts ↗</a></p>`;
}
function outdoorBlock(p){
  const o=outdoor[p.id]; if(!o) return '<div class="fact outdoor"><h3>Heat / sun today (planning band)</h3><p class="muted">Checking today’s forecast…</p></div>';
  if(sidecarExpired(o)) return '<div class="fact outdoor"><h3>Heat / sun today (planning band)</h3><p class="muted">Current forecast unavailable; the map will retry.</p></div>';
  const w=o.by_window||{};
  return `<div class="fact outdoor"><h3>Heat / sun today (planning band)</h3><p><span class="band ${esc(o.status)}">${esc(o.status)}</span> ${esc(o.status_window)} window · best block ${o.best_block?esc(o.best_block[0]+'–'+o.best_block[1]):'none'} · early ${esc(w.early)} / midday ${esc(w.midday)} / evening ${esc(w.evening)}</p><p class="evidence">Forecast at this place · checked ${fmt(o.observed_at)} · ${esc(o.evidence)} · a band for a person at the place, not a water condition</p></div>`;
}
function selectPlace(p,reveal=true){
  if(reveal) revealPlaceLayer(p);
  selectedId=p.id; render();
  const a=effective(p), k=kindOf(p), gauge=gauges.find(g=>g.id===p.gauge), v=visitRows(p), notices=a.notices||noticeContext[p.id]||[], rows=relationRows(p);
  const measured= rows.length?`<p class="muted">Measured at the station, not at the place.</p>${rows.map(stationBlock).join('')}`
    : p.place_role==='managed_pool'||p.place_role==='park_reference'?'<p>No water measurement applies. This card is about the City’s schedule and notices only.</p>'
    : p.creek==='Blunn Creek'?blunnCityBlock(p)
    : `<p>No gauge reading is pulled into this place card. ${esc(p.gauge_context||'Nearby stations, if any, are shown separately as station context.')}</p>`;
  const bandCaveat=a.hypothetical?'This pale cue is a site-specific station-flow guess. It has no measured depth or condition calibration at this place. A rapid rise can signal flood danger.':(a.evidence||'').includes('limited evidence')?'This provisional band comes from a small set of recorded visits and has no independent validation.':'This band is a recorded third-party flow cue with no independent swimming validation.';
  const depth=p.place_role==='managed_pool'?'<p>No verified pool depth range is stored here. Check the City pool page for facility details.</p>'
    :p.place_role==='park_reference'||p.place_role==='creek_context'?'<p>No swimming area or water depth is established for this reference point.</p>'
    :gauge||p.creek==='Blunn Creek'?'<p>Station discharge is this map’s proxy for likely water at the reach. No direct depth measurement exists here; station stage uses the gauge’s own reference point.</p><p class="evidence"><a href="https://www.usgs.gov/faqs/why-doesnt-usgs-measure-gage-height-bottom-stream" target="_blank" rel="noreferrer">How USGS defines gage height ↗</a></p>'
    :'<p>No direct reach-depth measurement or linked flow proxy is available.</p>';
  const inferred= a.operator_override?`<p>${esc(a.reason)}</p><p class="muted">Official operator access decision, checked ${fmt(a.observed_at)}. The station-flow guess is separate and does not reopen swimming.</p>`
    :a.rule_source&&!a.expired?`<p>${esc(a.reason)}</p><p class="muted">${esc(a.evidence)}. ${bandCaveat} It does not measure reach depth, clarity, bacteria, or access.</p>`
    : a.expired?`<p>${esc(a.reason)}</p>`
    : p.place_role==='managed_pool'||a.category==='lake_park'?`<p>${esc(a.reason)}</p><p class="muted">${esc(a.evidence||'')}</p>`
    : `<p>${esc(a.reason)}</p>${p.rule?`<p class="muted">A recorded rule exists for this place (${esc(p.rule)}), but it can only color the marker with a fresh compatible reading.</p>`:''}`;
  const operator=(a.category||p.place_role==='managed_pool')?`
      ${a.page_status_line?`<p>City page status line: <b>${esc(a.page_status_line)}</b>${a.operator_status?` · City index: generally ${esc(a.operator_status)}`:''}</p>`:a.operator_status?`<p>City index: generally ${esc(a.operator_status)}</p>`:''}
      ${a.conflict?`<div class="notice conflict"><b>Conflicting City notices</b>${esc(a.conflict)}</div>`:''}`:'';
  const noticeBlock=notices.length?notices.map(noticeHtml).join(''):isAustin(p)?'<p class="muted">No entry naming this place on the City closure list at the last check.</p>':'<p class="muted">Austin’s City closure list does not cover this place. Check its operator page for current access.</p>';
  const sourceChecks=isAustin(p)?(a.source_retrieved_at?`City page retrieved ${fmt(a.source_retrieved_at)}`:p.creek==='Blunn Creek'&&a.observed_at?`City Hydromet 122 observed ${fmt(a.observed_at)}; source checked ${fmt(cityHydrometMeta.checked_at)}`:a.observed_at?`USGS reading observed ${fmt(a.observed_at)}`:'No dated City or place assessment')
    :`USGS ${p.gauge?(flowMeta.live_flow_station_checks?.[p.gauge]?.state||'checking')+' at '+fmt(flowMeta.live_flow_station_checks?.[p.gauge]?.checked_at):'no linked station'} · NWS ${hazards[p.id]?fmt(hazards[p.id].checked_at):'checking'} · local forecast ${outdoor[p.id]?fmt(outdoor[p.id].observed_at):'checking'}. Operator access page is linked but not checked automatically.`;
  const sources=[[p.source,'Place / operator source'],[p.coordinate_source,'Coordinate source'],[a.rule_source,'Condition rule'],[a.index_source,'City pool index'],[a.closure_source,'City closure list']]
    .filter(([u])=>u).map(([u,l])=>`<a target="_blank" rel="noreferrer" href="${esc(u)}">${l} ↗</a>`).join(' ');
  detailBody.innerHTML=`
    <p class="eyebrow">${esc(p.region)} · ${esc(p.kind)}</p><h2>${esc(p.name)}</h2>
    <div class="badges">${hasRating(a.status)?`<span class="status ${esc(a.status)}${a.hypothetical&&!a.hazard_override?' hypothetical':''}">${a.hypothetical&&!a.hazard_override?'pale ':''}${esc(a.status)}${a.hazard_override?' official warning':a.rule_source?' flow cue':''}</span>`:''}<span class="kind-badge ${esc(k.key)}">${esc(k.label)}</span></div>
    <p class="reason">${a.status==='gray'?'No current rating · ':''}${p.creek==='Blunn Creek'&&a.observed_at?`Station observed ${esc(ago(a.observed_at))} · `:''}${esc(shortTag(p))}</p>
    <div class="facts">
      <div class="fact notices"><h3>Official notices (NWS)</h3>${hazardBlock(p)}</div>
      <div class="fact measured"><h3>Measured</h3>${measured}</div>
      ${p.gauge?historySection('usgs',p.gauge,gauge?.name||'Linked station'):p.creek==='Blunn Creek'?historySection('city','122','Blunn Creek at Stacy Park · downstream'):historySection(null,null)}
      ${outdoorBlock(p)}
      <div class="fact unknown"><h3>Depth at this place</h3>${depth}</div>
      <div class="fact inferred"><h3>${a.category||p.place_role==='managed_pool'?'City schedule rule':'Inferred'}</h3>${inferred}</div>
      <div class="fact city"><h3>${isAustin(p)?'City notices &amp; access':'Operator access'}</h3>${operator}<p><b>${isAustin(p)?'Access':'Saved access note'}:</b> ${esc(p.access)}</p>${noticeBlock}</div>
      ${relationBlock(p)}
      <div class="fact unknown"><h3>Not assessed</h3><p>Water quality, clarity, rescue coverage, and permission are not established by this map.</p></div>
    </div>
    <p><b>Mapped point:</b> ${esc(p.coordinate_precision||'precision not recorded')}${p.previous_coordinate?` <span class="muted">(moved from an earlier approximate marker on ${esc(p.previous_coordinate.replaced.split(' ')[0])})</span>`:''}</p>
    <p><b>Gauge relationship:</b> ${gauge?`${esc(gauge.name)} — ${esc(gauge.link_status)}`:esc(p.gauge_context||'Gauge not yet linked')}</p>
    <p><b>Source checks:</b> ${sourceChecks}${a.hypothetical&&a.observed_at?` · observation age ${esc(ago(a.observed_at))}`:''}${a.operator_override?` · operator notice reviewed ${fmt(a.observed_at)}`:''}${a.valid_until?` · badge valid until ${fmt(a.valid_until)}`:''}</p>
    <p class="sources">${sources}</p>
    ${v.length?`<button class="btn" id="compare" type="button">${v.some(r=>(r.reported_quality||'').includes('good'))?'Compare with recorded visits':'View recorded visit'}</button><div id="visits" class="visits" hidden></div>`:''}`;
  const c=$('#compare'); if(c) c.onclick=()=>showVisits(p);
  if(p.gauge)mountHistory('usgs',p.gauge,currentHistoryReadings('usgs',p.gauge));
  else if(p.creek==='Blunn Creek')mountHistory('city','122',currentHistoryReadings('city','122'));
  openSheet();
}
function selectGauge(g){
  selectedId=g.id; render();
  const cited=Object.entries(relationships.places||{}).flatMap(([id,rec])=>(rec.stations||[]).filter(s=>s.station_id===g.id).map(s=>({id,name:rec.name,cls:s.relationship_class,conf:s.confidence})));
  const linked=cited.length?cited.map(c=>({...places.find(p=>p.id===c.id),_cls:c.cls,_conf:c.conf})).filter(p=>p.id):places.filter(p=>p.gauge===g.id);
  const flowCues=linked.filter(p=>p.rule||effective(p).rule_source).map(p=>{const a=effective(p);return `<li>${esc(p.name)}: <b>${hasRating(a.status)?esc(a.status):'no current flow rating'}</b>${hasRating(a.status)?` · ${esc(shortTag(p))}`:''}</li>`;}).join('');
  detailBody.innerHTML=`<p class="eyebrow">USGS measurement location · station ${esc(g.id)}</p><h2>${esc(g.name)}</h2>
    <div class="badges"><span class="kind-badge measured">Measured at the station</span>${gaugeFlowColor(g)==='red'?'<span class="status red">Red at station · 0 cfs</span>':''}</div>
    <p>A reading describes this station. It does not by itself establish conditions, access, or water quality at any swimming place.</p>
    <div class="reading">${stationReadings(g)}</div>
    ${historySection('usgs',g.id,g.name)}
    ${flowCues?`<div class="fact inferred"><h3>Place-specific flow cues</h3><ul>${flowCues}</ul><p class="evidence">Only places with documented rules receive a color; the gauge itself has no swim rating.</p></div>`:'<p class="muted">No linked swimming place has a documented flow rule for this gauge.</p>'}
    <p><b>Relationship note:</b> ${esc(g.link_status)}</p>
    <p><b>Places that cite this station:</b></p>${linked.length?linked.map(p=>`<p><button class="btn" data-place="${esc(p.id)}" type="button">${esc(p.name)}</button>${p._cls?`<br><small class="muted">${esc(CLASS_LABEL[p._cls]||p._cls)} · confidence ${esc(p._conf)}</small>`:''}</p>`).join(''):'<p class="muted">none in the current inventory</p>'}<p class="muted">A shared station never gives its places one shared rating.</p>
    <p class="sources"><a href="${esc(g.source)}" target="_blank" rel="noreferrer">USGS station page ↗</a>${waterMapLink(g.id)?'<br>'+waterMapLink(g.id):''}</p>`;
  detailBody.querySelectorAll('button[data-place]').forEach(b=>b.onclick=()=>{const p=places.find(x=>x.id===b.dataset.place); flyTo(p); selectPlace(p);});
  mountHistory('usgs',g.id,currentHistoryReadings('usgs',g.id));
  openSheet();
}
function selectCityGauge(g){
  selectedId='city-'+g.id;render();
  const linked=g.id==='122'?places.filter(p=>['blunn-big-stacey','blunn-little-stacey'].includes(p.id)):[];
  detailBody.innerHTML=`<p class="eyebrow">City of Austin Hydromet · station ${esc(g.id)}</p><h2>${esc(g.name)}</h2>
    <div class="badges"><span class="kind-badge measured">Measured at the station</span>${!cityHydrometMeta.failed&&cityHydrometCurrent(g)&&g.flow_cfs===0?'<span class="status red">0 cfs at station</span>':''}</div>
    <div class="reading">${cityMeasurement(g)}</div>
    ${g.id==='122'?historySection('city','122',g.name):'<div class="fact hydro"><h3>Flow history</h3><p class="muted">No place-linked discharge history is configured for this City station.</p></div>'}
    ${linked.length?`<p><b>Mapped places upstream:</b></p>${linked.map(p=>`<p><button class="btn" data-place="${esc(p.id)}" type="button">${esc(p.name)}</button></p>`).join('')}`:''}
    <p class="sources"><a href="${esc(g.source)}" target="_blank" rel="noreferrer">Official City Hydromet history ↗</a></p>`;
  detailBody.querySelectorAll('button[data-place]').forEach(button=>button.onclick=()=>{const p=places.find(item=>item.id===button.dataset.place);flyTo(p);selectPlace(p);});
  if(g.id==='122')mountHistory('city','122',currentHistoryReadings('city','122'));
  openSheet();
}
function showGroup(group){
  const pie=groupPie(group);
  detailBody.innerHTML=`<p class="eyebrow">${esc(pie.what)} nearby · individual ratings</p><h2>${group.length} places</h2><p>${esc(pie.summary)}. Pick a place for its evidence.</p>`
    +group.map(p=>{const a=effective(p);return `<p><button class="btn" data-group-id="${esc(p.id)}" type="button">${symbolFor(p)} ${esc(p.name)}</button> ${hasRating(a.status)?`<span class="tag ${a.status}">${a.status}</span>`:'<span class="muted">no current rating</span>'}<br><small class="muted">${esc(shortTag(p))}</small></p>`;}).join('');
  detailBody.querySelectorAll('button[data-group-id]').forEach(b=>b.onclick=()=>{const p=group.find(x=>x.id===b.dataset.groupId); flyTo(p); selectPlace(p);});
  openSheet();
}
function flyTo(p){ if(!hasLeaflet) return; map.flyTo([p.lat,p.lon],Math.max(map.getZoom(),15),{duration:.6}); }

/* ---------- destination rim (Study A) ----------
   Saved places outside Austin are grouped by region. When a group's centroid is off screen, a chip sits on the
   map frame edge at the true compass bearing from the current map center, with straight-line miles from
   downtown Austin written on it. Distance is written, never drawn, so nothing is out of scale. */
function haversineMi(a,b){ const R=3958.8,p=Math.PI/180; const x=Math.sin((b[0]-a[0])*p/2)**2+Math.cos(a[0]*p)*Math.cos(b[0]*p)*Math.sin((b[1]-a[1])*p/2)**2; return 2*R*Math.asin(Math.sqrt(x)); }
function bearingDeg(a,b){ const p=Math.PI/180; const y=Math.sin((b[1]-a[1])*p)*Math.cos(b[0]*p), x=Math.cos(a[0]*p)*Math.sin(b[0]*p)-Math.sin(a[0]*p)*Math.cos(b[0]*p)*Math.cos((b[1]-a[1])*p); return (Math.atan2(y,x)*180/Math.PI+360)%360; }
function shortRegion(r){ return String(r).replace('New Braunfels / Comal','New Braunfels').replace('New Braunfels / Guadalupe','New Braunfels').replace('Concan / Frio','Concan · Frio').replace('North / Georgetown','Georgetown'); }
function buildGroups(){
  const by={}; places.filter(p=>!isAustin(p)&&visiblePlace(p)).forEach(p=>{ const k=shortRegion(p.region); (by[k]=by[k]||[]).push(p); });
  groupsBeyond=Object.entries(by).map(([region,ps])=>{ const lat=ps.reduce((a,p)=>a+p.lat,0)/ps.length, lon=ps.reduce((a,p)=>a+p.lon,0)/ps.length;
    return {region,places:ps,lat,lon,mi:Math.round(Math.min(...ps.map(p=>haversineMi(DOWNTOWN,[p.lat,p.lon])))),statuses:[...new Set(ps.map(p=>effective(p).status).filter(hasRating))]}; }).sort((a,b)=>a.mi-b.mi);
}
function chipHtml(g,bearing,extra=''){
  const dots=g.statuses.map(c=>`<span class="dot ${esc(c)}"></span>`).join('');
  return `<button type="button" class="chip ${extra}" data-region="${esc(g.region)}" title="${esc(g.places.map(p=>p.name).join(' · '))}"><span class="arrow" style="transform:rotate(${Math.round(bearing)}deg)"></span>${dots}${esc(g.region)}${g.places.length>1?` · ${g.places.length}`:''}<span class="mi">${g.mi} mi</span></button>`;
}
function rimGeometry(rim){ const W=rim.clientWidth||900,H=rim.clientHeight||600; const ix=Math.round(W*0.06), top=Math.round(H*0.09), ib=Math.round(H*0.06);
  const w=W-2*ix, h=H-top-ib; return {W,H,ix,top,ib,w,h,P:2*(w+h)}; }
function posAt(d,G){ // point on the frame perimeter d px clockwise from top-center; edge says which way the chip extends
  d=((d%G.P)+G.P)%G.P; const {ix,top,ib,w,h,W,H}=G;
  if(d<w/2) return {x:ix+w/2+d,y:top,edge:'h',side:'top'}; d-=w/2;
  if(d<h) return {x:W-ix,y:top+d,edge:'v',side:'right'}; d-=h;
  if(d<w) return {x:W-ix-d,y:H-ib,edge:'h',side:'bottom'}; d-=w;
  if(d<h) return {x:ix,y:H-ib-d,edge:'v',side:'left'}; d-=h;
  return {x:ix+d,y:top,edge:'h',side:'top'}; }
const SIDE_ANCHOR={top:'translate(-50%,0)',right:'translate(-100%,-50%)',bottom:'translate(-50%,-100%)',left:'translate(0,-50%)'};
function chipExtent(item,edge){ return edge==='h'?item.label.length*7.2+52:34; }
function inRimZone(x,y,G){ return (x<240&&y<125)||(x>G.W-380&&y>G.H-75)||(x<330&&y>G.H-30); } // zoom control, legend, attribution
function renderRim(){
  const rim=$('#rim'), strip=$('#beyond-row'); if(!rim||!hasLeaflet) return;
  const c=map.getCenter(), b=map.getBounds(), center=[c.lat,c.lng], G=rimGeometry(rim);
  const items=[];
  groupsBeyond.forEach(g=>{ if(b.contains([g.lat,g.lon])) return; items.push({g,bearing:bearingDeg(center,[g.lat,g.lon]),home:false,label:`${g.region}${g.places.length>1?' · '+g.places.length:''} ${g.mi} mi`}); });
  if(!b.contains(DOWNTOWN)) items.push({g:{region:'Back to Austin',places:[],mi:Math.round(haversineMi(center,DOWNTOWN)),statuses:[]},bearing:bearingDeg(center,DOWNTOWN),home:true,label:'Back to Austin 000 mi'});
  items.forEach(i=>i.d=i.bearing/360*G.P);
  for(let it=0;it<60&&items.length>1;it++){ let moved=false; items.sort((a,q)=>a.d-q.d);
    for(let i=0;i<items.length;i++){ const a=items[i],q=items[(i+1)%items.length]; const gap=((q.d-a.d)%G.P+G.P)%G.P;
      const need=(chipExtent(a,posAt(a.d,G).edge)+chipExtent(q,posAt(q.d,G).edge))/2+10;
      if(gap<need){ const push=(need-gap)/2; a.d-=push; q.d+=push; moved=true; } }
    if(!moved) break; }
  const rectFor=(pt,i)=>{ const w=i.label.length*7.2+52,h=34; const x=pt.side==='left'?pt.x:pt.side==='right'?pt.x-w:pt.x-w/2; const y=pt.side==='top'?pt.y:pt.side==='bottom'?pt.y-h:pt.y-h/2; return {x,y,w,h}; };
  items.forEach(i=>{ i.pt=posAt(i.d,G); for(let k=0;k<20&&inRimZone(i.pt.x,i.pt.y,G);k++){ i.d+=24; i.pt=posAt(i.d,G); } });
  for(let it=0;it<30;it++){ let moved=false; // corner pass: chips on adjoining edges can still overlap in 2D
    for(let a=0;a<items.length;a++) for(let q=0;q<items.length;q++){ if(a===q) continue; const A=rectFor(items[a].pt,items[a]),Q=rectFor(items[q].pt,items[q]);
      const ox=Math.min(A.x+A.w,Q.x+Q.w)-Math.max(A.x,Q.x), oy=Math.min(A.y+A.h,Q.y+Q.h)-Math.max(A.y,Q.y);
      if(ox>0&&oy>0&&!items[q].home){ items[q].d+=Math.min(ox,oy)+8; items[q].pt=posAt(items[q].d,G); for(let k=0;k<20&&inRimZone(items[q].pt.x,items[q].pt.y,G);k++){ items[q].d+=24; items[q].pt=posAt(items[q].d,G); } moved=true; } }
    if(!moved) break; }
  rim.innerHTML=items.map(i=>{ const pt=i.pt;
    return chipHtml(i.g,i.bearing,i.home?'home':'').replace('class="chip',`style="left:${pt.x.toFixed(0)}px;top:${pt.y.toFixed(0)}px;transform:${SIDE_ANCHOR[pt.side]}" class="chip`); }).join('');
  rim.querySelectorAll('.chip').forEach(bn=>bn.onclick=()=>flyToRegion(bn.dataset.region));
  if(strip){ strip.innerHTML=groupsBeyond.map(g=>chipHtml(g,bearingDeg(DOWNTOWN,[g.lat,g.lon]))).join(''); strip.querySelectorAll('.chip').forEach(bn=>bn.onclick=()=>flyToRegion(bn.dataset.region)); }
}
function flyToRegion(region){
  if(region==='Back to Austin'){ $('#austin').click(); return; }
  const g=groupsBeyond.find(x=>x.region===region); if(!g) return;
  setPressed('all'); map.flyTo([g.lat,g.lon],g.places.length>1?13:14,{duration:.9}); render();
  detailBody.innerHTML=`<p class="eyebrow">Regional destinations · ${esc(g.region)} · ${g.mi} mi from downtown Austin, straight line</p><h2>${esc(g.region)}</h2><p class="muted">USGS readings at linked stations, NWS notices, and a local forecast refresh while the map is open. A swimming condition needs a documented place rule; check the operator page for current access.</p>`
    +g.places.map(p=>`<p><button class="btn" data-group-id="${esc(p.id)}" type="button">${symbolFor(p)} ${esc(p.name)} · ${esc(shortTag(p))}</button></p>`).join('');
  detailBody.querySelectorAll('button[data-group-id]').forEach(bn=>bn.onclick=()=>{const p=places.find(x=>x.id===bn.dataset.groupId); flyTo(p); selectPlace(p);});
  openSheet();
}

/* ---------- lists ---------- */
function renderList(){
  const austin=places.filter(isAustin), regional=places.filter(p=>!isAustin(p));
  const areas=['Barton Creek Greenbelt','Bull Creek','Other Austin creeks','Lake Austin parks','City pools (individually checked)','Creek and gauge context (not swimming places)'];
  const row=p=>{const a=effective(p);
    return `<div class="place-row"><button data-id="${esc(p.id)}" type="button" aria-label="${esc(p.name)}, ${a.status==='gray'?'no current rating':esc(shortTag(p))}"><span class="sym ${shapeClass(p)} ${displayStatus(a.status)}${a.hypothetical&&!a.hazard_override?' hypothetical':''}${unverified(p)?' unverified':''}" aria-hidden="true">${symbolFor(p)}</span><span>${esc(p.name)}${p.map_display==='list_only'?' <small class="muted">(not drawn)</small>':''}</span></button>${hasRating(a.status)?`<span class="tag ${esc(a.status)}">${esc(shortTag(p))}</span>`:''}</div>`;};
  list.innerHTML=areas.map(area=>{const items=austin.filter(p=>areaOf(p)===area); return items.length?`<h3>${esc(area)} <small>${items.length}</small></h3>`+items.map(row).join(''):'';}).join('')
    +`<details><summary>Regional places (${regional.length}) · live source checks</summary>${regional.map(row).join('')}</details>`;
  list.querySelectorAll('button[data-id]').forEach(b=>b.onclick=()=>{const p=places.find(x=>x.id===b.dataset.id);
    if(hasLeaflet&&p.map_display!=='list_only'){ if(!isAustin(p)) setPressed('all'); flyTo(p); }
    selectPlace(p); if(window.innerWidth>780) detailPanel.scrollIntoView({behavior:'smooth',block:'nearest'});});
}
function renderFreshness(){
  const obs=Object.values(readings).flatMap(rs=>rs).map(r=>Date.parse(r.observed_at)).filter(Number.isFinite);
  const newest=obs.length?new Date(Math.max(...obs)).toISOString():null;
  const currentDischarge=gauges.filter(g=>{const q=(readings['USGS-'+g.id]||[]).find(r=>r.parameter==='00060');if(!q)return false;const age=NOW()-Date.parse(q.observed_at);return Number.isFinite(age)&&age>=-300000&&age<FLOW_READING_MAX_AGE_MS;}).length;
  const anyExpired=places.some(p=>effective(p).expired);
  const cityAt=operatorMeta.closure_list_retrieved_at||operatorMeta.generated_at;
  freshness.classList.toggle('expired',anyExpired);
  const flowAt=flowMeta.live_flow_checked_at||flowMeta.generated_at;
  freshness.innerHTML=`<span class="pill">${flowMeta.live_flow_checked_at?'Creek flow checked':'Snapshot generated'} <b>${fmt(flowAt)}</b>${flowAt?` <span class="muted">(${ago(flowAt)})</span>`:''}</span>`
    +`<span class="pill">Current discharge <b>${currentDischarge}/${gauges.length} gauges</b> · newest ${newest?fmt(newest):'none'}</span>`
    +`<span class="pill">City Hydromet <b>${cityHydrometMeta.failed?'check failed':cityHydrometMeta.checked_at?fmt(cityHydrometMeta.checked_at):'checking'}</b> · ${cityHydrometMeta.failed?0:cityGauges.filter(g=>cityHydrometCurrent(g)).length}/${cityGauges.length} current creek stations · ${cityGauges.filter(g=>g.flow_cfs!==null).length} report flow</span>`
    +`<span class="pill">City pages checked <b>${fmt(cityAt)}</b>${cityAt?` <span class="muted">(${ago(cityAt)})</span>`:''}</span>`
    +(flowMeta.live_flow_failures?.length?`<span class="warn">USGS source check failed for ${flowMeta.live_flow_failures.length} gauges. Any earlier fetched reading is shown with its observation time; place ratings are withheld. The map will retry.</span>`:'')
    +(operatorMeta.failures?.length?`<span class="warn">Some City pages could not be checked (${esc(operatorMeta.failures.join(', '))}); affected ratings are withheld. The map will retry.</span>`:'')
    +(anyExpired?`<span class="warn">Some ratings have expired and are hidden. Official creek and City checks retry automatically while this page is open.</span>`:'');
}
function renderPools(data){
  if(!data?.generated_at||data.pools.length<30){poolList.textContent='City pool index could not be checked. The map will retry.';$('#pool-count').textContent='(current index unavailable)';return;}
  const stale=NOW()-Date.parse(data.generated_at)>48*3600000;
  $('#pool-count').textContent=`(${data.pools.length} pools · checked ${fmt(data.generated_at)}${stale?' · needs refresh':''})`;
  poolList.innerHTML=data.pools.map(p=>`<div class="pool-row"><span><b>${esc(p.name)}</b><small>${esc(p.address)}</small></span><span class="operator ${stale?'stale':esc(p.operator_status.replaceAll(' ','-'))}">${stale?'index needs refresh':esc('generally '+p.operator_status)}</span></div>`).join('');
}

/* ---------- controls ---------- */
function setPressed(id){ ['austin','barton','san-marcos','all'].forEach(x=>$('#'+x).setAttribute('aria-pressed',String(x===id))); }
for(const key of ['holes','pools','context','gauges','cityGauges']){ const input=$('#show-'+key); input.checked=layerChoice[key]; input.addEventListener('change',()=>{layerChoice[key]=input.checked; saveLayerChoice(); buildGroups(); render(); renderRim();}); }
document.querySelectorAll('input[name="open-view"]').forEach(input=>{
  input.checked=input.value===cityHoursView;
  input.addEventListener('change',()=>{if(!input.checked)return;cityHoursView=input.value;
    try{localStorage.setItem('austin-swim-map-city-hours',cityHoursView);}catch(e){}
    refreshCurrentView();});
});
$('#austin').onclick=()=>{setPressed('austin');if(hasLeaflet){map.fitBounds(AUSTIN_BOUNDS,{padding:[10,10]});render();}};
$('#barton').onclick=()=>{setPressed('barton');if(hasLeaflet){map.fitBounds(BARTON_BOUNDS,{padding:[10,10]});render();}};
$('#san-marcos').onclick=()=>{const ps=['san-marcos-sewell','san-marcos-city','san-marcos-rio-vista'].map(id=>places.find(x=>x.id===id)).filter(Boolean);if(!ps.length)return;setPressed('san-marcos');if(hasLeaflet){map.flyTo([29.8835,-97.9345],15,{duration:.6});render();}
  if(hasLeaflet&&matchMedia('(max-width:780px)').matches){closeSheet();document.querySelector('.map-wrap').scrollIntoView({behavior:'smooth',block:'start'});}
  else showGroup(ps);};
$('#all').onclick=()=>{setPressed('all');if(hasLeaflet){map.fitBounds(ALL_BOUNDS,{padding:[24,24]});render();}};
setPressed('austin');
if(hasLeaflet){ map.on('zoomend',()=>{render();renderRim();}); map.on('moveend',()=>{ if(map.getZoom()<15) render(); renderRim(); }); window.addEventListener('resize',renderRim); }

/* ---------- load ---------- */
async function getJson(path){ const r=await fetch(path); if(!r.ok) throw Error(`${path}: HTTP ${r.status}`); return r.json(); }
async function getVisits(){ return []; }
async function optionalJson(path,fallback,message){ try{ return await getJson(path); }catch(e){ note(message); return fallback; } }
function refreshCurrentView(){
  if(!places.length) return;
  buildGroups(); renderFreshness(); renderList(); renderStations();renderCityStations();
  const selectedPlace=places.find(p=>p.id===selectedId), selectedGauge=gauges.find(g=>g.id===selectedId),selectedCityGauge=cityGauges.find(g=>'city-'+g.id===selectedId);
  const detailScroll=detailPanel.scrollTop;
  if(detailPanel.classList.contains('open')&&selectedPlace) selectPlace(selectedPlace,false);
  else if(detailPanel.classList.contains('open')&&selectedGauge) selectGauge(selectedGauge);
  else if(detailPanel.classList.contains('open')&&selectedCityGauge) selectCityGauge(selectedCityGauge);
  else render();
  detailPanel.scrollTop=detailScroll;
  renderRim();
  lastStatusSignature=currentStatusSignature();
}
const FLOW_REFRESH_MS=15*60000, CITY_REFRESH_MS=60*60000, HAZARD_REFRESH_MS=30*60000, OUTDOOR_REFRESH_MS=30*60000;
let lastFlowCheck=0,lastCityCheck=0,lastHydrometCheck=0,lastHazardCheck=0,lastOutdoorCheck=0,cityRetryAfter=0,flowBusy=false,cityBusy=false,hydrometBusy=false,hazardBusy=false,outdoorBusy=false,outdoorAgain=false,lastStatusSignature='',lastWakeRefresh=0,lastWakeVersionCheck=0;
async function checkAppVersion(){
  try{
    const response=await fetch(`app-version.json?check=${Date.now()}`,{cache:'no-store'});
    if(!response.ok) return;
    const latest=(await response.json()).version;
    if(!latest||latest===APP_VERSION) return;
    const url=new URL(location.href);
    if(url.searchParams.get('map_version')===latest) return;
    try{sessionStorage.setItem('austin-swim-map-upgrade-view',JSON.stringify({selectedId,
      center:hasLeaflet&&map?[map.getCenter().lat,map.getCenter().lng]:null,zoom:hasLeaflet&&map?map.getZoom():null}));}catch(e){}
    url.searchParams.set('map_version',latest);
    location.replace(url.toString());
  }catch(e){/* An unavailable version file must not interrupt live source checks. */}
}
function restoreAfterUpgrade(){
  try{
    const saved=JSON.parse(sessionStorage.getItem('austin-swim-map-upgrade-view')||'null');
    sessionStorage.removeItem('austin-swim-map-upgrade-view');
    if(!saved) return;
    if(hasLeaflet&&Array.isArray(saved.center)&&saved.center.length===2&&Number.isFinite(saved.zoom))
      map.setView(saved.center,saved.zoom,{animate:false});
    const place=places.find(p=>p.id===saved.selectedId),gauge=gauges.find(g=>g.id===saved.selectedId),cityGauge=cityGauges.find(g=>'city-'+g.id===saved.selectedId);
    if(place) selectPlace(place); else if(gauge) selectGauge(gauge); else if(cityGauge) selectCityGauge(cityGauge);
  }catch(e){}
}
function currentStatusSignature(){return places.map(p=>{const a=effective(p);return `${p.id}:${a.status}:${a.expired?'expired':''}`;}).join('|')
  +'|'+gauges.map(g=>`${g.id}:${gaugeFlowColor(g)||'unrated'}`).join('|');}
function refreshIfExpired(){if(!places.length)return;
  if(currentStatusSignature()!==lastStatusSignature)refreshCurrentView();else renderFreshness();
  if(places.some(p=>hasRating(effective(p).last_status||p.today_status||p.status)&&(p.category==='managed_pool'||p.category==='lake_park')&&effective(p).expired)) refreshLiveCity();
  if(places.some(p=>BLUNN_PLACES.includes(p.id)&&effective(p).expired)&&NOW()-lastHydrometCheck>=5*60000)refreshLiveHydromet();
}
function applyLiveFlow(flow){
  const ids=new Set(flow.live_flow_place_ids||[]),by=Object.fromEntries((flow.places||[]).filter(p=>ids.has(p.id)).map(p=>[p.id,p]));
  flowMeta=flow;readings={...readings,...(window.publicLiveReadings||{})};
  places=places.map(p=>by[p.id]?{...p,...by[p.id]}:p);
}
async function refreshLiveHydromet(force=false){
  if(hydrometBusy||(!force&&document.hidden)||!places.length)return;
  hydrometBusy=true;
  try{const data=await cityHydrometStatus();cityGauges=data.stations;cityHydrometMeta={checked_at:data.checked_at,source_url:data.source_url,failed:false};
    const station=cityGauges.find(g=>g.id==='122');
    let history=null;
    if(station&&!cityHydrometCurrent(station)){
      try{history=parseBlunnHistory(await acquireBlunnHistory());}catch(e){cityHydrometMeta.history_failed=true;}
    }
    const assessment=assessBlunnFlow(station,NOW(),history);
    places=places.map(p=>BLUNN_PLACES.includes(p.id)?{...p,...assessment}:p);
  }
  catch(e){cityHydrometMeta={...cityHydrometMeta,failed:true};
    places=places.map(p=>BLUNN_PLACES.includes(p.id)?{...p,status:'gray',reason:'City Hydromet source check failed; no current Blunn flow cue',
      evidence:'Source check failed',observed_at:null,valid_until:null,rule_source:null}:p);
  }
  finally{hydrometBusy=false;lastHydrometCheck=NOW();refreshCurrentView();}
}
async function refreshLiveFlow(force=false){
  if(flowBusy||(!force&&document.hidden)||!places.length) return;
  flowBusy=true;
  try{
    applyLiveFlow(await publicFlowStatus(gauges.map(g=>g.id)));
    lastFlowCheck=Date.parse(flowMeta.live_flow_checked_at)||NOW();refreshCurrentView();
  }catch(e){lastFlowCheck=NOW();flowMeta.live_flow_checked_at=new Date(lastFlowCheck).toISOString();flowMeta.live_flow_failures=['source check'];renderFreshness();}
  finally{flowBusy=false;}
}
async function refreshLiveCity(force=false){
  if(cityBusy||(!force&&document.hidden)||!places.length||NOW()<cityRetryAfter) return;
  cityBusy=true;
  try{
    const city=await publicCityStatus(),by=Object.fromEntries(city.places.map(p=>[p.id,p]));
    operatorMeta=city;noticeContext=Object.fromEntries(city.notice_context.map(c=>[c.id,c.notices]));
    places=places.map(p=>by[p.id]?{...p,...by[p.id]}:p);
    renderPools(city.pool_index);lastCityCheck=NOW();cityRetryAfter=0;refreshCurrentView();
  }catch(e){operatorMeta.failures=['source check'];cityRetryAfter=NOW()+5*60000;renderFreshness();}
  finally{cityBusy=false;}
}
async function refreshLiveHazards(force=false){
  if(hazardBusy||(!force&&document.hidden)||!places.length) return;
  hazardBusy=true;
  try{const data=await publicHazardsStatus();hazards=Object.fromEntries(data.places.map(p=>[p.id,p]));}
  catch(e){const now=NOW();hazards=Object.fromEntries(places.map(p=>[p.id,{id:p.id,hazard_notice:'unknown',
    reason:'Official NWS sources could not be checked now; the map will retry.',evidence:'Live source check unavailable',
    checked_at:new Date(now).toISOString(),valid_until:new Date(now+HAZARD_REFRESH_MS).toISOString(),source:'https://api.weather.gov/alerts/active?area=TX'}]));}
  finally{hazardBusy=false;lastHazardCheck=NOW();refreshCurrentView();refreshLiveOutdoor(true);}
}
async function refreshLiveOutdoor(force=false){
  if(outdoorBusy){if(force) outdoorAgain=true;return;}
  if((!force&&(document.hidden||hazardBusy))||!places.length) return;
  outdoorBusy=true;
  try{const data=await publicOutdoorStatus(places,hazards);outdoor=Object.fromEntries(data.places.map(p=>[p.id,p]));}
  catch(e){outdoor={};}
  finally{outdoorBusy=false;lastOutdoorCheck=NOW();refreshCurrentView();if(outdoorAgain){outdoorAgain=false;refreshLiveOutdoor(true);}}
}
function refreshOnWake(){
  const now=NOW();
  if(now-lastWakeRefresh<2000) return;
  lastWakeRefresh=now;
  if(now-lastWakeVersionCheck>=60000){lastWakeVersionCheck=now;checkAppVersion();}
  if(!places.length) return;
  refreshIfExpired();
  if(now-lastFlowCheck>=(flowMeta.live_flow_failures?.length?5*60000:FLOW_REFRESH_MS))refreshLiveFlow(true);
  if(now-lastHydrometCheck>=(cityHydrometMeta.failed?5*60000:FLOW_REFRESH_MS))refreshLiveHydromet(true);
  if(now-lastCityCheck>=CITY_REFRESH_MS)refreshLiveCity(true);
  if(now-lastHazardCheck>=HAZARD_REFRESH_MS)refreshLiveHazards(true);
  else if(now-lastOutdoorCheck>=OUTDOOR_REFRESH_MS)refreshLiveOutdoor(true);
}
function startLiveRefresh(){
  lastStatusSignature=currentStatusSignature();
  setInterval(()=>{if(!document.hidden) refreshIfExpired();},60000);
  setInterval(()=>{checkAppVersion();if(NOW()-lastFlowCheck>=(flowMeta.live_flow_failures?.length?5*60000:FLOW_REFRESH_MS))refreshLiveFlow();
    if(NOW()-lastHydrometCheck>=(cityHydrometMeta.failed?5*60000:FLOW_REFRESH_MS))refreshLiveHydromet();},5*60000);
  setInterval(refreshLiveCity,CITY_REFRESH_MS);
  setInterval(refreshLiveHazards,HAZARD_REFRESH_MS);
  setInterval(refreshLiveOutdoor,OUTDOOR_REFRESH_MS);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOnWake();});
  document.addEventListener('pointerdown',refreshOnWake,{passive:true});
  document.addEventListener('touchstart',refreshOnWake,{passive:true});
  window.addEventListener('focus',refreshOnWake);
  window.addEventListener('pageshow',refreshOnWake);
  window.addEventListener('online',refreshOnWake);
}
const gaugeInventory=getJson('data/gauges.json');
fetch('data/water-map-links.json?v=20261005-water-map-links',{cache:'no-cache'}).then(r=>r.ok?r.json():null).then(d=>{if(d){waterMap=d;if(selectedId){const g=gauges.find(x=>x.id===selectedId);if(g)selectGauge(g);}}}).catch(()=>{});
Promise.all([getJson('data/holes.json?v=20261003-place-history-v35'),gaugeInventory,gaugeInventory.then(g=>publicFlowStatus(g.map(station=>station.id))),publicCityStatus(),getVisits(),
  optionalJson('hydro-context.json',{stations:{}},'Hydrologic context unavailable.'),optionalJson('data/model/place-relationships.json?v=20261003-place-history-v35',{places:{}},'Place relationships unavailable.')])
 .then(([h,g,flow,operator,notes,ctx,rel])=>{ context=ctx; relationships=rel;
   flowMeta=flow; operatorMeta=operator;
   const assessed=Object.fromEntries([...(flow.places||[]),...(operator.places||[])].map(p=>[p.id,p]));
   noticeContext=Object.fromEntries((operator.notice_context||[]).map(c=>[c.id,c.notices]));
   places=h.map(p=>({...p,status:'gray',reason:'No current assessment in this snapshot',evidence:'Coverage gap',...(assessed[p.id]||{})}));
   gauges=g; readings={...(window.publicLiveReadings||{})}; visits=notes;
   buildGroups(); renderFreshness(); renderList(); renderStations();renderCityStations(); render(); renderRim(); loadGeometry();restoreAfterUpgrade();openFromAddress();window.addEventListener('hashchange',openFromAddress);
   renderPools(operator.pool_index);lastFlowCheck=Date.parse(flow.live_flow_checked_at)||NOW();lastCityCheck=NOW();startLiveRefresh();refreshLiveHazards(true);refreshLiveHydromet(true);
   checkAppVersion();
   if(!hasLeaflet){ $('#map').innerHTML='<p style="padding:20px">The map library did not load. The place list below still shows every place with its current badge and sources.</p>'; }
 })
 .catch(e=>{ detailBody.innerHTML=`<p class="eyebrow">Data unavailable</p><h2>Could not load the saved snapshot</h2><p>${esc(e.message)}</p>`; freshness.innerHTML='<span class="warn">Snapshot files missing.</span>'; });
