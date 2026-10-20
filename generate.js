/* RDS rankings-data: genera data/<coleccion>.json con TODAS las marcas de cada ranking de la suite, para que las apps y SuiteRDS
   los descarguen de GitHub Pages (gratis) en vez de leerlos de Firestore (cuota de lecturas).
   - Primera vez / una vez cada FULL_EVERY_H horas: lectura completa de la coleccion (sustituye todo, tambien limpia borrados).
   - El resto de ejecuciones: solo lo nuevo (campo de fecha >= ultima - MARGIN_H) y se fusiona por id. Las marcas que se suben tarde
     (dispositivo sin red) y llevan fecha vieja entran por el margen o por la lectura completa diaria.
   Lectura SIN autenticacion por REST (las reglas de Firestore ya permiten leer; asi no hace falta ninguna clave).
   Uso: node generate.js            (escribe en ./data)
        node generate.js --full     (fuerza lectura completa)
        node generate.js --only scores_squares */
const fs=require('fs'), path=require('path');
const PROJECT='rds-reaction-test';
const BASE='https://firestore.googleapis.com/v1/projects/'+PROJECT+'/databases/(default)/documents';
const FULL_EVERY_H=20, MARGIN_H=2;   // margen 2 h: cada pasada relee solo lo de las ultimas 2 h; las marcas subidas mas tarde entran en la lectura completa diaria
const TENIS_MASK=['avgRT','avgPrec','count','date','disc','hits','index','matchMode','mode','name','penaliza','readOk','readTotal','setScores','setsMe','setsRival','trials','won'];
/* tsf = campo de fecha numerico por el que se pide lo nuevo (igual que mkInc de SuiteRDS) */
const COLS=[
  { name:'scores_ballcoordination', tsf:'date' },
  { name:'scores_900coordination', tsf:'ts', probe:true },   // app nueva (2026-10-20): sin archivo hasta que tenga marcas
  { name:'scores_circuit', tsf:'ts' },
  { name:'scores_gimnasia', tsf:'ts' },
  { name:'scores_lights', tsf:'ts' },
  { name:'scores_memorycards', tsf:'ts' },
  { name:'scores_perception', tsf:'ts' },
  { name:'scores_perception2', tsf:'ts', probe:true },   // app nueva (2026-10-14): sin archivo hasta que tenga marcas
  { name:'scores_processing', tsf:'ts' },
  { name:'scores_processing2', tsf:'ts' },
  { name:'scores_rallymemory', tsf:'ts' },
  { name:'scores_reactionkarate', tsf:'ts' },
  { name:'scores_reactiontenis', tsf:'date', mask:TENIS_MASK },
  { name:'scores_reactiontrial', tsf:'ts' },
  { name:'scores_squares', tsf:'ts' },
  { name:'scores_reaction_10_normal_press_nosound', tsf:'ts' },   // Clasificacion de SuiteRDS
  { name:'scores_reaction_10_normal_press_sound', tsf:'ts' }      // combo oficial de Campeonatos
];
/* Reaction guarda UNA coleccion por combinacion (rondas x modo x pulso x sonido). Firestore no deja listar colecciones sin permisos, asi que se prueban
   los nombres posibles (misma matriz que rdsPrepare de la app) UNA VEZ cada FULL_EVERY_H horas; solo las que tienen marcas generan JSON. */
{
  const have=new Set(COLS.map(c=>c.name));
  [10,15,30,50].forEach(r=>['normal','limite','distractor','gonogo'].forEach(m=>['press','press2','press2i','release','release2','release2i'].forEach(p=>{
    (m==='distractor'||m==='gonogo' ? ['nosound'] : ['sound','nosound']).forEach(sn=>{
      const name='scores_reaction_'+r+'_'+m+'_'+p+'_'+sn;
      if(!have.has(name)) COLS.push({ name:name, tsf:'ts', probe:true });
    });
  })));
}
const args=process.argv.slice(2), FORCE_FULL=args.includes('--full');
const ONLY=args.includes('--only') ? args[args.indexOf('--only')+1] : null;
const DIR=path.join(__dirname,'data');
let reads=0;
const STATE_FILE=path.join(DIR,'_state.json');
let state={ probeAt:{} }; try{ state=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); if(!state.probeAt) state.probeAt={}; }catch(e){}
let stateDirty=false;

function rv(v){
  if('stringValue' in v) return v.stringValue;
  if('integerValue' in v) return Number(v.integerValue);
  if('doubleValue' in v) return Number(v.doubleValue);
  if('booleanValue' in v) return v.booleanValue;
  if('timestampValue' in v) return v.timestampValue;
  if('nullValue' in v) return null;
  if('arrayValue' in v) return (v.arrayValue.values||[]).map(rv);
  if('mapValue' in v){ const o={}, fl=v.mapValue.fields||{}; for(const k in fl) o[k]=rv(fl[k]); return o; }
  return null;
}
function canon(x){ if(Array.isArray(x)) return x.map(canon); if(x && typeof x==='object'){ const o={}; Object.keys(x).sort().forEach(k=>{ o[k]=canon(x[k]); }); return o; } return x; }   // claves ordenadas: salida estable (sin falsos cambios)
function conv(d){ const o={ id:d.name.split('/').pop() }, fl=d.fields||{}; for(const k in fl) o[k]=rv(fl[k]); return canon(o); }
async function http(url, opt, tries=4){
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url, opt);
      if(r.ok) return r.json();
      if(r.status===429) throw new Error('429 cuota de Firestore agotada');
      if(r.status<500) throw new Error('HTTP '+r.status+' '+(await r.text()).slice(0,200));
    }catch(e){ if(/429|HTTP 4/.test(String(e.message))||i===tries-1) throw e; }
    await new Promise(r=>setTimeout(r,1500*(i+1)));
  }
}
async function fullRead(c){
  const mask=(c.mask||[]).map(m=>'&mask.fieldPaths='+encodeURIComponent(m)).join('');
  let out=[], tok='';
  do{
    const j=await http(BASE+'/'+c.name+'?pageSize=300'+mask+(tok?'&pageToken='+encodeURIComponent(tok):''));
    (j.documents||[]).forEach(d=>{ out.push(conv(d)); }); reads+=(j.documents||[]).length;
    tok=j.nextPageToken||'';
  }while(tok);
  return out;
}
async function tailRead(c, since){
  const q={ structuredQuery:{ from:[{collectionId:c.name}],
    where:{ fieldFilter:{ field:{fieldPath:c.tsf}, op:'GREATER_THAN_OR_EQUAL', value:{integerValue:String(Math.max(0,Math.floor(since)))} } } } };
  if(c.mask) q.structuredQuery.select={ fields:c.mask.map(m=>({fieldPath:m})) };
  const j=await http(BASE+':runQuery', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(q) });
  const out=[]; (j||[]).forEach(x=>{ if(x.document){ out.push(conv(x.document)); } }); reads+=out.length||1;
  return out;
}
function maxTs(docs, tsf){
  let m=0; const lim=Date.now()+36e5;
  docs.forEach(d=>{ const t=d[tsf]; if(typeof t==='number' && t>m && t<=lim) m=t; });
  return m;
}
async function run(c){
  const file=path.join(DIR,c.name+'.json');
  let cur=null; try{ cur=JSON.parse(fs.readFileSync(file,'utf8')); }catch(e){}
  const now=Date.now();
  if(c.probe && !cur){   // combinacion sin JSON: solo se prueba si ya pasaron FULL_EVERY_H horas desde la ultima vez (vacia)
    const last=state.probeAt[c.name]||0;
    if(!FORCE_FULL && now-last<FULL_EVERY_H*36e5) return;
    state.probeAt[c.name]=now; stateDirty=true;
  }
  const needFull=FORCE_FULL || !cur || !cur.fullAt || now-cur.fullAt>FULL_EVERY_H*36e5;
  let byId={}, fullAt=cur&&cur.fullAt||0, mode;
  if(needFull){
    (await fullRead(c)).forEach(d=>{ byId[d.id]=d; }); fullAt=now; mode='completa';
  }else{
    cur.docs.forEach(d=>{ byId[d.id]=canon(d); });
    (await tailRead(c, (cur.maxTs||0)-MARGIN_H*36e5)).forEach(d=>{ byId[d.id]=d; }); mode='nuevas';
  }
  const docs=Object.keys(byId).sort().map(k=>byId[k]);
  if(c.probe && !cur && docs.length===0){ return; }   // vacia: sin archivo (el cliente cae a Firestore, 1 lectura)
  const next={ v:1, col:c.name, tsf:c.tsf, fullAt:fullAt, maxTs:maxTs(docs,c.tsf), n:docs.length, docs:docs };
  const before=cur ? JSON.stringify({ fullAt:cur.fullAt, maxTs:cur.maxTs, docs:cur.docs }) : '';
  const after=JSON.stringify({ fullAt:next.fullAt, maxTs:next.maxTs, docs:next.docs });
  const changed = before!==after;
  if(changed){ next.generatedAt=now; fs.writeFileSync(file, JSON.stringify(next)); }
  console.log((changed?'ESCRITO ':'sin cambios ')+c.name+' ('+mode+', '+docs.length+' docs, '+(changed?(fs.statSync(file).size/1024).toFixed(0)+' KB':'-')+')');
}
(async function(){
  fs.mkdirSync(DIR,{recursive:true});
  let fail=0;
  for(const c of COLS){
    if(ONLY && c.name!==ONLY) continue;
    try{ await run(c); }catch(e){ fail++; console.error('FALLO '+c.name+': '+e.message); }
  }
  if(stateDirty && !ONLY){ fs.writeFileSync(STATE_FILE, JSON.stringify({ probeAt:Object.fromEntries(Object.keys(state.probeAt).sort().map(k=>[k,state.probeAt[k]])) })); }
  console.log('lecturas estimadas de Firestore: '+reads);
  if(fail) process.exitCode=1;
})();
