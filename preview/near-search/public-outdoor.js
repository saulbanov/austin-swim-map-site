/* Browser forecast acquisition and a deterministic per-place planning band.
   These bands describe exposure for a person, never the water or marker rating. */
'use strict';
function outdoorUrls(places){
  const coords={latitude:places.map(p=>p.lat).join(','),longitude:places.map(p=>p.lon).join(','),timezone:'America/Chicago'};
  return {
    forecast:'https://api.open-meteo.com/v1/forecast?'+new URLSearchParams({...coords,hourly:'temperature_2m,relative_humidity_2m,uv_index,precipitation_probability,weather_code',daily:'sunrise,sunset',temperature_unit:'fahrenheit',forecast_days:'1'}),
    air:'https://air-quality-api.open-meteo.com/v1/air-quality?'+new URLSearchParams({...coords,hourly:'us_aqi',forecast_days:'1'})
  };
}
async function acquireOutdoorJson(url){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(url,{signal:controller.signal,cache:'no-store'});
    if(!response.ok) throw Error(`Forecast HTTP ${response.status}`);
    return {source:url,retrieved_at:new Date().toISOString(),payload:await response.json()};
  }finally{clearTimeout(timer);}
}
function outdoorProfile(place){
  if(place.place_role==='managed_pool') return {sun:'full',minutes:120,basis:'City pool; full sun assumed'};
  if((place.kind||'').includes('lake')) return {sun:'full',minutes:120,basis:'Lake shoreline; full sun assumed'};
  if(place.place_role==='creek_context'||place.kind==='creek context') return {sun:'mixed',minutes:60,basis:'Creek context walk; mixed sun assumed'};
  if(['creek pool','creek reach','spring-fed pool','spring'].includes(place.kind)) return {sun:'mixed',minutes:90,basis:'Creek or spring; mixed sun assumed'};
  if(place.kind==='river reach') return {sun:'mixed',minutes:120,basis:'River reach; mixed sun assumed'};
  return {sun:'mixed',minutes:60,basis:'Ordinary outdoor time; mixed sun assumed'};
}
function outdoorHeatIndex(temp,rh){
  const simple=.5*(temp+61+(temp-68)*1.2+rh*.094);
  if((simple+temp)/2<80) return simple;
  let hi=-42.379+2.04901523*temp+10.14333127*rh-.22475541*temp*rh-.00683783*temp*temp-.05481717*rh*rh
    +.00122874*temp*temp*rh+.00085282*temp*rh*rh-.00000199*temp*temp*rh*rh;
  if(rh<13&&temp>=80&&temp<=112) hi-=((13-rh)/4)*Math.sqrt((17-Math.abs(temp-95))/17);
  else if(rh>85&&temp>=80&&temp<=87) hi+=((rh-85)/10)*((87-temp)/5);
  return hi;
}
function outdoorHeatBand(hi){return hi<80?0:hi<90?1:hi<103?2:hi<125?3:4;}
function outdoorUvBand(uv){const n=Math.round(uv);return n<=2?0:n<=5?1:n<=7?2:n<=10?3:4;}
function outdoorColor(heat,uv){return heat>=4||uv>=4?'Red':heat>=3||uv>=3||(heat===2&&uv===2)?'Orange':heat===2||uv===2?'Yellow':'Green';}
const OUTDOOR_ORDER=['Green','Yellow','Orange','Red','VETO'];
function outdoorWorst(items){return items.length?items.reduce((a,b)=>OUTDOOR_ORDER.indexOf(a)>OUTDOOR_ORDER.indexOf(b)?a:b):'n/a';}
function outdoorBestBlock(verdicts){
  let best=[],current=[];
  for(const v of [...verdicts,null]){
    if(v&&['Green','Yellow'].includes(v.color)) current.push(v);
    else {if(current.length>best.length)best=current;current=[];}
  }
  return best.length?[`${String(best[0].hour).padStart(2,'0')}:00`,`${String(best.at(-1).hour+1).padStart(2,'0')}:00`]:null;
}
function parseOutdoorForecast(forecast,air,now=new Date()){
  const f=forecast.payload,h=f.hourly,d=f.daily;
  if(!h||!d||!Array.isArray(h.time)||!Array.isArray(d.sunrise)||!Array.isArray(d.sunset)) throw Error('Forecast shape changed');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  if(d.sunrise[0]?.slice(0,10)!==today) throw Error('No current-day forecast');
  const required=['temperature_2m','relative_humidity_2m','uv_index','precipitation_probability','weather_code'];
  if(required.some(k=>!Array.isArray(h[k])||h[k].length!==h.time.length)) throw Error('Incomplete hourly forecast');
  const aq=air?.payload?.hourly;
  const aqByTime=new Map((aq?.time||[]).map((t,i)=>[t,aq.us_aqi?.[i]]));
  const sunrise=Number(d.sunrise[0].slice(11,13)),sunset=Number(d.sunset[0].slice(11,13));
  const hours=h.time.map((time,i)=>({time,hour:Number(time.slice(11,13)),temp:Number(h.temperature_2m[i]),rh:Number(h.relative_humidity_2m[i]),uv:Number(h.uv_index[i]),rain:Number(h.precipitation_probability[i]),code:Number(h.weather_code[i]),aqi:aqByTime.get(time)}))
    .filter(x=>x.time.slice(0,10)===today&&x.hour>=sunrise&&x.hour<=sunset);
  if(hours.length<8||hours.some(x=>![x.temp,x.rh,x.uv,x.rain,x.code].every(Number.isFinite))) throw Error('Incomplete current-day daylight forecast');
  const offsetSeconds=Number(f.utc_offset_seconds);
  if(!Number.isFinite(offsetSeconds)) throw Error('Forecast time-zone offset missing');
  const sign=offsetSeconds<0?'-':'+',absolute=Math.abs(offsetSeconds);
  const offset=`${sign}${String(Math.floor(absolute/3600)).padStart(2,'0')}:${String(Math.floor(absolute%3600/60)).padStart(2,'0')}`;
  return {today,hours,airAvailable:!!aq?.time?.length,source:forecast.source,airSource:air?.source||null,retrieved_at:forecast.retrieved_at,offset};
}
function assessOutdoorPlace(place,forecast,hazards,now=new Date()){
  const profile=outdoorProfile(place),currentHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',hourCycle:'h23'}).format(now));
  const window=currentHour<10?'early':currentHour<17?'midday':'evening';
  const verdicts=forecast.hours.map(h=>{
    const hi=outdoorHeatIndex(h.temp,h.rh),baseHeat=outdoorHeatBand(hi),baseUv=outdoorUvBand(h.uv);
    const heat=Math.min(4,baseHeat+(profile.sun==='full'&&profile.minutes>30?1:0));
    const uv=Math.min(4,baseUv+(profile.sun==='full'&&profile.minutes>=45&&h.hour>=10&&h.hour<16?1:0));
    const veto=[95,96,99].includes(h.code)||(h.code>=51&&h.code<=67)||(h.code>=80&&h.code<=82)||h.rain>=60||(Number.isFinite(Number(h.aqi))&&h.aqi!==null&&Number(h.aqi)>=151);
    return {hour:h.hour,color:veto?'VETO':outdoorColor(heat,uv),heat,uv};
  });
  const by_window={early:outdoorWorst(verdicts.filter(v=>v.hour<10).map(v=>v.color)),midday:outdoorWorst(verdicts.filter(v=>v.hour>=10&&v.hour<17).map(v=>v.color)),evening:outdoorWorst(verdicts.filter(v=>v.hour>=17).map(v=>v.color))};
  const best=outdoorBestBlock(verdicts),hazard=hazards?.[place.id];
  let status=by_window[window],reason=`${window} window ${status}; best block ${best?best.join('-'):'none'}; early ${by_window.early}, midday ${by_window.midday}, evening ${by_window.evening}`;
  if(hazard?.hazard_notice==='active'){status='VETO';reason=`Official notice: ${hazard.reason}; ${reason}`;}
  else if(hazard?.hazard_notice==='caution') reason=`Official caution: ${hazard.reason}; ${reason}`;
  const end=new Date(`${forecast.today}T23:59:59${forecast.offset}`);
  return {id:place.id,name:place.name,status,status_window:window,by_window,best_block:best,reason,
    evidence:`Planning band · ${profile.basis}; shade is not observed${forecast.airAvailable?'':' · air-quality source unavailable'}`,
    observed_at:forecast.retrieved_at,valid_until:end.toISOString(),source:forecast.source};
}
async function publicOutdoorStatus(places,hazards){
  const urls=outdoorUrls(places);
  const [forecastResult,airResult]=await Promise.allSettled([acquireOutdoorJson(urls.forecast),acquireOutdoorJson(urls.air)]);
  window.publicOutdoorCaptures={forecast:forecastResult.status==='fulfilled'?forecastResult.value:{error:String(forecastResult.reason)},air:airResult.status==='fulfilled'?airResult.value:{error:String(airResult.reason)}};
  if(forecastResult.status!=='fulfilled') throw forecastResult.reason;
  const forecasts=forecastResult.value.payload,airs=airResult.status==='fulfilled'?airResult.value.payload:null;
  if(!Array.isArray(forecasts)||forecasts.length!==places.length) throw Error('Forecast place count changed');
  if(airs&&(!Array.isArray(airs)||airs.length!==places.length)) throw Error('Air forecast place count changed');
  const assessments=places.map((place,i)=>{
    const forecast={...forecastResult.value,payload:forecasts[i]};
    const air=airs?{...airResult.value,payload:airs[i]}:null;
    const parsed=parseOutdoorForecast(forecast,air);
    return assessOutdoorPlace(place,parsed,hazards);
  });
  return {generated_at:new Date().toISOString(),places:assessments};
}
