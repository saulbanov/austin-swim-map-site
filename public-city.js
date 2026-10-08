/* Live City source checks for the public map. Acquisition keeps each raw page and
   retrieval time; parsing and schedule assessment happen only after capture. */
'use strict';

const CITY_URLS={
  index:'https://www.austintexas.gov/parks/locations/pools-and-splash-pads',
  directory:'https://www.austintexas.gov/parks/locations/park-directory',
  barton:'https://www.austintexas.gov/services/visit-barton-springs-pool',
  deep:'https://www.austintexas.gov/parks/locations/deep-eddy-pool',
  big:'https://www.austintexas.gov/parks/locations/big-stacy-pool',
  little:'https://www.austintexas.gov/parks/locations/little-stacy-wading-pool',
  commons:'https://www.austintexas.gov/parks/locations/commons-ford-ranch',
  emma:'https://www.austintexas.gov/parks/emma-long-metropolitan-park',
  closures:'https://www.austintexas.gov/parks/parks-and-recreation-facilities-closures'
};
const CITY_REQUIRED={
  directory:['all parks are open for public use each day from 5 a.m. to 10 p.m. unless otherwise posted'],
  barton:['Every day (except Thursday)','5 a.m. – 10 p.m.','Closed for cleaning','9 a.m. – 7 p.m.'],
  deep:['closed every Tuesday','March 14, 2026 to October 31, 2026','8 a.m. to 8 p.m.','10 a.m. to 8 p.m.'],
  big:['August 31, 2026 - Spring 2027','9:15 am - 10:30 am','12:00 pm - 7:00 pm','11/26','12/25'],
  little:['June 13, 2026 - August 16, 2026','Closed Wednesdays','1:00 pm - 8:00 pm','1:00 pm - 7:00 pm'],
  commons:['swimming area','Lake Austin'],
  emma:['designated beach entry swimming area','open year-round from 7:00am to 10:00pm'],
  closures:['Date of closure','Description:','Updated:']
};
const CITY_POOLS=[['barton-springs','Barton Springs','barton'],['deep-eddy','Deep Eddy','deep'],
  ['big-stacy-pool','Big Stacy','big'],['little-stacy-pool','Stacy Wading','little']];
const CITY_KEYWORDS={
  'barton-springs':['Barton Springs'],'deep-eddy':['Deep Eddy'],'big-stacy-pool':['Big Stacy'],
  'little-stacy-pool':['Little Stacy','Stacy Wading'],'commons-ford':['Commons Ford'],'emma-long':['Emma Long'],
  'twin-falls':['Barton Creek Greenbelt'],'hill-of-life':['Barton Creek Greenbelt'],
  'sculpture-falls':['Barton Creek Greenbelt'],'gus-fruh':['Barton Creek Greenbelt'],
  'campbells-hole':['Barton Creek Greenbelt'],'the-flats':['Barton Creek Greenbelt'],
  'bull-creek-district':['Bull Creek'],'st-edwards':['St. Edward'],
  'blunn-big-stacey':['Blunn','Big Stacy'],'blunn-little-stacey':['Blunn','Little Stacy'],
  'shoal-creek':['Shoal Creek'],'walnut-domain':['Walnut Creek']
};

async function acquireCityPage([key,url]){
  async function attempt(request_url){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{const response=await fetch(request_url,{signal:controller.signal,cache:'no-store'});
      if(!response.ok) throw Error(`City ${key}: HTTP ${response.status}`);
      return {key,url,request_url,retrieved_at:new Date().toISOString(),html:await response.text()};
    }finally{clearTimeout(timer);}
  }
  let lastError;
  for(let attemptNumber=0;attemptNumber<3;attemptNumber++){
    // Distinct URLs avoid intermittent City edge responses without a CORS header.
    const request=attemptNumber?`${url}${url.includes('?')?'&':'?'}swim_map_check=${Date.now()}-${attemptNumber}`:url;
    try{return await attempt(request);}catch(e){lastError=e;}
  }
  throw lastError;
}
async function acquireCityPages(){
  const entries=Object.entries(CITY_URLS);
  const results=await Promise.allSettled(entries.map(acquireCityPage));
  const captures={},failures=[],failureDetails={};
  results.forEach((r,i)=>{if(r.status==='fulfilled') captures[entries[i][0]]=r.value; else {failures.push(entries[i][0]);failureDetails[entries[i][0]]=String(r.reason);}});
  // Keep the exact public responses available for inspection during this page session.
  window.publicCityCaptures=captures;
  window.publicCityFailures=failureDetails;
  return {captures,failures};
}
function cityDocument(html){return new DOMParser().parseFromString(html,'text/html');}
function cityText(doc){const copy=doc.cloneNode(true); copy.querySelectorAll('script,style,noscript').forEach(n=>n.remove());
  const walker=copy.createTreeWalker(copy.body,NodeFilter.SHOW_TEXT),parts=[];let node;
  while((node=walker.nextNode())) parts.push(node.textContent);
  return parts.join(' ').replace(/\s+/g,' ').trim();}
function parseCitySource(capture,required=[]){
  if(!capture) return {available:false,verified:false,missing:required};
  const doc=cityDocument(capture.html),text=cityText(doc);
  if(text.length<500) return {available:false,verified:false,missing:required};
  const missing=required.filter(phrase=>!text.includes(phrase));
  return {available:true,verified:missing.length===0,missing,text,doc,url:capture.url,retrieved_at:capture.retrieved_at};
}
function parseCityIndex(source){
  if(!source.available) return [];
  const rows=[...source.doc.querySelectorAll('tr')].map(tr=>[...tr.querySelectorAll('td,th')].map(c=>c.textContent.replace(/\s+/g,' ').trim()));
  return rows.filter(c=>c.length===5&&['open','closed','closed for repairs'].includes(c[0].toLowerCase()))
    .map(c=>({name:c[1].replaceAll('*','').trim(),operator_status:c[0].toLowerCase(),address:c[4],source_url:CITY_URLS.index,retrieved_at:source.retrieved_at}));
}
function dateFromCity(text){const m=/^\s*(?:[A-Z][a-z]+day,\s*)?([A-Z][a-z]+) (\d{1,2}), (\d{4})/.exec(text); if(!m) return null; const month=new Date(`${m[1]} 1, 2000`).getMonth(); if(!Number.isFinite(month)) return null; return `${m[3]}-${String(month+1).padStart(2,'0')}-${m[2].padStart(2,'0')}`;}
function parseCityClosures(text){
  const entries=[],rx=/([^:]{3,140}?) Dates? of closure: (.+?) Description: (.+?) Updated: ([A-Z][a-z]+ \d{1,2}, \d{4})/g;
  for(const m of text.matchAll(rx)){
    let title=m[1].trim();
    for(const marker of ['Park Projects','Trails','Pools and Splash Pads','Pools','Buildings','Playgrounds','Parks','Austin311.org']){const at=title.lastIndexOf(marker);if(at>=0) title=title.slice(at+marker.length).trim();}
    title=title.replace(/^(?:[A-Z][a-z]+ \d{1,2}, \d{4}\s*)+/,'').trim();
    const dates=m[2].trim(),span=/(.+?)\s+(?:through|to|-|–)\s+(.+)/.exec(dates);
    entries.push({title,dates_text:dates,start:dateFromCity(span?span[1]:dates),end:span?dateFromCity(span[2]):null,
      open_ended:/until further notice/i.test(dates),description:m[3].trim(),updated:dateFromCity(m[4])});
  }
  return entries;
}
function cityNow(at){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,day:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(parts.weekday),hour:Number(parts.hour)+Number(parts.minute)/60};
}
function noticesFor(id,entries,today){
  return entries.filter(e=>(CITY_KEYWORDS[id]||[]).some(k=>e.title.toLowerCase().includes(k.toLowerCase())))
    .map(e=>({...e,in_effect:e.start?(e.end?e.start<=today&&today<=e.end:e.open_ended?e.start<=today:null):null,url:CITY_URLS.closures}));
}
function poolSchedule(id,local){
  const {date,day,hour}=local;
  if(id==='barton-springs') return day===3&&hour>=9&&hour<19?[false,'Thursday cleaning closure, 9 a.m.–7 p.m.']:[hour>=5&&hour<22,'Published hours: 5 a.m.–10 p.m.; Thursday cleaning 9 a.m.–7 p.m.'];
  if(id==='deep-eddy'){
    if(date<'2026-03-14'||date>'2026-10-31') return [null,'No verified schedule for this date'];
    if(day===1) return [false,'Closed Tuesdays for cleaning'];
    return [hour>=8&&hour<20,'Published lap hours: 8 a.m.–8 p.m.; recreational swim starts 10 a.m.; filling can delay opening'];
  }
  if(id==='big-stacy-pool'){
    if(date<'2026-08-31'||date>'2026-12-31') return [null,'Schedule period needs rechecking'];
    if(['2026-11-26','2026-11-27','2026-12-24','2026-12-25'].includes(date)) return [false,'City lists this date as a holiday closure'];
    if(date==='2026-12-31') return [hour>=6&&hour<16,"New Year's Eve hours: 6 a.m.–4 p.m."];
    if(day<5){if([0,2].includes(day)&&hour>=9.25&&hour<10.5) return [false,'Swim ATX closure, 9:15–10:30 a.m. Monday/Wednesday'];return [hour>=6&&hour<20,'Published weekday hours: 6 a.m.–8 p.m.'];}
    return [hour>=12&&hour<19,'Published weekend hours: noon–7 p.m.'];
  }
  if(id==='little-stacy-pool'){
    if(date<'2026-06-13'||date>'2026-08-16') return [false,'2026 wading season ended August 16'];
    if(day===2) return [false,'Closed Wednesdays'];
    return [day>=5?hour>=12&&hour<19:hour>=13&&hour<20,'Published 2026 seasonal hours'];
  }
  return [null,'No encoded schedule'];
}
const CITY_COLOR_MAX_AGE_MS=2*60*60000;
function cityColorDeadline(at,...sources){
  const deadlines=[at.getTime()+CITY_COLOR_MAX_AGE_MS,...sources.map(s=>Date.parse(s?.retrieved_at)).filter(Number.isFinite).map(t=>t+CITY_COLOR_MAX_AGE_MS)];
  return new Date(Math.min(...deadlines)).toISOString();
}
function cityMidnight(date){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',timeZoneName:'shortOffset'}).formatToParts(new Date(`${date}T06:00:00Z`));
  const zone=parts.find(x=>x.type==='timeZoneName')?.value||'',match=/GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(zone);
  if(!match) return null;
  const offset=`${Number(match[1])<0?'-':'+'}${String(Math.abs(Number(match[1]))).padStart(2,'0')}:${match[2]||'00'}`;
  return new Date(`${date}T00:00:00${offset}`);
}
function nextCityMidnight(localDate){
  const next=new Date(`${localDate}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate()+1);
  return cityMidnight(next.toISOString().slice(0,10)).toISOString();
}
function todayPoolSchedule(id,local){
  let firstOpen=null,unknown=false,closedNote='No published swimming hours today';
  for(let quarter=0;quarter<96;quarter++){
    const [state,note]=poolSchedule(id,{...local,hour:quarter/4});
    if(state===true){firstOpen=note;break;}
    if(state===null) unknown=true;
    if(note) closedNote=note;
  }
  return [firstOpen?true:unknown?null:false,firstOpen||closedNote];
}
function nextCityChange(id,at,checker){const current=checker(at),minuteStart=Math.floor(at.getTime()/60000)*60000;
  for(let minutes=1;minutes<=120;minutes++){const t=new Date(minuteStart+minutes*60000);if(checker(t)!==current) return t.toISOString();}
  return new Date(at.getTime()+CITY_COLOR_MAX_AGE_MS).toISOString();}
function namedPoolClosure(id,text){
  const names={'barton-springs':'Barton Springs Pool','deep-eddy':'Deep Eddy Pool','big-stacy-pool':'Big Stacy Pool','little-stacy-pool':'Little Stacy Wading Pool'};
  const name=names[id],section=text.includes('Pools and Splash Pads')?text.split('Pools and Splash Pads')[1].split('Trails')[0]:'';
  const direct=new RegExp(name+'[^.]{0,160}(?:will be closed|closed for|swimming will be prohibited)','i').test(text);
  return section.toLowerCase().includes(name.toLowerCase())||direct;
}
function publicPoolAssessment(id,name,slug,sources,indexRows,closures,at){
  const page=sources[slug],closure=sources.closures,index=sources.index,general=indexRows.find(r=>r.name===name),local=cityNow(at),notices=noticesFor(id,closures,local.date);
  const base={id,category:'managed_pool',rule_id:`austin-city-pool-schedule-${id}`,evidence:'City operator schedule + general index + closure list · not a water or safety measurement',
    operator_status:general?.operator_status||null,source:CITY_URLS[slug],source_retrieved_at:page.retrieved_at||null,source_verified:page.verified,
    index_source:CITY_URLS.index,index_retrieved_at:index.retrieved_at||null,closure_source:CITY_URLS.closures,closure_retrieved_at:closure.retrieved_at||null,
    checked_at:at.toISOString(),notices,valid_until:cityColorDeadline(at,page,closure,index)};
  const gray=reason=>({...base,status:'gray',reason});
  if(!page.available||!closure.available||!index.available||closures.length<3||indexRows.length<30) return gray('A required City source could not be checked now.');
  if(!general) return gray(`City pool index has no row named ${name}; the index table may have changed.`);
  if(namedPoolClosure(id,closure.text)) return gray('City closure list names this pool in a closure sentence; the notice needs review before a schedule rating.');
  if(!page.verified||!closure.verified) return gray('A City source changed; the encoded schedule cannot be verified against it.');
  const [state,note]=poolSchedule(id,local);
  const [todayState,todayNote]=todayPoolSchedule(id,local);
  const todayDeadline=[base.valid_until,nextCityMidnight(local.date)].sort()[0];
  base.valid_until=[base.valid_until,nextCityChange(id,at,t=>poolSchedule(id,cityNow(t))[0])].sort()[0];
  const todayFields={today_status:general.operator_status!=='open'||todayState===false?'red':todayState===true?'green':'gray',
    today_reason:todayState===true&&general.operator_status==='open'?`Published swim hours include a window today · ${todayNote}; City index: generally open. Confirm unplanned closures with the City.`:`${todayNote}; City index: generally ${general.operator_status}.`,
    today_valid_until:todayDeadline};
  if(general.operator_status!=='open'||state===false) return {...base,...todayFields,status:'red',reason:`${note}; City index: generally ${general.operator_status}.`};
  if(state===true) return {...base,...todayFields,status:'green',reason:`Scheduled open · ${note}; City index: generally open. Confirm unplanned closures with the City.`};
  return {...gray(`${note}; City index: generally ${general.operator_status}.`),...todayFields};
}
function clockHour(text){const m=/(\d{1,2}):(\d{2})\s?([ap]m)/i.exec(text||'');return m?Number(m[1])%12+(m[3].toLowerCase()==='pm'?12:0)+Number(m[2])/60:null;}
function publicLakeAssessment(id,slug,sources,closures,at){
  const page=sources[slug],closure=sources.closures,local=cityNow(at),notices=noticesFor(id,closures,local.date);
  const base={id,category:'lake_park',rule_id:'austin-lake-park-operator-v1',evidence:'City park page + City closure list · not a water or safety measurement',
    source:CITY_URLS[slug],source_retrieved_at:page.retrieved_at||null,source_verified:page.verified,closure_source:CITY_URLS.closures,
    closure_retrieved_at:closure.retrieved_at||null,checked_at:at.toISOString(),notices,valid_until:cityColorDeadline(at,page,closure)};
  const gray=reason=>({...base,status:'gray',reason});
  if(!page.available||!closure.available||closures.length<3) return gray('A required City park or closure page could not be checked now.');
  if(!page.verified||!closure.verified) return gray('A City page changed; the encoded park rule cannot be verified against it.');
  const prohibited=notices.filter(n=>/swimming/i.test(n.title)&&/prohibited/i.test(n.description));
  const active=prohibited.find(n=>n.in_effect===true),upcoming=prohibited.find(n=>n.start&&n.start>local.date);
  const canceled=/drawdown has been canceled as of ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(sources.emma.text||'');
  const drawdown=prohibited.find(n=>/draw(ing)? ?down/i.test(n.description));
  if(drawdown&&canceled) base.conflict=`The closure list says the swimming prohibition is tied to a drawdown, but the City's Emma Long page says that drawdown was canceled on ${canceled[1]}. The prohibition entry itself has not been withdrawn.`;
  if(active){if(base.conflict) return gray(`City closure list says swimming is prohibited ${active.dates_text}, but the City elsewhere says its stated reason was canceled. Confirm with the City before visiting.`);return {...base,status:'red',reason:`City closure list: ${active.title} — swimming prohibited ${active.dates_text}.`};}
  const upcomingNote=upcoming?` A swimming prohibition is listed for ${upcoming.dates_text}${base.conflict?', although the City says its stated reason was canceled.':'.'}`:'';
  if(!/swimming area/i.test(page.text)) return gray('City page no longer names a swimming area.'+upcomingNote);
  const hours=/open year-round from (\d{1,2}:\d{2}\s?[ap]m) to (\d{1,2}:\d{2}\s?[ap]m)/i.exec(page.text);
  let open=hours?clockHour(hours[1]):null,close=hours?clockHour(hours[2]):null,defaultNote='';
  if(open===null){if(!sources.directory.available||!sources.directory.verified) return gray('City park page has no hours and the City default-hours page could not be verified.');open=5;close=22;defaultNote=' City default hours are 5 a.m.–10 p.m. unless otherwise posted; this park page publishes none.';base.hours_source=CITY_URLS.directory;base.hours_source_retrieved_at=sources.directory.retrieved_at;base.valid_until=[base.valid_until,cityColorDeadline(at,sources.directory)].sort()[0];}
  const openNow=local.hour>=open&&local.hour<close;
  base.valid_until=[base.valid_until,nextCityChange(id,at,t=>{const h=cityNow(t).hour;return h>=open&&h<close;})].sort()[0];
  if(upcoming){const start=cityMidnight(upcoming.start);if(start&&start.toISOString()<base.valid_until) base.valid_until=start.toISOString();}
  const todayFields={today_status:'green',today_reason:`Published park hours include a window today · City names a swimming area; no swimming closure is in effect today.${defaultNote}${upcomingNote} Water conditions are not measured here.`,
    today_valid_until:[cityColorDeadline(at,page,closure,...(base.hours_source?[sources.directory]:[])),nextCityMidnight(local.date)].sort()[0]};
  if(openNow) return {...base,...todayFields,status:'green',reason:`Scheduled open · City park hours ${hours?hours[0].replace('open year-round from ',''):'5 a.m.–10 p.m.'}; City names a swimming area; no swimming closure is in effect today.${defaultNote}${upcomingNote} Water conditions are not measured here.`};
  return {...base,...todayFields,status:'red',reason:`Outside published park hours.${defaultNote}${upcomingNote}`};
}
async function publicCityStatus(){
  const {captures,failures}=await acquireCityPages(),at=new Date();
  const sources=Object.fromEntries(Object.keys(CITY_URLS).map(k=>[k,parseCitySource(captures[k],CITY_REQUIRED[k]||[])]));
  const indexRows=parseCityIndex(sources.index),closures=sources.closures.available?parseCityClosures(sources.closures.text):[];
  const places=CITY_POOLS.map(([id,name,slug])=>publicPoolAssessment(id,name,slug,sources,indexRows,closures,at));
  places.push(publicLakeAssessment('commons-ford','commons',sources,closures,at),publicLakeAssessment('emma-long','emma',sources,closures,at));
  const notice_context=Object.keys(CITY_KEYWORDS).filter(id=>!places.some(p=>p.id===id)).map(id=>({id,notices:noticesFor(id,closures,cityNow(at).date)}));
  return {generated_at:at.toISOString(),closure_list_retrieved_at:sources.closures.retrieved_at||null,places,notice_context,failures,
    pool_index:{generated_at:sources.index.retrieved_at||null,source:CITY_URLS.index,pools:indexRows}};
}
