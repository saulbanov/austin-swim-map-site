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
  closures:'https://www.austintexas.gov/parks/parks-and-recreation-facilities-closures',
  bartholomew:'https://www.austintexas.gov/parks/locations/bartholomew-pool',
  colony:'https://www.austintexas.gov/parks/locations/colony-park-district-pool',
  springwoods:'https://www.austintexas.gov/parks/locations/springwoods-pool',
  // Nine splash pads publish the same hours; this one page is re-read for all nine (see SPLASH_SHARED).
  splash:'https://www.austintexas.gov/parks/locations/bailey-splash-pad'
};
const CITY_REQUIRED={
  directory:['all parks are open for public use each day from 5 a.m. to 10 p.m. unless otherwise posted'],
  barton:['Every day (except Thursday)','5 a.m. – 10 p.m.','Closed for cleaning','9 a.m. – 7 p.m.'],
  deep:['closed every Tuesday','March 14, 2026 to October 31, 2026','8 a.m. to 8 p.m.','10 a.m. to 8 p.m.'],
  big:['August 31, 2026 - Spring 2027','9:15 am - 10:30 am','12:00 pm - 7:00 pm','11/26','12/25'],
  little:['June 13, 2026 - August 16, 2026','Closed Wednesdays','1:00 pm - 8:00 pm','1:00 pm - 7:00 pm'],
  commons:['swimming area','Lake Austin'],
  emma:['designated beach entry swimming area','open year-round from 7:00am to 10:00pm'],
  closures:['Date of closure','Description:','Updated:'],
  bartholomew:['October 1, 2026 - March 12, 2027','12:15 pm - 3:00 pm','3:00 pm - 8:00 pm','12:00 pm - 7:00 pm','November 26','Pool closes at 4:00 PM'],
  colony:['October 1, 2026 - March 12, 2027','12:15 pm - 3:00 pm','3:00 pm - 8:00 pm','12:00 pm - 7:00 pm','open 15 minutes late on Tuesday','November 26','Pool closes at 4:00 PM'],
  springwoods:['October 1, 2026 - March 12, 2027','Weekdays 3:00 pm - 8:00 pm','12:00 pm - 7:00 pm','November 26','Pool closes at 4:00 PM'],
  splash:['Daily 9:00 am - 8:00 pm','October 1, 2026 - October 31, 2026','Daily 9:00 am - 6:00 pm']
};
const SPLASH_SEASON_PHRASE='All splashpads are open May 1 to October 31, 2026';
const PEASE_PHRASE='Pease Park Splash Pad will be open on a limited schedule from 8:00 a.m. to 2:30 pm';
// Splash pads whose own City pages carried the same hours as Bailey's when read on 2026-10-08.
const SPLASH_SHARED=['bailey','bartholomew','chestnut','clarksville','eastwoods','lott','metz','ricky-guerrero','rosewood'].map(s=>`${s}-splash-pad`);
const CITY_POOLS=[['barton-springs','Barton Springs','barton'],['deep-eddy','Deep Eddy','deep'],
  ['big-stacy-pool','Big Stacy','big'],['little-stacy-pool','Stacy Wading','little'],
  ['bartholomew-pool','Bartholomew','bartholomew'],['colony-park-district-pool','Colony Park','colony'],['springwoods-pool','Springwoods','springwoods']];
const CITY_KEYWORDS={
  'barton-springs':['Barton Springs'],'deep-eddy':['Deep Eddy'],'big-stacy-pool':['Big Stacy'],
  'little-stacy-pool':['Little Stacy','Stacy Wading'],'commons-ford':['Commons Ford'],'emma-long':['Emma Long'],
  'twin-falls':['Barton Creek Greenbelt'],'hill-of-life':['Barton Creek Greenbelt'],
  'sculpture-falls':['Barton Creek Greenbelt'],'gus-fruh':['Barton Creek Greenbelt'],
  'campbells-hole':['Barton Creek Greenbelt'],'the-flats':['Barton Creek Greenbelt'],
  'bull-creek-district':['Bull Creek'],'st-edwards':['St. Edward'],
  'blunn-big-stacey':['Blunn','Big Stacy'],'blunn-little-stacey':['Blunn','Little Stacy'],
  'shoal-creek':['Shoal Creek'],'walnut-domain':['Walnut Creek'],
  'bartholomew-pool':['Bartholomew Pool'],'colony-park-district-pool':['Colony Park Pool','Colony Park District Pool'],
  'springwoods-pool':['Springwoods Pool'],'liz-carpenter-splash-pad':['Liz Carpenter'],
  'austin-secret-beach':['Roy G. Guerrero'],'austin-colorado-river-wildlife-sanctuary':['Colorado River Wildlife Sanctuary'],'pease-splash-pad':['Pease Park Splash Pad','Pease Splash']
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
  const rows=[...source.doc.querySelectorAll('tr')].map(tr=>({cells:[...tr.querySelectorAll('td,th')].map(c=>c.textContent.replace(/\s+/g,' ').trim()),
    href:tr.querySelector('a[href]')?.getAttribute('href')||''}));
  const seen=new Set();
  return rows.filter(({cells:c})=>(c.length===5||c.length===4)&&['open','closed','closed for repairs'].includes(c[0].toLowerCase()))
    .map(({cells:c,href})=>({name:c[1].replaceAll('*','').trim(),operator_status:c[0].toLowerCase(),address:c[c.length-1],
      facility_type:c.length===5?'pool':'splash_pad',slug:href.split(/[?#]/)[0].replace(/\/+$/,'').split('/').pop()||null,
      source_url:CITY_URLS.index,retrieved_at:source.retrieved_at}))
    .filter(r=>{const key=r.slug||r.name;if(seen.has(key))return false;seen.add(key);return true;});
}
function dateFromCity(text){const m=/^\s*(?:[A-Z][a-z]+day,\s*)?([A-Z][a-z]+) (\d{1,2}), (\d{4})/.exec(text); if(!m) return null; const month=new Date(`${m[1]} 1, 2000`).getMonth(); if(!Number.isFinite(month)) return null; return `${m[3]}-${String(month+1).padStart(2,'0')}-${m[2].padStart(2,'0')}`;}
function parseCityClosures(text){
  const entries=[],rx=/([^:]{3,140}?) Dates? of (?:work and )?closure: (.+?) Description: (.+?) Updated: ([A-Z][a-z]+ \d{1,2}, \d{4})/g;
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
  if(['bartholomew-pool','colony-park-district-pool','springwoods-pool'].includes(id)){
    if(date<'2026-10-01'||date>'2027-03-12') return [null,'No verified schedule for this date'];
    if(['2026-11-26','2026-12-24','2026-12-25','2027-01-01','2027-01-18','2027-02-15'].includes(date)) return [false,'City lists this date as a holiday closure'];
    const open=day>=5?12:id==='springwoods-pool'?15:id==='colony-park-district-pool'&&[1,3].includes(day)?12.5:12.25;
    const close=date==='2026-12-31'?16:day>=5?19:20;
    const notes={'bartholomew-pool':'Published Oct–Mar hours: weekdays 12:15–8 p.m. (lap swim until 3), weekends noon–7 p.m.; lap pool only, recreation pools and slides closed',
      'colony-park-district-pool':'Published Oct–Mar hours: weekdays 12:15–8 p.m. (12:30 Tuesday and Thursday; lap swim until 3), weekends noon–7 p.m.; slide closed',
      'springwoods-pool':'Published Oct–Mar hours: weekdays 3–8 p.m., weekends noon–7 p.m.'};
    return [hour>=open&&hour<close,notes[id]+(date==='2026-12-31'?"; New Year's Eve closes 4 p.m.":'')];
  }
  if(SPLASH_SHARED.includes(id)){
    if(date<'2026-05-01'||date>'2026-10-31') return [false,'City splash pad season is May 1–October 31, 2026'];
    const close=date>='2026-10-01'?18:20;
    return [hour>=9&&hour<close,`Published splash pad hours: daily 9 a.m.–${close===18?'6':'8'} p.m.${close===18?' (October)':''}`];
  }
  if(id==='pease-splash-pad'){
    if(date==='2026-10-12') return [hour>=8&&hour<11.5,'City notice: open 8–11:30 a.m. on October 12 for maintenance'];
    return [hour>=8&&hour<14.5,'City notice: limited schedule, 8 a.m.–2:30 p.m. until further notice'];
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
  const names={'barton-springs':'Barton Springs Pool','deep-eddy':'Deep Eddy Pool','big-stacy-pool':'Big Stacy Pool','little-stacy-pool':'Little Stacy Wading Pool',
    'bartholomew-pool':'Bartholomew Pool','colony-park-district-pool':'Colony Park','springwoods-pool':'Springwoods Pool'};
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
/* Every index facility without a hand-checked page: the index status, the closure list, and,
   for splash pads, the shared published hours. A facility with no encoded hours stays uncolored when open. */
function publicIndexAssessment(row,sources,closures,at){
  const id=row.slug,index=sources.index,closure=sources.closures,local=cityNow(at);
  const name=row.facility_type==='pool'&&!/pool/i.test(row.name)?`${row.name} Pool`:row.name;
  if(!CITY_KEYWORDS[id]) CITY_KEYWORDS[id]=[name];
  const notices=noticesFor(id,closures,local.date);
  const base={id,category:'managed_pool',rule_id:SPLASH_SHARED.includes(id)||id==='pease-splash-pad'?`austin-city-pool-schedule-${id}`:'austin-city-index-status-v1',
    evidence:'City pool and splash pad index + closure list · not a water or safety measurement',operator_status:row.operator_status,
    source_retrieved_at:index.retrieved_at||null,index_source:CITY_URLS.index,index_retrieved_at:index.retrieved_at||null,
    closure_source:CITY_URLS.closures,closure_retrieved_at:closure.retrieved_at||null,checked_at:at.toISOString(),notices,
    valid_until:cityColorDeadline(at,index,closure)};
  const both=(status,reason,extra={})=>({...base,...extra,status,reason,today_status:status,today_reason:reason,
    today_valid_until:[base.valid_until,nextCityMidnight(local.date)].sort()[0]});
  if(!index.available||!closure.available||closures.length<3) return both('gray','A required City source could not be checked now.');
  const closed=notices.find(n=>n.in_effect===true&&/\bclosed\b/i.test(n.description)&&!/limited schedule|will be open/i.test(n.description));
  if(closed) return both('red',`City closure list: ${closed.title} — ${closed.dates_text}. ${closed.description}`);
  if(row.operator_status!=='open') return both('red',`City pool index lists it ${row.operator_status}.`);
  let page=null,checks=[];
  if(SPLASH_SHARED.includes(id)){page=sources.splash;checks=[page.verified,index.text?.includes(SPLASH_SEASON_PHRASE)];
    base.hours_source=CITY_URLS.splash;base.hours_source_retrieved_at=page.retrieved_at||null;
    base.valid_until=[base.valid_until,cityColorDeadline(at,page)].sort()[0];}
  else if(id==='pease-splash-pad') checks=[closure.text?.includes(PEASE_PHRASE)];
  else return both('gray',`City index lists it open; its hours are not encoded here. Check its City page.`);
  if(!checks.every(Boolean)) return both('gray','A City page changed; the encoded hours cannot be verified against it.');
  const [state,note]=poolSchedule(id,local),[todayState,todayNote]=todayPoolSchedule(id,local);
  const shared=SPLASH_SHARED.includes(id)?' Hours re-read from Bailey Splash Pad’s page, which matched this pad’s page on 2026-10-08.':'';
  const todayFields={today_status:todayState===true?'green':todayState===false?'red':'gray',
    today_reason:`${todayState===true?'Published hours include a window today · ':''}${todayNote}; City index: generally open.${shared}`,
    today_valid_until:[base.valid_until,nextCityMidnight(local.date)].sort()[0]};
  base.valid_until=[base.valid_until,nextCityChange(id,at,t=>poolSchedule(id,cityNow(t))[0])].sort()[0];
  if(state===true) return {...base,...todayFields,status:'green',reason:`Scheduled open · ${note}; City index: generally open.${shared} Confirm unplanned closures with the City.`};
  if(state===false) return {...base,...todayFields,status:'red',reason:`${note}; City index: generally open.${shared}`};
  return {...base,...todayFields,status:'gray',reason:`${note}; City index: generally open.`};
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
  const checked=new Set(CITY_POOLS.map(([,name])=>name));
  places.push(...indexRows.filter(r=>r.slug&&!checked.has(r.name)).map(r=>publicIndexAssessment(r,sources,closures,at)));
  places.push(publicLakeAssessment('commons-ford','commons',sources,closures,at),publicLakeAssessment('emma-long','emma',sources,closures,at));
  const notice_context=Object.keys(CITY_KEYWORDS).filter(id=>!places.some(p=>p.id===id)).map(id=>({id,notices:noticesFor(id,closures,cityNow(at).date)}));
  return {generated_at:at.toISOString(),closure_list_retrieved_at:sources.closures.retrieved_at||null,places,notice_context,failures,
    pool_index:{generated_at:sources.index.retrieved_at||null,source:CITY_URLS.index,pools:indexRows}};
}
