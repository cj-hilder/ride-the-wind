import { temperatureToken, rainToken, snowToken, crosswindToken, whatToExpect, sampleConditions } from './src/lib/whatToExpect.js';
let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${d}`)); };

console.log('Temperature:');
ok('min when all mild', temperatureToken([8,6,9,7])==='6°C', temperatureToken([8,6,9,7]));
ok('max when hot (>=26)', temperatureToken([22,27,24])==='27°C', temperatureToken([22,27,24]));
ok('rounds to integer', temperatureToken([4.4,4.6])==='4°C', temperatureToken([4.4,4.6]));
ok('null when empty', temperatureToken([])===null);

console.log('\nRain (total mm over ride; intensity by mm, "maybe" by probability):');
ok('blank when prob below 10 gate', rainToken(5,[8])===null);
ok('blank when dry', rainToken(0,[90])===null);
// intensity bands (high prob → no "maybe")
ok('light rain (0.1-1)', rainToken(0.3,[80])==='light rain', rainToken(0.3,[80]));
ok('wet (1-4)', rainToken(2,[80])==='wet', rainToken(2,[80]));
ok('very wet (>=4)', rainToken(5,[80])==='very wet', rainToken(5,[80]));
ok('boundary 0.1 -> light rain', rainToken(0.1,[80])==='light rain');
ok('just under 0.1 -> blank', rainToken(0.09,[80])===null);
ok('boundary 1 -> wet', rainToken(1,[80])==='wet');
ok('boundary 4 -> very wet', rainToken(4,[80])==='very wet');
// "maybe" prefix when probability in 10-50 band
ok('mid prob → maybe light rain', rainToken(0.3,[30])==='maybe light rain', rainToken(0.3,[30]));
ok('mid prob → maybe wet', rainToken(2,[40])==='maybe wet', rainToken(2,[40]));
ok('mid prob → maybe very wet', rainToken(5,[20])==='maybe very wet');
ok('prob just over 10 gate counts (maybe)', rainToken(2,[11])==='maybe wet', rainToken(2,[11]));
ok('boundary 50 prob → definite (no maybe)', rainToken(2,[50])==='wet', rainToken(2,[50]));
ok('just under 50 → maybe', rainToken(2,[49])==='maybe wet');

console.log('\nCrosswind (time-weighted |crosswind| km/h):');
const cw=(v)=>[{v,t:600}];
ok('blank under 15', crosswindToken(cw(10))===null);
ok('crosswinds 15-30', crosswindToken(cw(20))==='crosswinds', crosswindToken(cw(20)));
ok('strong over 30', crosswindToken(cw(35))==='strong crosswinds');
ok('boundary 15 -> crosswinds', crosswindToken(cw(15))==='crosswinds');

console.log('\nCrosswind geometry (sampleConditions):');
{
  // route heading east (bearing 90); wind from north (fromDeg 0) is pure crosswind
  const segs=[{lat:0,lon:0,bearing:90}];
  const times=[600];
  const windFn=()=>({speed:25,fromDeg:0,tempC:5,precipMm:0,precipProb:0});
  const c=sampleConditions({segments:segs,times,windFn,departMs:0});
  ok('north wind on east route = full crosswind ~25', Math.abs(c.crosswinds[0].v-25)<0.01, `${c.crosswinds[0].v.toFixed(2)}`);
  // wind from east (90) on east route = headwind, zero crosswind
  const windFn2=()=>({speed:25,fromDeg:90,tempC:5,precipMm:0,precipProb:0});
  const c2=sampleConditions({segments:segs,times,windFn:windFn2,departMs:0});
  ok('head/tail wind = ~0 crosswind', Math.abs(c2.crosswinds[0].v)<0.01, `${c2.crosswinds[0].v.toFixed(2)}`);
}

console.log('\nAssembly:');
{
  const segs=[{lat:0,lon:0,bearing:90},{lat:0,lon:0.01,bearing:90}];
  const times=[600,600];
  const windFn=()=>({speed:22,fromDeg:0,tempC:3,precipMm:3,precipProb:80}); // crosswind, wet, cold
  const r=whatToExpect({segments:segs,times,windFn,departMs:0});
  ok('full line assembles', r.line==='3°C · wet · crosswinds', r.line);
  // calm dry mild -> just temp
  const windFn2=()=>({speed:5,fromDeg:90,tempC:14,precipMm:0,precipProb:0});
  const r2=whatToExpect({segments:segs,times,windFn:windFn2,departMs:0});
  ok('calm dry -> temp only', r2.line==='14°C', r2.line);
}

console.log('\nSnow token (cm/h rate; intensity, no maybe):');
ok('blank below light floor', snowToken(0.02, false)===null);
ok('light snow (0.05-0.5)', snowToken(0.2, false)==='light snow', snowToken(0.2,false));
ok('snow (>=0.5)', snowToken(0.8, false)==='snow', snowToken(0.8,false));
ok('boundary 0.05 -> light', snowToken(0.05, false)==='light snow');
ok('boundary 0.5 -> snow', snowToken(0.5, false)==='snow');
ok('snow code with trace rate -> light snow', snowToken(0, true)==='light snow');
ok('no code, no rate -> blank', snowToken(0, false)===null);

console.log('\nSnow & fog:');
{
  const segs=[{lat:0,lon:0,bearing:90},{lat:0,lon:0.01,bearing:90}];
  const times=[600,600];
  // heavy snowfall rate → "snow"
  const snowFn=()=>({speed:8,fromDeg:0,tempC:-1,precipMm:0,precipProb:0,snowfallCm:0.8,weatherCode:3});
  ok('heavy snowfall flags snow', whatToExpect({segments:segs,times,windFn:snowFn,departMs:0}).tokens.includes('snow'));
  // light snowfall rate → "light snow"
  const lightSnowFn=()=>({speed:8,fromDeg:0,tempC:-1,precipMm:0,precipProb:0,snowfallCm:0.1,weatherCode:3});
  ok('light snowfall flags light snow', whatToExpect({segments:segs,times,windFn:lightSnowFn,departMs:0}).tokens.includes('light snow'));
  // snow via weather code (73) with no snowfall figure → light snow
  const snowCodeFn=()=>({speed:8,fromDeg:0,tempC:-1,precipMm:0,precipProb:0,snowfallCm:0,weatherCode:73});
  ok('snow code (no rate) flags light snow', whatToExpect({segments:segs,times,windFn:snowCodeFn,departMs:0}).tokens.includes('light snow'));
  // fog (45) flags fog, not snow
  const fogFn=()=>({speed:3,fromDeg:0,tempC:6,precipMm:0,precipProb:0,snowfallCm:0,weatherCode:45});
  const fr=whatToExpect({segments:segs,times,windFn:fogFn,departMs:0});
  ok('fog code flags fog', fr.tokens.includes('fog'));
  ok('fog does not flag snow', !fr.tokens.some(t=>t.includes('snow')));
  // clear code -> neither
  const clearFn=()=>({speed:3,fromDeg:0,tempC:10,precipMm:0,precipProb:0,snowfallCm:0,weatherCode:1});
  const cr=whatToExpect({segments:segs,times,windFn:clearFn,departMs:0});
  ok('clear -> no snow/fog tokens', !cr.tokens.some(t=>t.includes('snow')) && !cr.tokens.includes('fog'));
  // present at ANY point: snow only on the second segment
  let n=0; const partialFn=()=>({speed:5,fromDeg:0,tempC:0,precipMm:0,precipProb:0,snowfallCm:(n++ ? 0.8 : 0),weatherCode:3});
  ok('snow on any segment flags snow', whatToExpect({segments:segs,times,windFn:partialFn,departMs:0}).tokens.includes('snow'));
  // thunderstorm (95) and with hail (99)
  const thunderFn=()=>({speed:10,fromDeg:0,tempC:18,precipMm:2,precipProb:90,snowfallCm:0,weatherCode:95});
  ok('thunderstorm code flags thunderstorms', whatToExpect({segments:segs,times,windFn:thunderFn,departMs:0}).tokens.includes('thunderstorms'));
  const hailFn=()=>({speed:10,fromDeg:0,tempC:18,precipMm:2,precipProb:90,snowfallCm:0,weatherCode:99});
  ok('thunderstorm-with-hail (99) flags thunderstorms', whatToExpect({segments:segs,times,windFn:hailFn,departMs:0}).tokens.includes('thunderstorms'));
  // freezing rain (66) and freezing drizzle (57)
  const fzRainFn=()=>({speed:6,fromDeg:0,tempC:0,precipMm:1,precipProb:80,snowfallCm:0,weatherCode:66});
  const fzr=whatToExpect({segments:segs,times,windFn:fzRainFn,departMs:0});
  ok('freezing rain (66) flags freezing rain', fzr.tokens.includes('freezing rain'));
  ok('freezing rain not flagged as snow', !fzr.tokens.some(t=>t.includes('snow')));
  const fzDrizFn=()=>({speed:6,fromDeg:0,tempC:0,precipMm:0.3,precipProb:80,snowfallCm:0,weatherCode:57});
  ok('freezing drizzle (57) flags freezing rain', whatToExpect({segments:segs,times,windFn:fzDrizFn,departMs:0}).tokens.includes('freezing rain'));
  // ordering: thunderstorms before snow
  const allFn=()=>({speed:6,fromDeg:0,tempC:0,precipMm:2,precipProb:90,snowfallCm:0.5,weatherCode:95});
  const allTokens=whatToExpect({segments:segs,times,windFn:allFn,departMs:0}).tokens;
  ok('thunderstorms ordered before snow', allTokens.indexOf('thunderstorms') < allTokens.indexOf('snow'));
}

console.log('\nStrong gusts (absolute ≥50 AND gust−sustained ≥15):');
{
  const segs=[{lat:0,lon:0,bearing:90},{lat:0,lon:0.01,bearing:90}];
  const times=[600,600];
  const mk=(speed,gustKmh)=>()=>({speed,fromDeg:90,tempC:10,precipMm:0,precipProb:0,snowfallCm:0,weatherCode:1,gustKmh});
  const tok=(fn)=>whatToExpect({segments:segs,times,windFn:fn,departMs:0}).tokens;
  ok('high gust + big margin → strong gusts', tok(mk(30,55)).includes('strong gusts'));
  ok('high gust but small margin → none', !tok(mk(45,52)).includes('strong gusts')); // 52-45=7 <15
  ok('big margin but gust under 50 → none', !tok(mk(20,45)).includes('strong gusts')); // 45<50
  ok('boundary 50 gust & 15 margin → strong gusts', tok(mk(35,50)).includes('strong gusts')); // 50>=50, 15>=15
  ok('missing gust field → none (degrades safely)', !tok(()=>({speed:40,fromDeg:90,tempC:10,precipMm:0,precipProb:0,snowfallCm:0,weatherCode:1,gustKmh:null})).includes('strong gusts'));
  // present at ANY segment
  let n=0; const partial=()=>({speed:30,fromDeg:90,tempC:10,precipMm:0,precipProb:0,snowfallCm:0,weatherCode:1,gustKmh:(n++ ? 60 : 20)});
  ok('strong gust on any segment flags it', tok(partial).includes('strong gusts'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
