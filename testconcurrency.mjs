// listRoutesWithVerdict and the per-station fetches must run concurrently
// (bounded), preserve route order, and report progress to completion — so a
// multi-route load doesn't trickle in one sequential fetch at a time.
import { createAppController } from './src/lib/app.js';
import { MemoryBackend } from './src/lib/storage.js';
import { parseForecast, parseEnsemble } from './src/lib/windModel.js';
import { DOMParser } from './domshim.mjs';
const base=Math.floor(Date.now()/1000/3600)*3600;
let inflight=0, peak=0;
const DELAY=40;
const slow=(make)=>(lat,lon)=>{ inflight++; peak=Math.max(peak,inflight); return new Promise(res=>setTimeout(()=>{ inflight--; res(make()); },DELAY)); };
const detData=()=>{const t=[],ws=[],wd=[],tc=[],pr=[],pp=[];for(let i=-24;i<48;i++){t.push(base+i*3600);ws.push(12);wd.push(90);tc.push(10);pr.push(0);pp.push(0);}return parseForecast({hourly:{time:t,wind_speed_10m:ws,wind_direction_10m:wd,temperature_2m:tc,precipitation:pr,precipitation_probability:pp}});};
const ensData=()=>{const h={time:[]};for(let i=-24;i<48;i++)h.time.push(base+i*3600);for(let m=0;m<51;m++){const n=String(m+1).padStart(2,'0');h['wind_speed_10m_member'+n]=Array(72).fill(12);h['wind_direction_10m_member'+n]=Array(72).fill(90);}return parseEnsemble({hourly:h});};
const app=createAppController({backend:new MemoryBackend(),fetchForecastFor:slow(detData),fetchEnsembleFor:slow(ensData),now:()=>Date.now(),domParser:new DOMParser()});
let pass=0,fail=0; const ok=(n,c,d='')=>{c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n+'  '+d));};
for(let k=0;k<6;k++){ let p=''; for(let i=0;i<=40;i++) p+=`<trkpt lat="${(k*0.1+i*0.001).toFixed(5)}" lon="${(k*0.1+i*0.0009).toFixed(5)}"><ele>10</ele></trkpt>`;
  await app.createRoute(`<?xml version="1.0"?><gpx><trk><trkseg>${p}</trkseg></trk></gpx>`,{name:'R'+k,seedStillAirSec:1800,targetArrival:'08:30',activeDays:['MO','TU','WE','TH','FR','SA','SU']}); }
peak=0; const prog=[];
const list=await app.listRoutesWithVerdict((d)=>prog.push(d));
ok('routes returned in order', list.length===6 && list.every((v,i)=>v.route.name==='R'+i));
ok('progress monotonic to total', prog.length>0 && prog[prog.length-1]===6 && prog.every((v,i)=>i===0||v>=prog[i-1]));
ok('fetches overlapped (peak inflight > 1)', peak>1, 'peak='+peak);
ok('bounded concurrency (peak <= station-fan-out * limit)', peak<=40, 'peak='+peak);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
