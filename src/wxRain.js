// ── 🌧 Site rainfall — IEM Reanalysis (IEMRE) radar + gauge precipitation ─────
// Tim 8/21: rainfall source = IEMRE ("just use that, don't even worry about
// Precip"); Open-Meteo stays for forecast / sky / sunrise and as the silent
// fallback. IEMRE = Iowa State's hourly reanalysis of the lower 48; its hourly
// precipitation is NWS Stage IV (radar QPE, gauge bias-corrected, RFC-QC'd).
// Validated at the Moraine site 8/17/2026: 0.18" @ 09:00, 0.20" for the day =
// exactly the figure Forest cited for the ST13 discharge.
//
// No key, no cost, one university server, no SLA → be polite and defensive:
//  • one request per rounded location per day-file, cached in IDB (1 h for
//    today's file, 12 h for a finished day) — a crew on one site shares a grid cell
//  • today's JSON carries all 24 slots (future ones are placeholders) → clip to
//    hours that have actually started, by the device clock
//  • never block the form: the caller awaits with a catch → Open-Meteo value stays
// Owning the pipeline later (NOAA's public MRMS / Stage IV buckets + a scheduled
// job writing per-project numbers) swaps this module, nothing else.

const WX_IEMRE_BASE='https://mesonet.agron.iastate.edu/iemre/hourly/';
function _wxDateStr(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function _wxKey(date,lat,lon){ return 'wx_iemre::'+date+'::'+(+lat).toFixed(2)+','+(+lon).toFixed(2); }

async function _wxIemreDay(date,lat,lon,isToday){
  const key=_wxKey(date,lat,lon);
  const ttl=isToday?60*60000:12*60*60000;
  let cached=null;
  try{ cached=(typeof idbGet==='function')?idbGet(key):null; }catch(_){}
  if(cached&&cached.fetchedAt&&(Date.now()-cached.fetchedAt)<ttl&&Array.isArray(cached.data)&&cached.data.length) return cached.data;
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),12000);
  let j;
  try{
    const res=await fetch(WX_IEMRE_BASE+date+'/'+(+lat).toFixed(2)+'/'+(+lon).toFixed(2)+'/json',{headers:{'Accept':'application/json'},signal:ctl.signal});
    if(!res.ok) throw new Error('IEMRE HTTP '+res.status);
    j=await res.json();
  } finally { clearTimeout(timer); }
  const data=Array.isArray(j)?j:(Array.isArray(j&&j.data)?j.data:[]);
  if(!data.length) throw new Error('IEMRE empty');
  try{ if(typeof idbSet==='function') idbSet(key,{fetchedAt:Date.now(),data}); }catch(_){}
  return data;
}

// Last-24-hour site rainfall ending now: yesterday + today hourly files, clipped
// to hours whose start is within (now-24h, now]. Resolves {sum, peak, peakAt,
// hours, source}; throws when IEMRE can't answer (caller falls back).
async function wxIemreRain24(lat,lon,now){
  now=now||new Date();
  const today=_wxDateStr(now), yday=_wxDateStr(new Date(now.getTime()-86400000));
  const [a,b]=await Promise.all([_wxIemreDay(yday,lat,lon,false),_wxIemreDay(today,lat,lon,true)]);
  const cutoff=now.getTime(), from=cutoff-24*3600000;
  let sum=0,peak=0,peakAt=null,n=0;
  a.concat(b).forEach(h=>{
    const t=Date.parse(h.valid_utc||''); if(!isFinite(t)) return;
    if(t<=from||t>cutoff) return;
    const v=+h.hourly_precip_in; if(!isFinite(v)) return;
    n++; sum+=v;
    if(v>peak){ peak=v; peakAt=h.valid_utc; }
  });
  if(!n) throw new Error('IEMRE: no hours in window');
  return {sum:+sum.toFixed(2), peak:+peak.toFixed(2), peakAt, hours:n, source:'IEMRE'};
}

// Observed rain by LOCAL day for the past 7 days (today-6 … today-so-far),
// from the same hourly series the 24-h number uses, so the strip and the
// Precip field never disagree. Pulls the 8 day-files that cover the span
// (finished days cache 12 h, today 1 h), buckets each hour by the device-local
// date of its start, clips hours that haven't started. Resolves
// {days:[{d, r, partial}], total, source}; throws when IEMRE can't answer.
async function wxIemrePast7(lat,lon,now){
  now=now||new Date();
  const todayStr=_wxDateStr(now);
  const dayStr=(i)=>{ const d=new Date(now); d.setDate(d.getDate()-i); return _wxDateStr(d); };
  const files=[];
  for(let i=7;i>=0;i--){ const s=dayStr(i); files.push(_wxIemreDay(s,lat,lon,s===todayStr)); }
  const all=(await Promise.all(files)).flat();
  const cutoff=now.getTime();
  const buckets={};
  all.forEach(h=>{
    const t=Date.parse(h.valid_utc||''); if(!isFinite(t)||t>cutoff) return;
    const v=+h.hourly_precip_in; if(!isFinite(v)) return;
    const k=_wxDateStr(new Date(t));
    buckets[k]=(buckets[k]||0)+v;
  });
  if(!Object.keys(buckets).length) throw new Error('IEMRE: no hours');
  const days=[]; let total=0;
  for(let i=6;i>=0;i--){ const s=dayStr(i); const r=+(buckets[s]||0).toFixed(2); total+=r; days.push({d:s,r,partial:s===todayStr}); }
  return {days, total:+total.toFixed(2), source:'IEMRE'};
}

// ── 🇺🇸 NWS official outlook (api.weather.gov) — second Rain Outlook row ──────
// Tim 8/21: Open-Meteo's 7-day rain outlook feels off → run the official NWS
// forecast beside it for a few weeks and let the IEMRE observed strip judge
// which earns the spot. Gridpoint QPF only runs ~3.5 days out (series ends),
// chance-of-precip runs 7 — so the row carries amounts for ~3 days + chance
// for all 7, labeled as such. Two-step API: /points → forecastGridData URL
// (cached 24 h per rounded location; the grid never moves) → gridpoint JSON
// (cached 1 h). No key; browsers send their own User-Agent; CORS is open.
const WX_NWS_POINTS='https://api.weather.gov/points/';
function _wxIsoHours(dur){
  const m=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(dur||'');
  if(!m) return 0;
  return (+(m[1]||0))*24+(+(m[2]||0))+((+(m[3]||0))/60);
}
async function _wxFetchJson(url,ms){
  const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),ms||12000);
  try{
    const res=await fetch(url,{headers:{'Accept':'application/geo+json'},signal:ctl.signal});
    if(!res.ok) throw new Error('NWS HTTP '+res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}
async function wxNwsOutlook(lat,lon,now){
  now=now||new Date();
  const gkey='wx_nws_grid::'+(+lat).toFixed(2)+','+(+lon).toFixed(2);
  let grid=null;
  try{ grid=(typeof idbGet==='function')?idbGet(gkey):null; }catch(_){}
  if(!grid||!grid.url||(Date.now()-(grid.fetchedAt||0))>24*3600000){
    const pts=await _wxFetchJson(WX_NWS_POINTS+(+lat).toFixed(4)+','+(+lon).toFixed(4));
    const url=pts&&pts.properties&&pts.properties.forecastGridData;
    if(!url) throw new Error('NWS: no grid for point');
    grid={url,fetchedAt:Date.now()};
    try{ if(typeof idbSet==='function') idbSet(gkey,grid); }catch(_){}
  }
  const dkey='wx_nws_data::'+(+lat).toFixed(2)+','+(+lon).toFixed(2);
  let gp=null;
  try{ const c=(typeof idbGet==='function')?idbGet(dkey):null; if(c&&c.props&&(Date.now()-(c.fetchedAt||0))<3600000) gp=c.props; }catch(_){}
  if(!gp){
    const j=await _wxFetchJson(grid.url,15000);
    gp=j&&j.properties; if(!gp) throw new Error('NWS: empty gridpoint');
    const slim={quantitativePrecipitation:gp.quantitativePrecipitation,probabilityOfPrecipitation:gp.probabilityOfPrecipitation,snowfallAmount:gp.snowfallAmount,updateTime:gp.updateTime};
    try{ if(typeof idbSet==='function') idbSet(dkey,{fetchedAt:Date.now(),props:slim}); }catch(_){}
    gp=slim;
  }
  // Spread each valued interval over its hours, bucket by device-local date.
  const qpf={}, cov={}, pop={}, snow={};
  const spread=(series,onHour)=>{
    ((series&&series.values)||[]).forEach(v=>{
      const [startS,dur]=String(v.validTime||'').split('/');
      const start=Date.parse(startS); const hrs=Math.max(1,Math.round(_wxIsoHours(dur)));
      if(!isFinite(start)) return;
      for(let h=0;h<hrs;h++){ const t=start+h*3600000; onHour(_wxDateStr(new Date(t)),v.value,hrs); }
    });
  };
  spread(gp.quantitativePrecipitation,(d,val,hrs)=>{ cov[d]=(cov[d]||0)+1; if(typeof val==='number') qpf[d]=(qpf[d]||0)+val/hrs; });
  spread(gp.probabilityOfPrecipitation,(d,val)=>{ if(typeof val==='number') pop[d]=Math.max(pop[d]||0,val); });
  spread(gp.snowfallAmount,(d,val,hrs)=>{ if(typeof val==='number') snow[d]=(snow[d]||0)+val/hrs; });
  const todayStr=_wxDateStr(now);
  const days=[];
  for(let i=0;i<7;i++){
    const dt=new Date(now); dt.setDate(dt.getDate()+i); const d=_wxDateStr(dt);
    // An amount counts when the day is (nearly) fully covered — today only needs
    // the hours still ahead of it; a day the QPF series doesn't reach shows "—".
    const need=(d===todayStr)?Math.max(1,24-now.getHours()-2):18;
    const full=(cov[d]||0)>=need;
    days.push({d, r:full?+((qpf[d]||0)/25.4).toFixed(2):null, p:(typeof pop[d]==='number')?Math.round(pop[d]):null, s:full?+((snow[d]||0)/25.4).toFixed(1):0});
  }
  return {days, updated:gp.updateTime||'', source:'NWS'};
}

window.wxIemreRain24=wxIemreRain24;
window.wxIemrePast7=wxIemrePast7;
window.wxNwsOutlook=wxNwsOutlook;
export { wxIemreRain24, wxIemrePast7, wxNwsOutlook };
