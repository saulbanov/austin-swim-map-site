/* Posted hours for places outside the City of Austin's index: outlying-city pools, splash pads and
   water parks, and lake beaches. Their operators' pages send no CORS header, so acquisition re-reads
   each page through the site's proxy (an allowlist of exactly these pages). Assessment colors a place
   only while every verify phrase recorded when its hours were read is still on the page; otherwise it
   shows the posted hours uncolored. Sunrise, sunset and civil twilight are computed for the place.
   Pages that build their text in the browser (hours.needs_browser) cannot be re-read this way; the
   Mac's daily run renders them and publishes data/hours-checks.json, and a passing check from the
   last DAILY_CHECK_MAX_AGE_MS stands in for the live re-read. */
'use strict';
const PAGE_PROXY='https://austin-swim-map-lcra.austin-swim-map-public-site.workers.dev';
const HOURS_CONCURRENCY=4,DAILY_CHECK_MAX_AGE_MS=30*3600000;

async function acquireHoursPage(url){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{const response=await fetch(`${PAGE_PROXY}/api/page?u=${encodeURIComponent(url)}`,{signal:controller.signal,cache:'no-store'});
    if(!response.ok) throw Error(`Hours page HTTP ${response.status}`);
    return {url,retrieved_at:response.headers.get('X-Retrieved-At')||new Date().toISOString(),html:await response.text()};
  }finally{clearTimeout(timer);}
}
async function acquireHoursPages(urls){
  const captures={},queue=[...new Set(urls)];
  async function next(){while(queue.length){const url=queue.shift();try{captures[url]=await acquireHoursPage(url);}catch(e){captures[url]=null;}}}
  await Promise.all(Array.from({length:HOURS_CONCURRENCY},next));
  window.publicHoursCaptures=captures;
  return captures;
}
function parseHoursPage(capture){
  if(!capture) return {available:false};
  const text=cityText(cityDocument(capture.html));
  return {available:text.length>0,text,retrieved_at:capture.retrieved_at};
}

/* NOAA sunrise equation. zenith 90.833° for sunrise and sunset, 96° for civil twilight. */
const sentence=text=>/[.!?]$/.test(text)?text:text+'.';
const rad=d=>d*Math.PI/180,deg=r=>r*180/Math.PI,mod=(a,b)=>((a%b)+b)%b;
function solarEvent(lat,lon,date,zenith,rising){
  const noon=new Date(`${date}T12:00:00Z`),day=Math.floor((noon-Date.UTC(noon.getUTCFullYear(),0,0))/86400000),lngHour=lon/15;
  const t=day+((rising?6:18)-lngHour)/24,M=0.9856*t-3.289;
  const L=mod(M+1.916*Math.sin(rad(M))+0.020*Math.sin(rad(2*M))+282.634,360);
  let RA=mod(deg(Math.atan(0.91764*Math.tan(rad(L)))),360);
  RA=(RA+Math.floor(L/90)*90-Math.floor(RA/90)*90)/15;
  const sinDec=0.39782*Math.sin(rad(L)),cosDec=Math.cos(Math.asin(sinDec));
  const cosH=(Math.cos(rad(zenith))-sinDec*Math.sin(rad(lat)))/(cosDec*Math.cos(rad(lat)));
  if(cosH>1||cosH<-1) return null;
  const H=(rising?360-deg(Math.acos(cosH)):deg(Math.acos(cosH)))/15;
  const UT=mod(H+RA-0.06571*t-6.622-lngHour,24),base=Date.UTC(noon.getUTCFullYear(),noon.getUTCMonth(),noon.getUTCDate());
  // The UTC hour can fall on the next or previous UTC day; keep the instant whose Austin date is the requested one.
  return [0,1,-1].map(k=>new Date(base+(UT+24*k)*3600000)).find(d=>cityNow(d).date===date)||null;
}
function hourOf(token,place,date){
  const m=/^(\d{1,2}):(\d{2})$/.exec(token);
  if(m) return Number(m[1])+Number(m[2])/60;
  const event={sunrise:[90.833,true],sunset:[90.833,false],civil_twilight:[96,false]}[token];
  if(!event) return null;
  const at=solarEvent(place.lat,place.lon,date,...event);
  return at?cityNow(at).hour:null;
}
function clockText(hour){
  const h=Math.floor(hour),m=Math.round((hour-h)*60),hh=(m===60?h+1:h),mm=m===60?0:m;
  return `${hh%12||12}${mm?':'+String(mm).padStart(2,'0'):''} ${hh<12||hh===24?'a.m.':'p.m.'}`;
}
/* The posted windows for one Austin-local date: state true (windows), false (closed), null (unknown). */
function postedDay(place,date,day){
  const h=place.hours;
  if((h.closed_dates||[]).includes(date)) return {state:false,note:'The operator lists today as a closure day'};
  const period=(h.periods||[]).find(p=>(!p.from||p.from<=date)&&(!p.to||date<=p.to));
  if(!period) return h.closed_outside_periods?{state:false,note:'Closed: no posted season or period covers today'}:{state:null,note:'No posted hours cover today'};
  const weekly=period.weekly||{};
  if(!Object.keys(weekly).length) return {state:null,note:'Hours are not posted for this period'};
  const today=weekly[String(day)];
  if(today===null) return {state:null,note:'Today’s posted hours are unclear on the operator page'};
  if(!today||!today.length) return {state:false,note:'Closed today under the posted weekly hours'};
  const windows=today.map(([open,close])=>[hourOf(open,place,date),hourOf(close,place,date)]);
  if(windows.some(([o,c])=>o===null||c===null)) return {state:null,note:'Sun times could not be computed for today'};
  return {state:true,windows,note:'Posted hours today: '+windows.map(([o,c])=>`${clockText(o)}–${clockText(c)}`).join(', ')};
}
function postedNow(place,local){
  const day=postedDay(place,local.date,local.day);
  if(day.state!==true) return {...day,open:day.state};
  const open=day.windows.some(([o,c])=>local.hour>=o&&local.hour<c);
  return {...day,open};
}
function publicHoursAssessment(place,page,at){
  const h=place.hours,local=cityNow(at),posted=`Posted hours (read ${h.as_posted}): ${h.text}`;
  const base={id:place.id,category:place.place_role==='lake_beach'||place.place_role==='river_beach'?'lake_beach':'managed_pool',rule_id:'posted-hours-v1',
    evidence:`${place.operator} page, re-read through this site’s proxy · posted hours only, not a water or safety measurement`,
    hours_source:h.source_url,source_retrieved_at:page.retrieved_at||null,checked_at:at.toISOString(),
    valid_until:cityColorDeadline(at,page)};
  const midnight=nextCityMidnight(local.date);
  const both=(status,reason,extra={})=>({...base,...extra,status,reason,today_status:status,today_reason:reason,
    today_valid_until:[base.valid_until,midnight].sort()[0]});
  if(h.conflict) return both('gray',`${h.conflict} ${posted}`,{conflict:h.conflict});
  if(h.needs_browser){
    const check=page.daily_check,age=check?at-Date.parse(check.retrieved_at):Infinity;
    if(!check) return both('gray',`${posted} This operator’s pages build their text in the browser; no daily check from the Mac is available.`);
    if(!check.retrieved_at) return both('gray',`${posted} The Mac’s daily check could not render this page.`);
    if(!(age>=0&&age<DAILY_CHECK_MAX_AGE_MS)) return both('gray',`${posted} The Mac’s last daily check of this page is from ${check.retrieved_at}, too old to color the place.`);
    if(!check.verified) return both('gray',`${posted} At the Mac’s daily check (${check.retrieved_at}) the operator page no longer matched that reading.`);
    base.daily_check=true;base.source_retrieved_at=check.retrieved_at;
    base.valid_until=new Date(Date.parse(check.retrieved_at)+DAILY_CHECK_MAX_AGE_MS).toISOString();
    base.evidence=`${place.operator} page, rendered by the Mac’s daily run at ${check.retrieved_at} · posted hours only, not a water or safety measurement`;
  }else{
  if(!page.available) return both('gray',`${posted} The operator page could not be re-checked just now.`);
  if(page.text.length<1200) return both('gray',`${posted} The operator page came back as an error or an empty page just now.`);
  if(!(h.verify||[]).every(phrase=>page.text.includes(phrase))) return both('gray',`${posted} The operator page no longer matches that reading, so the hours cannot be confirmed now.`);
  }
  const now=postedNow(place,local),today=postedDay(place,local.date,local.day);
  base.valid_until=[base.valid_until,nextCityChange(place.id,at,t=>postedNow(place,cityNow(t)).open)].sort()[0];
  const todayFields={today_status:today.state===true?'green':today.state===false?'red':'gray',
    today_reason:`${today.state===true?'Open sometime today · ':''}${sentence(today.note)} ${posted}`,today_valid_until:[base.valid_until,midnight].sort()[0]};
  if(now.open===true) return {...base,...todayFields,status:'green',reason:`Open now under the posted hours · ${sentence(now.note)} ${posted}`};
  if(now.open===false) return {...base,...todayFields,status:'red',reason:`${now.state===true?'Outside today’s posted hours · ':''}${sentence(now.note)} ${posted}`};
  return {...base,...todayFields,status:'gray',reason:`${sentence(now.note)} ${posted}`};
}
async function acquireDailyChecks(){
  try{const response=await fetch(`data/hours-checks.json?check=${Date.now()}`,{cache:'no-store'});
    return response.ok?await response.json():null;}catch(e){return null;}
}
async function publicHoursStatus(places){
  const at=new Date(),targets=places.filter(p=>p.hours);
  const urls=targets.filter(p=>!p.hours.needs_browser&&!p.hours.conflict).map(p=>p.hours.source_url);
  const [captures,daily]=await Promise.all([acquireHoursPages(urls),targets.some(p=>p.hours.needs_browser)?acquireDailyChecks():null]);
  const pages=Object.fromEntries(Object.entries(captures).map(([url,capture])=>[url,parseHoursPage(capture)]));
  const pageFor=p=>p.hours.needs_browser?{daily_check:daily?.checks?.[p.id]||null}:pages[p.hours.source_url]||{available:false};
  return {generated_at:at.toISOString(),pages_checked:Object.values(pages).filter(p=>p.available).length,pages_total:Object.keys(pages).length,
    daily_checked_at:daily?.generated_at||null,places:targets.map(p=>publicHoursAssessment(p,pageFor(p),at))};
}
if(typeof module!=='undefined') module.exports={solarEvent,hourOf,postedDay,postedNow,publicHoursAssessment,clockText};
