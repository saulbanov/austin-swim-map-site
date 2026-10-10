/* Address search and "Near me": find a point, then list the nearest saved places by straight-line miles.
   A typed query is matched first against the map's own place and town names, offline. While typing, it
   is also sent to Photon (photon.komoot.io, OpenStreetMap data, no key) for named places and streets.
   Pressing Search sends it once to Nominatim (nominatim.openstreetmap.org), which places house numbers
   exactly where Photon does not (2026-10-10: "1100 Barton Springs Rd" came back from Photon as a condo at
   1600); Nominatim's rules allow one request per search, never per keystroke. Both stay inside the box
   that holds every saved place. "Near me" uses the browser's own location; it is never sent anywhere.
   Distances are straight lines, not travel distance. */
const NEAR_BBOX='-100.3,29.3,-97.1,31.0'; // west,south,east,north: Junction and Concan to Granger Lake
const NEAR_BIAS={lat:30.2672,lon:-97.7431}; // downtown Austin, so nearby matches rank first
const NEAR_PHOTON='https://photon.komoot.io/api/';
const NEAR_NOMINATIM='https://nominatim.openstreetmap.org/search';

function nearNorm(s){ return String(s??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
function nearMiles(a,b){ const R=3958.8,p=Math.PI/180;
  const x=Math.sin((b.lat-a.lat)*p/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin((b.lon-a.lon)*p/2)**2;
  return 2*R*Math.asin(Math.sqrt(x)); }
/* Every query word must start a word of the place's name or town; the last word may be partial. */
function nearLocalMatches(q,places,limit=5){
  const words=nearNorm(q).split(' ').filter(Boolean); if(!words.length) return [];
  const hits=[];
  for(const p of places){
    if(!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||p.map_display==='list_only') continue;
    const own=nearNorm(p.name).split(' '), town=nearNorm(p.region).split(' ');
    const ok=words.every((w,i)=>[...own,...town].some(t=>t===w||(i===words.length-1&&t.startsWith(w))));
    if(!ok) continue;
    const inName=words.every(w=>own.some(t=>t.startsWith(w)));
    hits.push({label:p.name,sub:`${p.region} · on this map`,lat:p.lat,lon:p.lon,place_id:p.id,score:(inName?0:1)+(own[0]?.startsWith(words[0])?0:0.5)});
  }
  return hits.sort((a,b)=>a.score-b.score||a.label.localeCompare(b.label)).slice(0,limit).map(({score,...h})=>h);
}
function nearPhotonUrl(q,limit=5){
  return `${NEAR_PHOTON}?q=${encodeURIComponent(q)}&limit=${limit}&lang=en&bbox=${NEAR_BBOX}&lat=${NEAR_BIAS.lat}&lon=${NEAR_BIAS.lon}`;
}
/* Photon features to search hits. A failed or empty lookup returns [], never throws. */
async function nearPhoton(q,signal,fetcher=(typeof fetch!=='undefined'?fetch:null)){
  if(!fetcher||nearNorm(q).length<3) return [];
  try{
    const r=await fetcher(nearPhotonUrl(q),{signal}); if(!r.ok) return [];
    const j=await r.json();
    return (j.features||[]).map(f=>{const p=f.properties||{},c=f.geometry?.coordinates||[];
      const street=[p.housenumber,p.street].filter(Boolean).join(' ');
      const label=p.name||street||p.city||p.county;
      const sub=[p.name&&street?street:null,p.city||p.county,p.state,'OpenStreetMap'].filter(Boolean).join(', ');
      return {label,sub,lat:+c[1],lon:+c[0]};}).filter(h=>h.label&&Number.isFinite(h.lat)&&Number.isFinite(h.lon));
  }catch(e){ return []; }
}
function nearNominatimUrl(q,limit=3){
  const [w,s,e,n]=NEAR_BBOX.split(',');
  return `${NEAR_NOMINATIM}?q=${encodeURIComponent(q)}&format=jsonv2&limit=${limit}&countrycodes=us&viewbox=${w},${n},${e},${s}&bounded=1`;
}
/* Nominatim results to search hits; called once per pressed Search. A failed lookup returns []. */
async function nearNominatim(q,signal,fetcher=(typeof fetch!=='undefined'?fetch:null)){
  if(!fetcher||nearNorm(q).length<3) return [];
  try{
    const r=await fetcher(nearNominatimUrl(q),{signal,headers:{'Accept-Language':'en'}}); if(!r.ok) return [];
    return (await r.json()).map(x=>{const parts=String(x.display_name||'').split(', ');
      const label=/^\d/.test(parts[0])&&parts[1]?`${parts[0]} ${parts[1]}`:parts[0];
      const town=parts.find((t,i)=>i>0&&/^(Austin|Round Rock|Cedar Park|Pflugerville|Georgetown|Leander|Kyle|Buda|San Marcos|Lakeway|Bastrop|Manor|Hutto|Wimberley|New Braunfels)$/.test(t));
      return {label,sub:[town,'OpenStreetMap'].filter(Boolean).join(', '),lat:+x.lat,lon:+x.lon};})
      .filter(h=>h.label&&Number.isFinite(h.lat)&&Number.isFinite(h.lon));
  }catch(e){ return []; }
}
/* The nearest places to a point, after `keep` (the map's own visibility rule) has its say. */
function nearestPlaces(origin,places,{limit=10,keep=()=>true}={}){
  return places.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.map_display!=='list_only'&&keep(p))
    .map(p=>({place:p,mi:nearMiles(origin,{lat:p.lat,lon:p.lon})})).sort((a,b)=>a.mi-b.mi).slice(0,limit);
}
function nearMilesText(mi){ return mi<0.1?'under 0.1 mi':mi<10?`${mi.toFixed(1)} mi`:`${Math.round(mi)} mi`; }
if(typeof module!=='undefined') module.exports={NEAR_BBOX,nearNorm,nearMiles,nearLocalMatches,nearPhotonUrl,nearPhoton,nearNominatimUrl,nearNominatim,nearestPlaces,nearMilesText};
