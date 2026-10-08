/* Place and station history. Measurements are shared by station; place ratings are not. */
'use strict';
const historyCaptures=new Map(),historyViewByCard=new Map();
let seasonalFlowPromise=null;
/* Discharge axes start at zero; gage height is height above an arbitrary station datum, so its axis fits the readings. */
const HISTORY_MEASURES={
  '00060':{label:'Discharge',unit:'cfs',noun:'discharge',swatch:'Observed station flow',fromZero:true},
  '00065':{label:'Gage height',unit:'ft',noun:'gage height',swatch:'Observed water level above the station datum',fromZero:false}};
function historyNumber(value){return Number(value).toLocaleString('en-US',{maximumFractionDigits:2});}
function historySection(kind,id,label){
  if(!kind||!id)return `<div class="fact hydro"><h3>Station history</h3><p class="muted">No station series is linked to this point. Access and other evidence appear above.</p></div>`;
  return `<div class="fact hydro" id="history-panel" data-history-key="${esc(kind+':'+id)}">
    <h3>Station history · discharge and gage height</h3><p class="history-source">${esc(label)} · ${esc(kind==='city'?'City Hydromet':'USGS')} ${esc(id)}</p>
    <div class="history-tabs" role="group" aria-label="Station history window">
      <button type="button" data-history-view="24" aria-pressed="true">24 hours</button>
      <button type="button" data-history-view="168" aria-pressed="false">7 days</button>
      <button type="button" data-history-view="seasonal" aria-pressed="false">Typical season</button>
    </div><div class="history-result" aria-live="polite"></div>
    <p class="evidence">Station discharge and gage height are context for this place; neither chart measures swimming depth or safety.</p></div>`;
}
function historyCapture(kind,id,hours,parameter){
  // One City response carries both stage and flow; USGS needs one request per parameter.
  const key=kind==='city'?`city:${id}:${hours}`:`usgs:${id}:${hours}:${parameter}`,prior=historyCaptures.get(key);
  if(prior&&Date.now()-prior.checked<15*60000)return prior.promise;
  const promise=kind==='city'
    ?acquireBlunnHistory(hours===168?8:2).then(raw=>({rows:parseBlunnHistory(raw),
        source:'https://hydromet.lcra.org/HistoricalData/Coa',retrieved_at:new Date().toISOString()}))
    :acquirePublicGaugeHistory(id,hours,parameter).then(parsePublicGaugeHistory);
  historyCaptures.set(key,{checked:Date.now(),promise});
  promise.catch(()=>historyCaptures.delete(key));
  return promise;
}
function historySeries(kind,id,hours,parameter='00060'){
  return historyCapture(kind,id,hours,parameter).then(result=>({...result,
    series:(kind==='city'?result.rows.map(row=>[row.observed_at,parameter==='00065'?row.stage_ft:row.flow_cfs]):result.series)
      .filter(([time,value])=>{const age=Date.now()-Date.parse(time);
        return Number.isFinite(age)&&age>=-300000&&age<=hours*3600000&&Number.isFinite(value);})}));
}
function historySegments(series,hours,at=Date.now()){
  const start=at-hours*3600000;
  const sorted=series.filter(([time,value])=>Number.isFinite(Date.parse(time))&&Number.isFinite(value)&&
    Date.parse(time)>=start&&Date.parse(time)<=at+300000).sort((a,b)=>Date.parse(a[0])-Date.parse(b[0]));
  const unique=sorted.filter((row,index)=>index===0||Date.parse(row[0])!==Date.parse(sorted[index-1][0]));
  const gaps=unique.slice(1).map((row,index)=>Date.parse(row[0])-Date.parse(unique[index][0])).filter(diff=>diff>0&&diff<=2*3600000);
  const cadence=gaps.length?gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)]:15*60000;
  const gapLimit=Math.max(45*60000,3*cadence),segments=[];
  for(const row of unique){
    if(!segments.length||Date.parse(row[0])-Date.parse(segments.at(-1).at(-1)[0])>gapLimit)segments.push([]);
    segments.at(-1).push(row);
  }
  return {segments,gapCount:Math.max(0,segments.length-1),points:unique};
}
function historyDecimate(segment,start,duration){
  if(segment.length<=700)return segment;
  const bins=new Map();
  for(const row of segment){
    const bin=Math.max(0,Math.min(159,Math.floor((Date.parse(row[0])-start)/duration*160)));
    if(!bins.has(bin))bins.set(bin,[]);
    bins.get(bin).push(row);
  }
  return [...bins.values()].flatMap(rows=>{
    const min=rows.reduce((a,b)=>b[1]<a[1]?b:a),max=rows.reduce((a,b)=>b[1]>a[1]?b:a);
    return [...new Set([rows[0],min,max,rows.at(-1)])].sort((a,b)=>Date.parse(a[0])-Date.parse(b[0]));
  });
}
function historyScale(values,fromZero=true){
  let low=fromZero?Math.min(0,...values):Math.min(...values),high=Math.max(...values);
  if(!fromZero&&high-low<0.2){const middle=(high+low)/2;low=middle-0.1;high=middle+0.1;}
  return {low,high:high===low?low+1:high};
}
function historyAxes(scale,measure=HISTORY_MEASURES['00060'],x0=50,x1=310,y0=18,y1=92){
  return `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" class="history-axis"/><line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" class="history-axis"/>
    <text x="${x0-4}" y="${y0+4}" text-anchor="end" class="history-tick">${historyNumber(scale.high)}</text>
    <text x="${x0-4}" y="${y1+4}" text-anchor="end" class="history-tick">${historyNumber(scale.low)}</text>
    <text x="${x0}" y="11" class="history-unit">${measure.label} (${measure.unit})</text>`;
}
function historyCurrentLine(current,y,x0=50,x1=310){
  return current&&Number.isFinite(current.value)?`<line x1="${x0}" y1="${y(current.value).toFixed(1)}" x2="${x1}" y2="${y(current.value).toFixed(1)}" class="history-current-line"/>`:'';
}
function historyCurrentLegend(current,measure=HISTORY_MEASURES['00060']){
  return current&&Number.isFinite(current.value)?`<p class="history-legend"><span class="history-swatch current"></span>Current station reading: <b>${historyNumber(current.value)} ${measure.unit}</b> · observed ${fmt(current.observed_at)} (${ago(current.observed_at)}). Orange line is the latest instantaneous reading.</p>`
    :'<p class="evidence">No current station reading to overlay.</p>';
}
function historyChart(series,hours,at=Date.now(),current=null,parameter='00060'){
  const measure=HISTORY_MEASURES[parameter],unit=measure.unit;
  const {segments,gapCount,points}=historySegments(series,hours,at);
  if(!points.length)return `<p class="muted">No ${measure.noun} observations were returned for this window.</p>`;
  const start=at-hours*3600000,values=points.map(row=>row[1]);
  const min=Math.min(...values),max=Math.max(...values);
  const scale=historyScale(current&&Number.isFinite(current.value)?[...values,current.value]:values,measure.fromZero);
  const x=time=>50+(Date.parse(time)-start)/(hours*3600000)*260;
  const y=value=>18+(scale.high-value)/(scale.high-scale.low)*74;
  const paths=segments.map(segment=>historyDecimate(segment,start,hours*3600000)
    .map((row,index)=>`${index?'L':'M'}${x(row[0]).toFixed(1)} ${y(row[1]).toFixed(1)}`).join(' ')).join(' ');
  const last=points.at(-1),first=points[0];
  return `<svg class="history-chart" viewBox="0 0 320 112" role="img" aria-label="${hours===24?'24 hours':'7 days'} of station ${measure.noun} in ${unit}; low ${historyNumber(min)}, high ${historyNumber(max)} ${unit}; ${gapCount} reporting gaps${current?`; current reading ${historyNumber(current.value)} ${unit}`:''}">
    ${historyAxes(scale,measure)}${historyCurrentLine(current,y)}
    <path d="${paths}" class="history-line" fill="none"/><circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3" class="history-dot"/>
    <text x="50" y="106" class="history-tick">${hours===24?'24 hours ago':'7 days ago'}</text><text x="310" y="106" text-anchor="end" class="history-tick">Now</text></svg>
    <p class="history-stats"><b>${historyNumber(min)}–${historyNumber(max)} ${unit}</b> · ${points.length} readings${gapCount?` · ${gapCount} reporting gap${gapCount===1?'':'s'}`:''}</p>
    <p class="history-legend"><span class="history-swatch observed"></span>${measure.swatch}</p>${historyCurrentLegend(current,measure)}
    <p class="evidence">First shown ${fmt(first[0])} · last observed ${fmt(last[0])} (${ago(last[0])}). Lines stop at missing readings; peaks are preserved.</p>`;
}
function seasonalDayKey(date=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'2-digit',day:'2-digit'}).formatToParts(date);
  return `${parts.find(part=>part.type==='month').value}-${parts.find(part=>part.type==='day').value}`;
}
function seasonalReference(kind,id){
  seasonalFlowPromise ||= fetch('data/seasonal-flow.json?v=20261003-history-v35',{cache:'force-cache'})
    .then(response=>{if(!response.ok)throw Error('Seasonal reference unavailable');return response.json();})
    .catch(error=>{seasonalFlowPromise=null;throw error;});
  return seasonalFlowPromise.then(payload=>payload.stations?.[`${kind==='city'?'COA':'USGS'}-${id}`]||null);
}
function seasonalChart(reference,key,current){
  const rows=Object.entries(reference.days).filter(([,day])=>[day.p25,day.median,day.p75].every(Number.isFinite)).sort(([a],[b])=>a.localeCompare(b));
  if(!rows.length)return '';
  const values=rows.flatMap(([,day])=>[day.p25,day.p75]);
  const scale=historyScale(current&&Number.isFinite(current.value)?[...values,current.value]:values);
  const x=index=>50+index/Math.max(1,rows.length-1)*260;
  const y=value=>18+(scale.high-value)/(scale.high-scale.low)*74;
  const path=(items,field)=>items.map(([index,day],position)=>`${position?'L':'M'}${x(index).toFixed(1)} ${y(day[field]).toFixed(1)}`).join(' ');
  const indexed=rows.map(([,day],index)=>[index,day]);
  const band=`${path(indexed,'p75')} ${path([...indexed].reverse(),'p25').replace(/^M/,'L')} Z`;
  const today=rows.findIndex(([day])=>day===key);
  const months=['01-01','04-01','07-01','10-01'].map(day=>[day,rows.findIndex(([name])=>name>=day)]).filter(([,index])=>index>=0);
  return `<svg class="history-chart" viewBox="0 0 320 112" role="img" aria-label="Typical season: historical daily mean discharge in cfs, median line and middle-half band; current day ${esc(key)}${current?`; current instantaneous station reading ${historyNumber(current.value)} cfs`:''}">
    ${historyAxes(scale)}<path d="${band}" class="history-range-band"/><path d="${path(indexed,'median')}" class="history-median-line" fill="none"/>
    ${today>=0?`<line x1="${x(today).toFixed(1)}" y1="18" x2="${x(today).toFixed(1)}" y2="92" class="history-today-line"/>`:''}
    ${historyCurrentLine(current,y)}
    ${months.map(([day,index])=>`<text x="${x(index).toFixed(1)}" y="106" text-anchor="middle" class="history-tick">${{'01-01':'Jan','04-01':'Apr','07-01':'Jul','10-01':'Oct'}[day]}</text>`).join('')}</svg>
    <p class="history-legend"><span class="history-swatch median"></span>Historical daily-mean median <span class="history-swatch range"></span>Middle half <span class="history-swatch today"></span>Today</p>${historyCurrentLegend(current)}`;
}
function seasonalHtml(reference,key=seasonalDayKey(),current=null){
  if(!reference)return '<p class="muted">No quality-checked seasonal discharge reference is available for this station yet.</p>';
  const day=reference.days?.[key];
  if(!day)return '<p class="muted">The seasonal discharge record is incomplete for this date.</p>';
  return `<div class="history-typical">${seasonalChart(reference,key,current)}<p><b>${historyNumber(day.median)} cfs</b> historical median · middle half ${historyNumber(day.p25)}–${historyNumber(day.p75)} cfs for this date</p>
    <p class="evidence">${esc(key)} ± 7 calendar days · ${day.years} years · ${reference.first_year}–${reference.last_year}. Each year contributes one median from its complete daily readings; the figures above summarize those yearly values.</p>
    <p class="evidence">${esc(reference.method)}${reference.complete_years<20?' · limited historical span':''}. The seasonal curve summarizes historical daily means; the orange line is a separate instantaneous reading for context. Neither establishes a swimming range or reach depth. <a href="${esc(reference.source)}" target="_blank" rel="noreferrer">Official station source ↗</a></p>
    <p class="evidence">Gage height has no typical-season curve: the water level a station reads at a given flow can shift between years. At USGS 08170500, days averaging 100–110 cfs had a median gage height of 4.92 ft in 1996 and 3.62 ft in 2024.</p></div>`;
}
function historySource(kind,data){
  return `<p class="evidence">Official ${kind==='city'?'City Hydromet':'USGS'} history · checked ${fmt(data.retrieved_at)} · <a href="${esc(data.source)}" target="_blank" rel="noreferrer">source ↗</a></p>`;
}
function historyPair(kind,id,hours,current={}){
  return Promise.allSettled(['00060','00065'].map(parameter=>historySeries(kind,id,hours,parameter))).then(([flow,stage])=>{
    if(flow.status==='rejected'&&stage.status==='rejected')throw flow.reason;
    const flowHtml=flow.status==='fulfilled'
      ?historyChart(flow.value.series,hours,Date.now(),current['00060']||null,'00060')+historySource(kind,flow.value)
      :'<p class="muted">Discharge history could not be loaded.</p>';
    // Gage height appears only where the station reports it; an empty series adds nothing.
    const stageHtml=stage.status==='rejected'?'<p class="muted">Gage height history could not be loaded.</p>'
      :stage.value.series.length?historyChart(stage.value.series,hours,Date.now(),current['00065']||null,'00065')+(kind==='city'?'':historySource(kind,stage.value)):'';
    return flowHtml+stageHtml;
  });
}
function mountHistory(kind,id,current=null){
  // current: {'00060': reading, '00065': reading}; a bare reading is treated as discharge.
  const now=current&&'value' in current?{'00060':current}:current||{};
  const root=document.querySelector('#history-panel');if(!root||!kind||!id)return;
  const result=root.querySelector('.history-result'),card=selectedId||`${kind}:${id}`;
  const show=view=>{
    historyViewByCard.set(card,view);
    root.querySelectorAll('[data-history-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.historyView===view)));
    result.innerHTML='<p class="muted">Loading station history…</p>';
    const pending=view==='seasonal'?seasonalReference(kind,id).then(ref=>seasonalHtml(ref,seasonalDayKey(),now['00060']||null))
      :historyPair(kind,id,Number(view),now);
    pending.then(html=>{if(document.querySelector('#history-panel')===root&&historyViewByCard.get(card)===view)result.innerHTML=html;})
      .catch(()=>{if(document.querySelector('#history-panel')===root&&historyViewByCard.get(card)===view)
        result.innerHTML=`<p class="muted">Station history could not be loaded. <a href="${kind==='city'?'https://hydromet.lcra.org/HistoricalData/Coa':`https://waterdata.usgs.gov/monitoring-location/USGS-${esc(id)}/`}" target="_blank" rel="noreferrer">Open the official station ↗</a>.</p>`;});
  };
  root.querySelectorAll('[data-history-view]').forEach(button=>button.addEventListener('click',()=>show(button.dataset.historyView)));
  show(historyViewByCard.get(card)||'24');
}
if(typeof module!=='undefined')module.exports={historySegments,historyChart,historyPair,seasonalHtml,seasonalDayKey};
