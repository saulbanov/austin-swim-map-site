/* The "Heat / sun today" card's source: austin-heat's planning bands, read as written.
   saulbanov/austin-heat collects each place's forecast and computes every band. After each of its collections
   the swim map's Mac copies its status/outdoor-status.json, unchanged, to data/outdoor-status.json here
   (austin-swim-map tools/publish_heat_sidecar.py). This file fetches that one file and checks its age. It
   computes no heat index, band or window and fetches no forecast. An old, missing or partial file shows as
   "Current forecast unavailable". These bands describe exposure for a person, never the water or marker rating. */
'use strict';
const OUTDOOR_STATUS_URL='data/outdoor-status.json';
const OUTDOOR_MAX_AGE_MS=2*60*60*1000;
function outdoorForecastFetchedAt(doc){
  const times=(doc.input_rows||[]).filter(r=>r&&/^weather-/.test(r.lane)).map(r=>Date.parse(r.fetched_at));
  return times.length&&times.every(Number.isFinite)?Math.min(...times):null;
}
function outdoorUnavailable(place){return {id:place.id,name:place.name,valid_until:new Date(0).toISOString()};}
function readOutdoorStatus(doc,places,hazards){
  if(!doc||!Array.isArray(doc.places)) throw Error('Heat sidecar has no places');
  const fetchedAt=outdoorForecastFetchedAt(doc);
  if(fetchedAt===null) throw Error('Heat sidecar names no forecast time');
  const byId=new Map(doc.places.map(p=>[p.id,p])),staleAt=fetchedAt+OUTDOOR_MAX_AGE_MS;
  return {generated_at:doc.generated_at,places:places.map(place=>{
    const entry=byId.get(place.id);
    if(!entry) return outdoorUnavailable(place);
    const limit=Math.min(Date.parse(entry.valid_until),staleAt);
    // The card prints observed_at as when the forecast was checked. austin-heat's value is the day's first daylight
    // hour, so show the forecast's own fetch time instead, the one the file names for the bundle it was scored from.
    const out={...entry,observed_at:new Date(fetchedAt).toISOString(),valid_until:new Date(Number.isFinite(limit)?limit:0).toISOString()};
    const hazard=hazards?.[place.id];
    if(hazard?.hazard_notice==='active'){out.status='VETO';out.reason=`Official notice: ${hazard.reason}; ${entry.reason}`;}
    else if(hazard?.hazard_notice==='caution') out.reason=`Official caution: ${hazard.reason}; ${entry.reason}`;
    return out;
  })};
}
async function publicOutdoorStatus(places,hazards){
  try{
    const response=await fetch(`${OUTDOOR_STATUS_URL}?check=${Date.now()}`,{cache:'no-store'});
    if(!response.ok) throw Error(`Heat sidecar HTTP ${response.status}`);
    return readOutdoorStatus(await response.json(),places,hazards);
  }catch(e){
    console.warn('Heat sidecar unavailable:',e);
    return {generated_at:null,places:places.map(outdoorUnavailable)};
  }
}
