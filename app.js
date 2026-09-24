/* Confluence — trading journal.
   The whole design rests on one chain: confluences ticked -> grade -> risk % -> lot size.
   Everything else is bookkeeping around that. */

"use strict";

/* Bumped with every deploy, shown in Settings, so "am I actually on the new build?"
   has an answer that doesn't involve guessing at the service worker. */
const BUILD = "v13";

const SUPABASE_URL = "https://ovigsifjypyznhvshmsl.supabase.co";
const SUPABASE_KEY = "sb_publishable_C_Nv_U7v1gnxpL4OMmJPOA_4ryMrT6V";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage },
});

/* ========================= constants ========================= */

const GRADES = {
  4:{g:"A+",risk:1.00,cls:"up",   note:"Full size. The setup you actually wait for."},
  3:{g:"B", risk:0.50,cls:"flat", note:"Playable, half size. A missing leg is a missing edge."},
  2:{g:"C", risk:0.25,cls:"amber",note:"Quarter size. A participation trade, not a conviction trade."},
  1:{g:"—", risk:0,   cls:"down", note:"Not a setup. Close the platform."},
  0:{g:"—", risk:0,   cls:"down", note:"Not a setup. Close the platform."},
};
const SESSIONS = ["Asia","London","Overlap","NY"];
const MENTAL   = ["Calm","Focused","Tired","FOMO","Revenge","Distracted"];
const MISTAKES = ["Moved SL","Chased entry","Early exit","Late entry","Oversized",
                  "Outside session","No screenshot","Ignored checklist","Revenge trade"];

const INSTRUMENTS = {
  XAUUSD:{pip:0.1,pv:10}, EURUSD:{pip:0.0001,pv:10}, GBPUSD:{pip:0.0001,pv:10},
  AUDUSD:{pip:0.0001,pv:10}, NZDUSD:{pip:0.0001,pv:10}, USDCAD:{pip:0.0001,pv:7.3},
  USDCHF:{pip:0.0001,pv:11.5}, EURGBP:{pip:0.0001,pv:12.6}, USDJPY:{pip:0.01,pv:6.7},
  EURJPY:{pip:0.01,pv:6.7}, GBPJPY:{pip:0.01,pv:6.7}, NAS100:{pip:1,pv:1},
  US30:{pip:1,pv:1}, SPX500:{pip:1,pv:1}, BTCUSD:{pip:1,pv:1},
};

const DEFAULT_ACCOUNT = {
  /* One rule, on purpose. Two trades a day is the whole discipline: it forces
     the question "is this a master setup?" instead of "am I allowed?". The other
     columns still exist in the database but nothing reads them any more. */
  maxTradesDay: 2,
  firm:"", size:100000, dailyDDPct:100, maxDDPct:100, targetPct:10,
  ownDailyStopPct:100, ownWeeklyStopPct:100, maxConsecLosses:99, minRR:2.5, greenLock:false,
};

/* The four timeframes the entry model is built on, top down. Index-aligned with
   a model's `confluences` and `tests` arrays. */
const TIMEFRAMES = ["4H","1H","15/30M","1M entry"];


/* Built from what he actually writes in the entry box, trade after trade:
   orderflow direction, the sweep, the break, the 15M OB at the fib, entry from
   the imbalance under liquidity, stop under the sweep extreme, 2.5 RR.
   Ticked on the map screen and saved onto the trade, so a skipped step becomes
   measurable rather than just regrettable. */
/* Items with a {Long, Short} shape read back in the direction of the trade, because
   "sweep the last low, break up" is the same idea mirrored — and a checklist you have
   to mentally invert is one you stop reading. */
const PRE_TRADE = [
  ["4H — bias", [
    {id:"of4h", q:{Long:"4H orderflow is up and matches my route",
                   Short:"4H orderflow is down and matches my route"},
                why:"Not just present. Pointing my way."},
    {id:"htf",  q:"HTF isn't about to reverse on me",
                why:"The one that turns a good read into a loss."},
  ]],
  ["1H — the level", [
    {id:"sweep",q:{Long:"1H swept the last low — previous demand taken",
                   Short:"1H swept the last high — previous supply taken"}, why:""},
    {id:"break",q:{Long:"Break to the upside — supply disrespected",
                   Short:"Break to the downside — demand disrespected"},
                why:"Sweep alone is not the setup."},
    {id:"fib",  q:"Fib drawn from the sweep to the extreme", why:""},
  ]],
  ["15/5M — the entry", [
    {id:"ob",   q:"OB on the 15M sitting at the fib level", why:""},
    {id:"imb",  q:{Long:"Entry from the imbalance, under the liquidity",
                   Short:"Entry from the imbalance, above the liquidity"}, why:""},
    {id:"sl",   q:{Long:"Stop under the sweep extreme",
                   Short:"Stop above the sweep extreme"}, why:"A place, not a pip count."},
  ]],
  ["In the position", [
    {id:"reentry", q:{Long:"Re-entry if a supply breaks into a CHoCH",
                      Short:"Re-entry if a demand breaks into a CHoCH"},
                   why:"The confirmation entry inside the position."},
    {id:"be",      q:{Long:"BE once the previous supply zone breaks",
                      Short:"BE once the previous demand zone breaks"}, why:""},
  ]],
  ["Head", [
    {id:"waited",q:"I waited for this one — I didn't go looking for it",
                 why:"Two a day. Master setups only."},
    {id:"calm",  q:"Not FOMO, not revenge, not tired", why:""},
  ]],
];
const PRE_TRADE_ITEMS = PRE_TRADE.flatMap(([,items]) => items);

const RISK_STEPS = [1, 0.5, 0.25];

/* Two ways in, each with the RR it's taken at. Stored in the trade's `model` field,
   so the Stats splits keep working against them. */
const ENTRY_TYPES = [
  {label:"Extreme sweep zone", rr:3},
  {label:"Fib entry",          rr:2.5},
];

/* NF is not a fourth outcome, it's the absence of one: the limit never filled,
   so it costs nothing, counts for nothing, and doesn't spend one of the day's two. */
const RESULTS = [
  {k:"TP", label:"TP"},
  {k:"BE", label:"BE"},
  {k:"SL", label:"SL"},
  {k:"NF", label:"Not filled"},
];

/* FX sessions, decided in UTC so the answer doesn't change with the device's clock. */
function sessionFor(d){
  const h = d.getUTCHours() + d.getUTCMinutes()/60;
  if(h >= 7  && h < 12) return "London";
  if(h >= 12 && h < 16) return "Overlap";
  if(h >= 16 && h < 21) return "NY";
  return "Asia";
}
/* Asia opens at 21:00 UTC. The rule is to be flat and written up before then,
   because the spreads at the Asian open are not worth being in. */
function asiaOpen(){
  const now=new Date();
  const o=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),21,0,0));
  if(o<=now) o.setUTCDate(o.getUTCDate()+1);
  return o;
}
const hoursToAsia = () => (asiaOpen()-new Date())/3600000;
const asiaOpenLocal = () => asiaOpen().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});

function sessionFromFields(date,time){
  if(!date || !time) return null;
  const d = new Date(`${date}T${time}`);
  return isNaN(d) ? null : sessionFor(d);
}

/* ========================= state ========================= */

const S = {
  user:null, booted:false, loading:true,
  screen:"home", trades:[], account:{...DEFAULT_ACCOUNT},
  period:"day", draft:null, dash:"stats", checks:{}, checkDate:"",
  intake:null, keepScroll:false, busy:false,
  /* Testing mode is a property of this device, not of the trading plan, so it lives
     in localStorage and never touches the account's rules. */
  testing:(()=>{ try{ return localStorage.getItem("cf.testing")==="1"; }catch(_){ return false; } })(),
};
function setTesting(on){
  S.testing=on;
  try{ localStorage.setItem("cf.testing", on?"1":"0"); }catch(_){}
}

/* ========================= helpers ========================= */

const $ = s => document.querySelector(s);
const esc = s => String(s??"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const today = () => isoOf(new Date());
const nowHM = () => { const d=new Date(); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const fx = (v,d=2) => v==null||!Number.isFinite(v) ? "—" : v.toFixed(d);
/* Pinned to en-US: a "$" next to Dutch thousands separators reads as $2.585, not $2,585. */
const money = v => v==null||!Number.isFinite(v) ? "—"
  : (v<0?"−":"")+"$"+Math.abs(v).toLocaleString("en-US",{maximumFractionDigits:0});
const asR = v => v==null||!Number.isFinite(v) ? "—" : (v>0?"+":v<0?"−":"")+Math.abs(v).toFixed(2)+"R";
const asPct = v => v==null||!Number.isFinite(v) ? "—" : (v>0?"+":v<0?"−":"")+Math.abs(v).toFixed(2)+"%";
const tone = v => v==null||!Number.isFinite(v) ? "" : v>0 ? "up" : v<0 ? "down" : "";
const inst = p => INSTRUMENTS[p] || {pip:0.0001,pv:10};
const gradeFor = c => GRADES[Math.min(4,Math.max(0,c|0))];

function toast(msg){
  const el=document.createElement("div");
  el.className="toast"; el.textContent=msg; el.setAttribute("role","status");
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),2600);
}

/** R multiple. Broker P&L wins whenever it exists — it's what actually hit the account. */
/* Everything downstream of a trade is expressed as a percentage of the account.
   TP/SL/BE is the only input; R falls out of it as result% ÷ risk%, so no currency
   ever enters the chain. SL is a full −1R — the whole amount that was at risk —
   rather than a flat −1%, because a C setup only ever had 0.25% on the table. */
function pctOf(t){
  const rp = num(t.riskPct);
  if(t.result==="NF") return 0;          // limit never filled — nothing happened
  if(t.result==="SL") return rp==null ? null : -rp;
  if(t.result==="BE") return 0;
  if(t.result==="TP") return num(t.resultPct);
  // Trades closed before results existed, or imported from cTrader.
  const pnl = num(t.pnl), size = num(S.account.size);
  if(pnl!=null && size) return pnl/size*100;
  return null;
}
function rOf(t){
  if(t.result==="SL") return -1;
  if(t.result==="BE") return 0;
  if(t.result==="NF") return null;
  const p = pctOf(t), rp = num(t.riskPct);
  // A trade mapped at grade "—" risked nothing, so R is undefined. That's a
  // missing ratio, not a missing outcome — never let it decide whether a trade closed.
  return (p!=null && rp) ? p/rp : null;
}

const isOpen = t => !t.result && num(t.pnl)==null && (t.exit==null || t.exit==="");
/* Once you've said how it closed, that IS the outcome. Only trades from before
   results existed get classified from their numbers. */
function outcomeOf(t){
  if(t.result==="NF") return "Not filled";
  if(t.result==="TP") return "Win";
  if(t.result==="SL") return "Loss";
  if(t.result==="BE") return "BE";
  if(isOpen(t)) return "Open";
  const p=pctOf(t); if(p==null) return "Open";
  return p>0.001 ? "Win" : p<-0.001 ? "Loss" : "BE";
}
/* Statistics only count trades that actually happened. */
const closedTrades = () => S.trades.filter(t=>!isOpen(t) && !t.hypothetical && t.result!=="NF");
const openTrades   = () => S.trades.filter(isOpen);
/* EOD owns exactly one queue: trades with no result yet. Saving a result
   moves the trade out of EOD and into All trades. */
const needsWriteup = () => S.trades.filter(t => !t.result);

function weekStart(s){
  const d=new Date(s+"T00:00:00");
  d.setDate(d.getDate()-((d.getDay()+6)%7));
  return isoOf(d);
}
function inPeriod(dateStr,period){
  const t=today();
  if(period==="day")  return dateStr===t;
  if(period==="week") return weekStart(dateStr||t)===weekStart(t);
  return (dateStr||"").slice(0,7)===t.slice(0,7);
}

/* ---------- the rules, made live ---------- */
function guard(){
  const a=S.account, t=today(), acct=num(a.size)||0;
  // A limit that never filled was never an execution, so it doesn't spend one of the two.
  const todays=S.trades.filter(x=>x.date===t && !x.hypothetical && x.result!=="NF");
  const done=todays.filter(x=>!isOpen(x));

  const rToday=done.reduce((s,x)=>s+(rOf(x)??0),0);
  const pctToday=done.reduce((s,x)=>s+(pctOf(x)??0),0);

  const wk=closedTrades().filter(x=>weekStart(x.date||t)===weekStart(t));
  const pctWeek=wk.reduce((s,x)=>s+(pctOf(x)??0),0);

  const seq=[...closedTrades()].sort((x,y)=>(y.date+y.time).localeCompare(x.date+x.time));
  let streak=0; for(const x of seq){ if(outcomeOf(x)==="Loss") streak++; else break; }

  const byDay={};
  for(const x of closedTrades()) byDay[x.date]=(byDay[x.date]??0)+(pctOf(x)??0);
  let redDays=0;
  for(const d of Object.keys(byDay).sort().reverse()){ if(byDay[d]<0) redDays++; else break; }

  const blocks=[], warns=[];
  if(todays.length>=a.maxTradesDay)
    blocks.push(`${todays.length} trades taken. That's the day — the next one can wait.`);
  if(todays.length===a.maxTradesDay-1 && todays.length>0)
    warns.push(`One trade left today. Make it a setup you waited for.`);

  // Testing mode suspends the blocks but still computes them, so the screen can
  // show exactly which rules you are currently ignoring.
  return {blocks: S.testing ? [] : blocks, muted: S.testing ? blocks : [],
          warns, todays, done, rToday, pctToday, pctWeek, streak, acct};
}

function periodStats(period){
  const ts=closedTrades().filter(t=>inPeriod(t.date,period));
  return {
    pct:ts.reduce((s,t)=>s+(pctOf(t)??0),0),
    r:ts.reduce((s,t)=>s+(rOf(t)??0),0),
    count:ts.length,
  };
}

/* ========================= data ========================= */

const tradeFromRow = r => ({
  id:r.id, date:r.trade_date, time:r.trade_time, pair:r.pair, direction:r.direction,
  session:r.session, model:r.model, confluences:r.confluences||[], confidence:r.confidence,
  grade:r.grade, riskPct:r.risk_pct, riskUsd:r.risk_usd, entry:r.entry, sl:r.sl, tp:r.tp,
  exit:r.exit_price, pnl:r.pnl, lots:r.lots, plannedRR:r.planned_rr,
  mentalBefore:r.mental_before, followedPlan:r.followed_plan, mistakes:r.mistakes||[],
  entryReason:r.entry_reason, slReason:r.sl_reason, tpReason:r.tp_reason,
  reviewNotes:r.review_notes, chartBefore:r.chart_before, chartAfter:r.chart_after,
  hypothetical:r.hypothetical, mappedMode:r.mapped_mode, liqBuildup:r.liq_buildup,
  result:r.result, resultPct:r.result_pct, mentalNotes:r.mental_notes, checks:r.checks||[],
});
const tradeToRow = t => ({
  user_id:S.user.id, trade_date:t.date||today(), trade_time:t.time||"",
  pair:t.pair||"", direction:t.direction||"Long", session:t.session||"", model:t.model||"",
  confluences:t.confluences||[], confidence:num(t.confidence), grade:t.grade||"",
  risk_pct:num(t.riskPct), risk_usd:num(t.riskUsd), entry:num(t.entry), sl:num(t.sl),
  tp:num(t.tp), exit_price:num(t.exit), pnl:num(t.pnl), lots:num(t.lots),
  planned_rr:num(t.plannedRR), mental_before:t.mentalBefore||"",
  followed_plan:!!t.followedPlan, mistakes:t.mistakes||[],
  entry_reason:t.entryReason||"", sl_reason:t.slReason||"", tp_reason:t.tpReason||"",
  review_notes:t.reviewNotes||"", chart_before:t.chartBefore||null,
  chart_after:t.chartAfter||null, hypothetical:!!t.hypothetical,
  mapped_mode:t.mappedMode||"now", liq_buildup:!!t.liqBuildup,
  result:t.result||null, result_pct:num(t.resultPct),
  mental_notes:t.mentalNotes||"", checks:t.checks||[],
  updated_at:new Date().toISOString(),
});
const accountFromRow = r => ({
  firm:r.firm, size:+r.size, dailyDDPct:+r.daily_dd_pct, maxDDPct:+r.max_dd_pct,
  targetPct:+r.target_pct, ownDailyStopPct:+r.own_daily_stop_pct,
  ownWeeklyStopPct:+r.own_weekly_stop_pct, maxTradesDay:+r.max_trades_day,
  maxConsecLosses:+r.max_consec_losses, minRR:+r.min_rr, greenLock:r.green_lock,
});
const accountToRow = a => ({
  user_id:S.user.id, firm:a.firm||"", size:num(a.size)??50000,
  daily_dd_pct:num(a.dailyDDPct)??5, max_dd_pct:num(a.maxDDPct)??10,
  target_pct:num(a.targetPct)??10, own_daily_stop_pct:num(a.ownDailyStopPct)??2,
  own_weekly_stop_pct:num(a.ownWeeklyStopPct)??4, max_trades_day:num(a.maxTradesDay)??2,
  max_consec_losses:num(a.maxConsecLosses)??2, min_rr:num(a.minRR)??2,
  green_lock:!!a.greenLock, updated_at:new Date().toISOString(),
});

async function loadAll(){
  S.loading=true; render();
  const [tr,ac] = await Promise.all([
    sb.from("trades").select("*").order("trade_date",{ascending:false}),
    sb.from("accounts").select("*").maybeSingle(),
  ]);
  if(tr.error) toast("Could not load trades"); else S.trades=(tr.data||[]).map(tradeFromRow);
  if(!ac.error && ac.data) S.account={...DEFAULT_ACCOUNT,...accountFromRow(ac.data)};
  S.loading=false; render();
}

async function saveTrade(t){
  const row=tradeToRow(t);
  const q = t.id
    ? sb.from("trades").update(row).eq("id",t.id).select().single()
    : sb.from("trades").insert(row).select().single();
  const {data,error}=await q;
  if(error){ toast("Save failed: "+error.message); throw error; }
  const rec=tradeFromRow(data);
  const i=S.trades.findIndex(x=>x.id===rec.id);
  if(i>=0) S.trades[i]=rec; else S.trades.unshift(rec);
}
async function removeTrade(id){
  const {error}=await sb.from("trades").delete().eq("id",id);
  if(error) return toast("Delete failed");
  S.trades=S.trades.filter(t=>t.id!==id);
}
async function saveAccount(){
  const {error}=await sb.from("accounts").upsert(accountToRow(S.account),{onConflict:"user_id"});
  if(error) toast("Could not save settings");
}

/* charts live in the user's own folder; the bucket is private, so display uses signed URLs */
const shotCache = new Map();
async function uploadShot(file){
  const ext=(file.name.split(".").pop()||"jpg").toLowerCase();
  const path=`${S.user.id}/${Date.now()}.${ext}`;
  const {error}=await sb.storage.from("charts").upload(path,file,{upsert:false});
  if(error){ toast("Upload failed: "+error.message); return null; }
  return path;
}
async function shotURL(path){
  if(!path) return null;
  if(shotCache.has(path)) return shotCache.get(path);
  const {data,error}=await sb.storage.from("charts").createSignedUrl(path,3600);
  if(error||!data) return null;
  shotCache.set(path,data.signedUrl);
  return data.signedUrl;
}
async function hydrateShots(){
  for(const img of document.querySelectorAll("img[data-shot]")){
    const u=await shotURL(img.dataset.shot);
    if(u) img.src=u;
  }
}

/* ========================= cTrader hand-off =========================
   cTrader prints each figure ABOVE its label, so for every label we walk
   back to the nearest numeric line. */

const NUMLINE=/^[−-]?[\d\s,]*\d(?:[.,]\d+)?$/;
const toNum = s => num(String(s).replace(/−/g,"-").replace(/\s/g,"")
                    .replace(/,(?=\d{3}\b)/g,"").replace(",","."));

function backFrom(lines,i,test=NUMLINE){
  for(let k=i-1;k>=0&&k>=i-4;k--){ const l=lines[k].trim(); if(test.test(l)) return l; }
  return null;
}
function parseCTrader(text){
  if(!text) return null;
  if(/(^|[;&\s])pnl\s*=/i.test(text)){
    const kv={};
    text.split(/[;&\n]/).forEach(p=>{const[m,v]=p.split("=");if(m&&v)kv[m.trim().toLowerCase()]=v.trim()});
    if(kv.pnl==null) return null;
    return {pnl:toNum(kv.pnl),symbol:(kv.symbol||"").toUpperCase(),lots:toNum(kv.lots),
            pips:toNum(kv.pips),direction:/sell|short/i.test(kv.dir||"")?"Short":"Long"};
  }
  const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(!lines.length) return null;
  const find=re=>lines.findIndex(l=>re.test(l));
  const out={};
  const iP=find(/net\s*p\s*[&]?\s*l/i);   if(iP>=0) out.pnl=toNum(backFrom(lines,iP));
  const iPi=find(/^pips$/i);              if(iPi>=0) out.pips=toNum(backFrom(lines,iPi));
  const iL=find(/^lots$/i);               if(iL>=0) out.lots=toNum(backFrom(lines,iL));
  const iF=find(/^fees$/i);               if(iF>=0) out.fees=toNum(backFrom(lines,iF));
  const iD=find(/^direction$/i);
  if(iD>=0){ const d=backFrom(lines,iD,/^(buy|sell|long|short)$/i);
             if(d) out.direction=/sell|short/i.test(d)?"Short":"Long"; }
  const sym=lines.find(l=>/^[A-Z]{3,8}$/.test(l)&&!["USD","EUR","GBP","CFD"].includes(l));
  if(sym) out.symbol=sym;
  if(out.pnl==null) return null;
  out.direction=out.direction||"Long";
  return out;
}
function readURLIntake(){
  const q=new URLSearchParams(location.search);
  const pnl=num(q.get("pnl"));
  if(pnl==null) return false;
  S.intake={pnl, symbol:(q.get("symbol")||"").toUpperCase().replace(/[^A-Z0-9]/g,""),
    lots:num(q.get("lots")), pips:num(q.get("pips")),
    direction:/sell|short/i.test(q.get("dir")||"")?"Short":"Long"};
  history.replaceState(null,"",location.pathname);
  return true;
}
async function pasteCTrader(){
  let txt="";
  try{ txt=await navigator.clipboard.readText(); }
  catch(_){ const m=prompt("Paste the cTrader text here:"); if(m==null) return; txt=m; }
  const p=parseCTrader(txt);
  if(!p) return toast("No Net P&L found in that text");
  S.intake=p; go("intake");
}

/* ========================= icons ========================= */

const PATHS = {
  check:'<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  chart:'<path d="M4 19V11M10 19V5M16 19v-8M22 19H2"/>',
  model:'<path d="M3 17l5-5 4 3 8-8"/><path d="M14 7h6v6"/>',
  moon:'<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  back:'<path d="M15 18l-6-6 6-6"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
};
const ic = k => `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${PATHS[k]}</svg>`;
const tickSVG = `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

const head = (title,to="home") => `<div class="head">
  <button class="ico" data-go="${to}" aria-label="Back">${ic("back")}</button>
  <h2>${esc(title)}</h2></div>`;

/* ========================= screens ========================= */

function screenAuth(){
  return `<div class="auth">
    <div class="mark">Confluence</div>
    <p class="bl">Your journal, on every device you sign in on.</p>
    <form id="authform">
      <input type="email" id="email" placeholder="Email" autocomplete="username" required>
      <input type="password" id="pw" placeholder="Password" autocomplete="current-password" minlength="8" required>
      <button class="btn pri" type="submit" style="margin-top:10px">Sign in</button>
    </form>
    <button class="link" data-act="signup" style="margin-top:20px">Create an account</button>
    ${S.authMsg ? `<p class="note ${S.authBad?"bad":""}" style="margin-top:20px;text-align:left">
      ${esc(S.authMsg)}</p>` : ""}
  </div>`;
}

function screenHome(){
  const G=guard(), a=S.account, P=periodStats(S.period);
  const blocked=G.blocks.length>0;
  const ck=(S.checkDate===today()) ? PRE_TRADE_ITEMS.filter(i=>S.checks[i.id]).length : 0;
  const op=openTrades();

  const unmarked=S.trades.filter(t=>t.date===today() && !t.result).length;
  const eodDue=unmarked>0 && hoursToAsia()<=3;

  const status = S.testing
    ? `<div class="status test"><span class="dot"></span><div>
         <b>Testing mode.</b> Your rules are suspended — log as many trades as you like.
         ${G.muted.length?`<span class="why">Would be blocked: ${esc(G.muted.join(" "))}</span>`:""}
         <button class="link" data-act="testoff" style="display:block;margin-top:6px">Turn it off</button>
       </div></div>`
    : eodDue
    ? `<div class="status warn"><span class="dot"></span><div>
         <b>${unmarked} ${unmarked===1?"trade":"trades"} still unmarked.</b>
         Asia opens ${asiaOpenLocal()} — be flat and written up before then.
         <button class="link" data-go="eod" style="display:block;margin-top:5px">Write them up</button>
       </div></div>`
    : blocked
    ? `<div class="status stop"><span class="dot"></span><div><b>Done for the day.</b> ${esc(G.blocks[0])}
         ${G.blocks[0].includes("trades taken")
           ? `<button class="link" data-go="settings" style="display:block;margin-top:5px">Change your daily limit</button>`:""}
       </div></div>`
    : G.warns.length
    ? `<div class="status warn"><span class="dot"></span><div>${esc(G.warns[0])}</div></div>`
    : `<div class="status"><span class="dot"></span><div><b>${a.maxTradesDay-G.todays.length} of ${a.maxTradesDay}</b> trades left today${G.done.length?` · ${asR(G.rToday)} so far`:""}</div></div>`;

  return `
  <div class="head">
    <div style="flex:1"></div>
    <button class="ico r" data-go="settings" aria-label="Settings">${ic("gear")}</button>
  </div>

  <div class="hero">
    <div class="seg" role="group" aria-label="Period">
      ${[["day","Day"],["week","Week"],["month","Month"]].map(([k,l])=>
        `<button data-period="${k}" aria-pressed="${S.period===k}">${l}</button>`).join("")}
    </div>
    <div class="big ${tone(P.pct)}">${asPct(P.pct)}</div>
    <div class="herosub"><span class="num">${asR(P.r)}</span> · ${P.count} ${P.count===1?"trade":"trades"}</div>
  </div>

  ${status}

  <div class="pills">
    <button class="pill go" data-map="now" ${blocked?"disabled":""}>
      ${ic("plus")}<span class="t">Now</span>
      <span class="c">${blocked?"blocked by your rules":`${sessionFor(new Date())} session`}</span>
    </button>
    <button class="pill" data-go="eod">
      ${ic("moon")}<span class="t">EOD</span>
      <span class="c">${(()=>{const n=needsWriteup().length;
        return n?`${n} to write up`:"all written up";})()}</span>
    </button>
    <button class="pill" data-go="alltrades">
      ${ic("list")}<span class="t">All trades</span>
      <span class="c">${S.trades.length} logged</span>
    </button>
    <button class="pill" data-go="dashboard">
      ${ic("chart")}<span class="t">Stats</span>
      <span class="c">${closedTrades().length} closed</span>
    </button>
  </div>

  <div class="pills small">
    <button class="pill" data-go="checklist">
      ${ic("check")}<span class="t">Checklist</span>
      <span class="c">${ck}/${PRE_TRADE_ITEMS.length}</span>
    </button>
  </div>

  ${op.length?`<div class="sec">
    <div class="rowb sec-t"><span>Open — needs an exit</span>
      <button class="link" data-act="paste">Paste cTrader result</button></div>
    <div class="list">${op.map(tradeItem).join("")}</div>
  </div>`:""}`;
}

/* Green won, red lost, grey broke even, blue is still running. */
function tradeItem(t){
  const o=outcomeOf(t), pct=pctOf(t);
  const c = o==="Win"?"var(--up)" : o==="Loss"?"var(--down)"
          : o==="BE"?"var(--flat)" : o==="Not filled"?"var(--tx-3)" : "var(--blue)";
  return `<button class="item" data-trade="${esc(t.id)}">
    <span class="bar" style="background:${c}"></span>
    <span class="main">
      <span class="nm">${esc(t.pair||"—")}</span>
      <span class="tag" style="margin-left:7px">${esc(t.direction||"")}</span>
      ${t.grade&&t.grade!=="—"?`<span class="tag" style="margin-left:4px">${esc(t.grade)}</span>`:""}
      <span class="mt">${esc(t.date||"")} ${esc(t.time||"")}${t.session?" · "+esc(t.session):""}${t.model?" · "+esc(t.model):""}</span>
    </span>
    <span class="val ${tone(pct)}">${
      o==="Open"       ? `<span class="tag open">OPEN</span>`
    : o==="Not filled" ? `<span class="tag">NOT FILLED</span>`
    : asPct(pct)}</span>
  </button>`;
}

/* ---------- checklist ---------- */
function screenChecklist(){
  if(S.checkDate!==today()){ S.checks={}; S.checkDate=today(); }
  const a=S.account, G=guard();
  const dir=S.ckDir||"Long";
  const dirOf = q => typeof q==="string" ? q : (q[dir] || q.Long);
  const done=PRE_TRADE_ITEMS.filter(i=>S.checks[i.id]).length;

  return `${head("Checklist")}
  <p class="hint" style="margin-bottom:16px">The same list you tick on a trade. Read it out loud —
  it only works out loud. ${a.maxTradesDay-G.todays.length} of ${a.maxTradesDay} trades left today.</p>
  <div class="dirpick" style="margin:0 0 6px">${["Long","Short"].map(x=>
    `<button class="dir ${dir===x?"on":""}" data-ckdir="${x}" aria-pressed="${dir===x}">${x}</button>`).join("")}</div>
  ${PRE_TRADE.map(([group,items])=>`
    <div class="sec">
      <div class="sec-t">${esc(group)}</div>
      ${items.map(it=>`
        <label class="check ${S.checks[it.id]?"done":""}">
          <input type="checkbox" data-check="${it.id}" ${S.checks[it.id]?"checked":""}>
          <span class="q">${esc(dirOf(it.q))}${it.why?`<span class="why">${esc(it.why)}</span>`:""}</span>
        </label>`).join("")}
    </div>`).join("")}
  <div style="margin-top:30px">
    ${done===PRE_TRADE_ITEMS.length && !G.blocks.length
      ? `<button class="btn pri" data-map="now">All clear — map the trade</button>`
      : `<p class="hint" style="text-align:center">${PRE_TRADE_ITEMS.length-done} still unanswered</p>`}
    <button class="btn ghost" style="margin-top:12px" data-act="resetchecks">Reset</button>
  </div>`;
}

/* ---------- dashboard ---------- */
function screenDashboard(){
  return `${head("Stats")}
  <div class="seg" style="margin:6px 0 26px">
    <button data-dash="stats"  aria-pressed="${S.dash==="stats"}">Stats</button>
    <button data-dash="trades" aria-pressed="${S.dash==="trades"}">All trades</button>
  </div>
  ${S.dash==="stats" ? statsBody() : tradesBody()}`;
}

/* A ring, its arc scaled to `frac` of a full turn, with a label in the middle.
   Kept as one SVG per stat so each reads on its own rather than as a chart. */
function donut(frac, color, big, small){
  const R=52, C=2*Math.PI*R, f=Math.max(0,Math.min(1,frac||0));
  return `<div class="donut">
    <svg viewBox="0 0 128 128" role="img" aria-label="${esc(small)}: ${esc(big)}">
      <circle cx="64" cy="64" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="11"/>
      <circle cx="64" cy="64" r="${R}" fill="none" stroke="${color}" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="${(C*f).toFixed(1)} ${C.toFixed(1)}"
        transform="rotate(-90 64 64)"/>
      <text x="64" y="62" text-anchor="middle" fill="var(--tx)"
        font-family="IBM Plex Mono, monospace" font-size="21" font-weight="500">${esc(big)}</text>
      <text x="64" y="81" text-anchor="middle" fill="var(--tx-3)"
        font-family="IBM Plex Sans, sans-serif" font-size="11">${esc(small)}</text>
    </svg>
  </div>`;
}

function statsRings(cl){
  const a=S.account;
  const wins=cl.filter(t=>outcomeOf(t)==="Win").length;
  const decided=cl.filter(t=>outcomeOf(t)!=="BE").length;
  const wr=decided?wins/decided*100:0;

  const byPair={};
  for(const t of cl) byPair[t.pair||"—"]=(byPair[t.pair||"—"]??0)+1;
  const top=Object.entries(byPair).sort((x,y)=>y[1]-x[1])[0];
  const share=top?top[1]/cl.length*100:0;

  const total=cl.reduce((s,t)=>s+(pctOf(t)??0),0);
  // No target to measure against any more, so the arc just gives the number a shape:
  // 10% of account fills the ring. The figure in the middle is the point.
  const frac = Math.min(1, Math.abs(total)/10);

  return `<div class="rings">
    ${donut(wr/100, "var(--up)", fx(wr,0)+"%", "win rate")}
    ${donut(share/100, "var(--blue-lift)", fx(share,0)+"%", top?top[0]:"—")}
    ${donut(frac, total>=0?"var(--up)":"var(--down)", asPct(total), "lifetime")}
  </div>`;
}

function statsBody(){
  const cl=closedTrades();
  if(!cl.length) return `<div class="blank"><h3>Nothing to measure yet</h3>
    <p class="hint" style="max-width:34ch;margin:0 auto">Once trades close, this answers the only
    question that matters: which of your models actually pays. Give it 30 trades before you
    trust the splits.</p></div>`;

  const rs=cl.map(rOf).filter(v=>v!=null);
  const wins=rs.filter(r=>r>0.02), losses=rs.filter(r=>r<-0.02);
  // Breakevens are neither won nor lost — they belong in neither half of the ratio.
  const decided=wins.length+losses.length;
  const avgW=wins.length?wins.reduce((a,b)=>a+b,0)/wins.length:0;
  const avgL=losses.length?losses.reduce((a,b)=>a+b,0)/losses.length:0;
  const exp=rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:0;
  const tot=rs.reduce((a,b)=>a+b,0);
  const totPct=cl.reduce((s,t)=>s+(pctOf(t)??0),0);
  let peak=0,cum=0,mdd=0;
  for(const r of [...cl].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(rOf)){
    if(r==null) continue; cum+=r; peak=Math.max(peak,cum); mdd=Math.min(mdd,cum-peak);
  }
  const fp=cl.filter(t=>t.followedPlan), nf=cl.filter(t=>!t.followedPlan);
  const avg=a=>{const v=a.map(rOf).filter(x=>x!=null);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null};

  const split=(key,label)=>{
    const m={};
    for(const t of cl){ const k=t[key]||"—", r=rOf(t); if(r==null) continue;
      (m[k]??={n:0,r:0,w:0}); m[k].n++; m[k].r+=r; if(r>0.02) m[k].w++; }
    const rows=Object.entries(m).sort((a,b)=>b[1].r-a[1].r);
    if(rows.length<2) return "";
    return `<div class="sec"><div class="sec-t">${label}</div><div class="scroll"><table>
      <thead><tr><th></th><th class="n">N</th><th class="n">Win</th><th class="n">Exp</th></tr></thead>
      <tbody>${rows.map(([k,v])=>`<tr><td>${esc(k)}</td><td class="n">${v.n}</td>
        <td class="n">${fx(v.w/v.n*100,0)}%</td>
        <td class="n ${tone(v.r/v.n)}">${asR(v.r/v.n)}</td></tr>`).join("")}</tbody>
    </table></div></div>`;
  };

  return `
  ${statsRings(cl)}
  <div class="metrics" style="margin-top:34px">
    <div class="metric"><div class="k">Expectancy</div>
      <div class="v ${tone(exp)}">${asR(exp)}</div><div class="x">per trade</div></div>
    <div class="metric"><div class="k">Win rate</div>
      <div class="v">${fx(decided?wins.length/decided*100:0,0)}%</div>
      <div class="x">${wins.length}W ${losses.length}L</div></div>
    <div class="metric"><div class="k">Total</div>
      <div class="v ${tone(totPct)}">${asPct(totPct)}</div><div class="x">DD ${asR(mdd)}</div></div>
    <div class="metric"><div class="k">Avg win</div><div class="v s up">${asR(avgW)}</div></div>
    <div class="metric"><div class="k">Avg loss</div><div class="v s down">${asR(avgL)}</div></div>
    <div class="metric"><div class="k">Payoff</div>
      <div class="v s">${avgL?fx(Math.abs(avgW/avgL),2):"—"}</div></div>
  </div>

  <div class="sec"><div class="sec-t">Equity curve</div>${curve(cl)}</div>

  ${(fp.length&&nf.length)?`<div class="sec">
    <div class="sec-t">Does following the plan pay?</div>
    <div class="metrics" style="grid-template-columns:1fr 1fr">
      <div class="metric"><div class="k">Followed · ${fp.length}</div>
        <div class="v s ${tone(avg(fp))}">${asR(avg(fp))}</div></div>
      <div class="metric"><div class="k">Didn't · ${nf.length}</div>
        <div class="v s ${tone(avg(nf))}">${asR(avg(nf))}</div></div>
    </div></div>`:""}

  ${split("grade","Grade")}${split("model","Entry model")}${split("pair","Pair")}
  ${split("session","Session")}${split("mentalBefore","Mental state")}`;
}

function curve(cl){
  const pts=[...cl].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(pctOf).filter(v=>v!=null);
  if(pts.length<2) return `<p class="hint">Needs two closed trades.</p>`;
  const cum=[0]; pts.forEach(r=>cum.push(cum[cum.length-1]+r));
  const W=600,H=190,L=40,R=8,T=12,B=20;
  const lo=Math.min(...cum), hi=Math.max(...cum), sp=(hi-lo)||1, pd=sp*.15;
  const yMin=lo-pd, yMax=hi+pd;
  const X=i=>L+i/(cum.length-1)*(W-L-R);
  const Y=v=>T+(1-(v-yMin)/(yMax-yMin))*(H-T-B);
  const line=cum.map((v,i)=>`${i?"L":"M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const base=Y(Math.max(yMin,Math.min(0,yMax)));
  const area=`${line} L${X(cum.length-1).toFixed(1)},${base.toFixed(1)} L${X(0).toFixed(1)},${base.toFixed(1)} Z`;
  const c=cum[cum.length-1]>=0?"#3ECF8E":"#FF6B7A";
  return `<div class="scroll"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block"
    role="img" aria-label="Cumulative account percentage across ${pts.length} closed trades, ending ${asPct(cum[cum.length-1])}">
    ${[yMax,(yMax+yMin)/2,yMin].map(v=>`
      <line x1="${L}" y1="${Y(v).toFixed(1)}" x2="${W-R}" y2="${Y(v).toFixed(1)}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>
      <text x="${L-7}" y="${(Y(v)+3.5).toFixed(1)}" text-anchor="end" fill="#5B6987"
        font-family="IBM Plex Mono, monospace" font-size="10">${v.toFixed(1)}</text>`).join("")}
    ${(yMin<0&&yMax>0)?`<line x1="${L}" y1="${Y(0).toFixed(1)}" x2="${W-R}" y2="${Y(0).toFixed(1)}"
      stroke="#5B6987" stroke-width="1" stroke-dasharray="3 3"/>`:""}
    <path d="${area}" fill="${c}" fill-opacity=".13"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(cum.length-1).toFixed(1)}" cy="${Y(cum[cum.length-1]).toFixed(1)}" r="3.5" fill="${c}"/>
  </svg></div>`;
}

function tradesBody(){
  const list=[...S.trades].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
  if(!list.length) return `<div class="blank"><h3>No trades yet</h3>
    <p class="hint">Map one from the home screen.</p></div>`;
  const g={}; for(const t of list) (g[t.date]??=[]).push(t);
  return Object.entries(g).map(([d,ts])=>{
    const r=ts.filter(t=>!isOpen(t)).reduce((s,t)=>s+(pctOf(t)??0),0);
    return `<div class="sec" style="margin-top:26px">
      <div class="rowb sec-t"><span>${esc(d)}</span><span class="num ${tone(r)}">${asPct(r)}</span></div>
      <div class="list">${ts.map(tradeItem).join("")}</div></div>`;
  }).join("");
}

/* ---------- entry models ---------- */
function screenTrade(){
  const d=S.draft, a=S.account;
  const type = ENTRY_TYPES.find(t=>t.label===d.model) || null;
  // The grade ladder is not wired to anything right now — risk is picked by hand.
  const riskPct = d.riskPct!=null ? num(d.riskPct) : null;
  const editing = !!d.id;
  const dirOf = q => typeof q==="string" ? q : (q[d.direction] || q.Long);

  return `${head(editing?"Edit trade":"Map a trade")}

  <div class="sec-t">Chart at entry — levels drawn</div>
  ${d.chartBefore
    ? `<img class="shot" data-shot="${esc(d.chartBefore)}" alt="Chart at entry">
       <button class="link" style="margin-top:10px" data-act="rmshot" data-which="chartBefore">Replace</button>`
    : `<label class="drop"><input type="file" accept="image/*" data-shot="chartBefore">
         <span>Add the screenshot</span>
         <span class="sm">Before the entry, not after</span></label>`}

  <div class="dirpick">${["Long","Short"].map(x=>
    `<button class="dir ${d.direction===x?"on":""}" data-set="direction" data-val="${x}"
      aria-pressed="${d.direction===x}">${x}</button>`).join("")}</div>

  <hr class="rule">
  <div class="sec-t">Why this entry</div>
  <p class="hint" style="margin:-8px 0 12px">Talk to yourself. Why are you actually taking this one?</p>
  <div class="field" style="margin-bottom:0">
    <textarea class="tall" data-d="entryReason"
      placeholder="What you see, and what's making you press the button.">${esc(d.entryReason)}</textarea></div>

  <hr class="rule">
  <div class="rowb" style="margin-bottom:14px">
    <div class="sec-t" style="margin:0">Before I click</div>
    <span class="hint">${(d.checks||[]).length}/${PRE_TRADE_ITEMS.length}</span>
  </div>
  ${PRE_TRADE.map(([group,items])=>`
    <div class="gategroup">
      <span class="tf">${esc(group)}</span>
      <div class="conflist">${items.map(it=>{
        const on=(d.checks||[]).includes(it.id);
        return `<button class="conf ${on?"on":""}" data-gate="${it.id}" aria-pressed="${on}">
          <span class="ctext">${esc(dirOf(it.q))}${it.why?`<span class="why">${esc(it.why)}</span>`:""}</span>
          <span class="box">${on?tickSVG:""}</span></button>`;
      }).join("")}</div>
    </div>`).join("")}

  <hr class="rule">
  <div class="field"><span class="lab">Instrument</span>
    <select data-d="pair">${Object.keys(INSTRUMENTS).map(p=>
      `<option ${d.pair===p?"selected":""}>${p}</option>`).join("")}</select></div>

  <div class="field"><span class="lab">Session${d.sessionAuto
      ? ` <span class="auto">from the clock</span>` : ""}</span>
    <div class="chips">${SESSIONS.map(x=>
      `<button class="chip" data-set="session" data-val="${x}" aria-pressed="${d.session===x}">${x}</button>`).join("")}</div></div>

  <div class="field"><span class="lab">Entry</span>
    <div class="entrytypes">${ENTRY_TYPES.map(t=>`
      <button class="etype ${d.model===t.label?"on":""}" data-etype="${esc(t.label)}"
        aria-pressed="${d.model===t.label}">
        <span class="n">${esc(t.label)}</span>
        <span class="rr">1:${t.rr}</span>
      </button>`).join("")}</div></div>

  <div class="riskpick">
    <div class="rowb" style="margin-bottom:11px">
      <span class="lab" style="margin:0">Risk on this trade</span>
      <span class="num ${riskPct?"":"down"}" style="font-size:1.15rem">${riskPct?fx(riskPct,2)+"%":"not set"}</span>
    </div>
    <div class="chips risk">${RISK_STEPS.map(v=>
      `<button class="chip" data-risk="${v}" aria-pressed="${riskPct===v}">${v}%</button>`).join("")}</div>
  </div>

  <hr class="rule">
  <div class="field"><span class="lab">Why the stop is there</span>
    <textarea data-d="slReason"
      placeholder="A place, not a pip count. What proves the idea wrong?">${esc(d.slReason)}</textarea></div>

  <div class="field"><span class="lab">How confident am I?</span>
    <div class="chips conf5">${[1,2,3,4,5].map(i=>
      `<button class="chip" data-set="confidence" data-val="${i}" aria-pressed="${+d.confidence===i}">${i}</button>`).join("")}</div></div>
  <div class="field"><span class="lab">Right now I am</span>
    <div class="chips">${MENTAL.map(x=>
      `<button class="chip" data-set="mentalBefore" data-val="${x}" aria-pressed="${d.mentalBefore===x}">${x}</button>`).join("")}</div></div>
  ${["FOMO","Revenge","Tired"].includes(d.mentalBefore)
    ? `<p class="note bad" style="margin-bottom:22px">Your own rules say that's a no-trade.</p>` : ""}
  <div class="field" style="margin-bottom:0"><span class="lab">Mental state, in your own words</span>
    <textarea data-d="mentalNotes"
      placeholder="How you're actually feeling walking into this one.">${esc(d.mentalNotes||"")}</textarea></div>

  <div class="btnrow">
    <button class="btn pri" data-act="savetrade">${editing?"Save":"Log it"}</button>
    ${editing?`<button class="btn del" data-act="deltrade" style="flex:0 0 auto;width:auto;padding-inline:22px">Delete</button>`:""}
  </div>`;
}

/* ---------- EOD: pick a trade, then write it up ---------- */

function screenEod(){
  const pending=[...needsWriteup()].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
  return `${head("End of day")}
  ${pending.length
    ? `<p class="hint" style="margin-bottom:22px">Pick one. You'll see the chart and the thesis
       exactly as you left them at entry.</p>
       <div class="list">${pending.map(tradeItem).join("")}</div>`
    : `<div class="blank"><h3>Nothing waiting</h3>
       <p class="hint">Every trade has a result. They're all in All trades.</p></div>`}`;
}

function screenAllTrades(){
  const list=[...S.trades].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
  if(!list.length) return `${head("All trades")}<div class="blank"><h3>Nothing logged yet</h3>
    <p class="hint">Map your first trade from the home screen.</p></div>`;
  const byDay={};
  for(const t of list) (byDay[t.date]??=[]).push(t);
  const total=list.reduce((s,t)=>s+(pctOf(t)??0),0);
  return `${head("All trades")}
  <div class="rowb" style="margin-bottom:22px">
    <span class="hint">${list.length} trades, lifetime</span>
    <span class="num ${tone(total)}" style="font-size:1.05rem">${asPct(total)}</span>
  </div>
  ${Object.entries(byDay).map(([d,ts])=>{
    const p=ts.reduce((s,t)=>s+(pctOf(t)??0),0);
    return `<div class="sec" style="margin-top:24px">
      <div class="rowb sec-t"><span>${esc(d)}</span><span class="num ${tone(p)}">${asPct(p)}</span></div>
      <div class="list">${ts.map(tradeItem).join("")}</div></div>`;
  }).join("")}`;
}

function screenReview(){
  const d=S.draft;
  const r=rOf(d), pct=pctOf(d);

  return `${head("Write it up", S.reviewFrom||"eod")}

  <div class="rowb" style="margin-bottom:18px">
    <div>
      <div class="nm num" style="font-size:1.1rem">${esc(d.pair)} ${esc(d.direction)}</div>
      <div class="mt">${esc(d.date)} ${esc(d.time)} · ${esc(d.session)}${d.model?" · "+esc(d.model):""}</div>
    </div>
    ${d.grade&&d.grade!=="—"?`<span class="tag">${esc(d.grade)}</span>`:""}
  </div>

  ${d.chartBefore?`<img class="shot" data-shot="${esc(d.chartBefore)}" alt="Chart at entry">
    <p class="hint" style="margin-top:8px">The chart as you saw it going in.</p>`:""}

  ${(d.entryReason||d.slReason||d.mentalNotes)?`
  <hr class="rule">
  <div class="sec-t">What you wrote at entry</div>
  <div class="said">
    ${d.entryReason?`<p><b>Entry</b> ${esc(d.entryReason)}</p>`:""}
    ${d.slReason?`<p><b>Stop</b> ${esc(d.slReason)}</p>`:""}
    ${d.mentalNotes?`<p><b>Head</b> ${esc(d.mentalNotes)}</p>`:""}
    <p><b>Confidence</b> ${esc(d.confidence)}/5</p>
  </div>`:""}

  <hr class="rule">
  <div class="sec-t">How did it close?</div>
  <div class="chips res">${RESULTS.map(x=>
    `<button class="chip ${x.k.toLowerCase()}" data-result="${x.k}" aria-pressed="${d.result===x.k}">${x.label}</button>`).join("")}</div>

  ${d.result==="TP"?`
  <div class="field" style="margin-top:20px"><span class="lab">How many percent?</span>
    <input class="n" inputmode="decimal" data-d="resultPct" value="${esc(d.resultPct??"")}" placeholder="e.g. 2.5">
    <span class="why">Of the account. ${d.riskPct?`You risked ${fx(d.riskPct,2)}%.`:""}</span></div>`:""}

  ${(d.result && d.result!=="NF")?`<div class="metrics" style="grid-template-columns:1fr 1fr;margin-top:20px">
    <div class="metric"><div class="k">Account</div><div class="v s ${tone(pct)}">${asPct(pct)}</div></div>
    <div class="metric"><div class="k">R</div><div class="v s ${tone(r)}">${asR(r)}</div></div>
  </div>
  ${d.result==="SL"?`<p class="hint" style="margin-top:12px">A full stop-out on a
    ${d.grade||"—"} setup: −1R, which was ${fx(num(d.riskPct)||0,2)}% of the account.</p>`:""}`:""}
  ${d.result==="NF"?`<p class="hint" style="margin-top:18px">The limit never filled, so nothing
    happened. It won't count toward your two trades and it stays out of the stats — but it's
    still logged, so you can see how often your entries get missed.</p>`:""}

  <hr class="rule">
  <div class="sec-t">Chart after</div>
  ${d.chartAfter
    ? `<img class="shot" data-shot="${esc(d.chartAfter)}" alt="Chart at exit">
       <button class="link" style="margin-top:10px" data-act="rmshot" data-which="chartAfter">Replace</button>`
    : `<label class="drop"><input type="file" accept="image/*" data-shot="chartAfter">
        <span>Add the aftermath</span><span class="sm">How it actually played out</span></label>`}

  <hr class="rule">
  <label class="check" style="border-top:0;padding-top:0">
    <input type="checkbox" data-dbool="followedPlan" ${d.followedPlan?"checked":""}>
    <span class="q">I followed the plan</span></label>
  <div class="field" style="margin-top:22px"><span class="lab">What went wrong</span>
    <div class="chips">${MISTAKES.map(x=>
      `<button class="chip" data-mis="${esc(x)}" aria-pressed="${(d.mistakes||[]).includes(x)}">${esc(x)}</button>`).join("")}</div></div>
  <div class="field"><span class="lab">What to watch better next time</span>
    <textarea data-d="reviewNotes" placeholder="What actually happened, and the one thing you'd do differently.">${esc(d.reviewNotes||"")}</textarea></div>

  <div class="btnrow">
    <button class="btn pri" data-act="savereview">Save write-up</button>
  </div>`;
}

/* ---------- cTrader intake ---------- */
function screenIntake(){
  const I=S.intake, all=openTrades();
  const cands=all.filter(t=>!I.symbol||t.pair===I.symbol);
  const show=cands.length?cands:all;
  return `${head("Close a trade")}
  <div class="metrics" style="margin-bottom:8px">
    <div class="metric"><div class="k">Net P&amp;L</div>
      <div class="v s ${tone(I.pnl)}">${(()=>{const sz=num(S.account.size);
        return sz ? asPct(I.pnl/sz*100) : asR(null);})()}</div></div>
    <div class="metric"><div class="k">Pips</div>
      <div class="v s">${I.pips==null?"—":fx(I.pips,1)}</div></div>
    <div class="metric"><div class="k">Lots</div>
      <div class="v s">${I.lots==null?"—":fx(I.lots,2)}</div></div>
  </div>
  <p class="hint">${esc(I.symbol||"Unknown symbol")} · ${esc(I.direction)}</p>

  ${all.length?`<div class="sec">
    <div class="sec-t">Which trade was this?</div>
    <div class="list">${show.map(tradeItem).join("")}</div>
    ${(cands.length&&cands.length<all.length)
      ? `<button class="link" style="margin-top:16px" data-act="showall">Show all ${all.length} open trades</button>`:""}
  </div>`
  :`<div class="blank"><h3>No open trades</h3>
    <p class="hint" style="max-width:32ch;margin:0 auto 18px">Nothing is waiting on an exit,
    so there's nothing to attach this to.</p>
    <button class="btn" data-act="intakenew">Log it from scratch</button></div>`}

  <button class="btn ghost" style="margin-top:26px" data-go="home">Discard</button>`;
}

/* ---------- settings ---------- */
function screenSettings(){
  const a=S.account;
  return `${head("Settings")}
  <div class="sec-t">The rule</div>
  <div class="field"><span class="lab">Trades per day</span>
    <input class="n" type="number" step="1" min="1" data-acct="maxTradesDay" value="${a.maxTradesDay??2}">
    <span class="why">The only rule the app enforces. Two exists so the question is
      "is this a master setup?" rather than "am I allowed?".</span></div>

  <hr class="rule">
  <label class="check">
    <input type="checkbox" data-testing ${S.testing?"checked":""}>
    <span class="q">Testing mode<span class="why">Lifts the trade limit so you can put trades in
      freely. This device only.</span></span></label>

  <hr class="rule">
  <div class="sec-t">Data</div>
  <p class="hint">Signed in as ${esc(S.user?.email||"—")} · ${S.trades.length} trades stored.</p>
  <button class="btn" style="margin-top:16px" data-act="export">Copy all trades as CSV</button>
  <button class="btn ghost" style="margin-top:10px" data-act="signout">Sign out</button>
  <p class="hint" style="text-align:center;margin-top:34px">Log the thesis before the outcome exists.</p>
  <p class="hint" style="text-align:center;margin-top:10px;font-size:.74rem">
    Build ${BUILD} · <button class="link" data-act="hardreload" style="font-size:.74rem">force update</button></p>`;
}

/* ========================= render ========================= */

function render(){
  const app=$("#app");
  if(!S.booted){ app.innerHTML=`<div class="spin"></div>`; return; }
  if(!S.user){ app.innerHTML=screenAuth(); return; }
  if(S.loading){ app.innerHTML=`<div class="spin"></div>`; return; }

  app.innerHTML =
      S.screen==="home"      ? screenHome()
    : S.screen==="checklist" ? screenChecklist()
    : S.screen==="dashboard" ? screenDashboard()
    : S.screen==="trade"     ? screenTrade()
    : S.screen==="eod"       ? screenEod()
    : S.screen==="alltrades" ? screenAllTrades()
    : S.screen==="review"    ? screenReview()
    : S.screen==="intake"    ? screenIntake()
    : screenSettings();

  if(!S.keepScroll) window.scrollTo(0,0);
  S.keepScroll=false;
  hydrateShots();
}
function go(s){ S.screen=s; render(); }

/* mode "now"  — mapped at the moment of entry; the clock picks the session.
   mode "eod"  — written up afterwards; the session still follows the time you type,
                 until you override it by hand. */
const newDraft = (mode="now", over={}) => ({
  id:null, mappedMode:mode,
  date:today(), time:nowHM(), session:sessionFor(new Date()), sessionAuto:true,
  pair:"XAUUSD", direction:"Long",
  model:ENTRY_TYPES[0].label, confluences:[], confidence:3, liqBuildup:false,
  entry:"", sl:"", tp:"", exit:"", pnl:"", lots:"",
  checks:[], result:null, resultPct:null, mentalNotes:"", riskPct:null,
  mentalBefore:"Calm", followedPlan:true, mistakes:[],
  entryReason:"", slReason:"", reviewNotes:"",
  chartBefore:null, chartAfter:null, hypothetical:false, ...over,
});

/* ========================= events ========================= */

document.addEventListener("submit", async e=>{
  if(e.target.id!=="authform") return;
  e.preventDefault();
  const email=$("#email").value.trim(), pw=$("#pw").value;
  S.authMsg=""; S.authBad=false;
  const {error}=await sb.auth.signInWithPassword({email,password:pw});
  if(error){ S.authBad=true; S.authMsg=authHelp(error); render(); }
});

/* Supabase's auth errors are terse and the causes are nearly always config,
   not the person typing. Say what to actually do about it. */
function authHelp(error){
  const m=(error?.message||"").toLowerCase();
  if(m.includes("rate limit") || m.includes("too many"))
    return "Too many sign-up emails were sent from this project recently. "
         + "Turn off \"Confirm email\" in the Supabase dashboard (Authentication → Sign In / Providers → Email) "
         + "and no email needs sending at all.";
  if(m.includes("signups not allowed") || m.includes("signup is disabled"))
    return "New sign-ups are switched off for this project. Turn on \"Allow new users to sign up\" "
         + "in the Supabase dashboard under Authentication → Sign In / Providers.";
  if(m.includes("not confirmed"))
    return "This account exists but the email was never confirmed. Either click the link in the "
         + "confirmation email, or turn off \"Confirm email\" in the Supabase dashboard.";
  if(m.includes("invalid login"))
    return "Wrong email or password — or the account doesn't exist yet. Use \"Create an account\" first.";
  if(m.includes("already registered") || m.includes("already been registered"))
    return "That email already has an account. Sign in instead.";
  return error?.message || "Something went wrong.";
}

document.addEventListener("click", async e=>{
  const t=e.target.closest("[data-go],[data-map],[data-act],[data-set],[data-tick],[data-gate],[data-risk],[data-etype],[data-ckdir],[data-result],[data-mis],[data-trade],[data-period],[data-dash]");
  if(!t) return;

  if(t.dataset.ckdir){ S.ckDir=t.dataset.ckdir; S.keepScroll=true; render(); return; }
  if(t.dataset.etype){
    S.draft.model = t.dataset.etype;
    S.keepScroll=true; render(); return;
  }
  if(t.dataset.risk){
    S.draft.riskPct = num(t.dataset.risk);
    S.keepScroll=true; render(); return;
  }
  if(t.dataset.gate){
    const g=t.dataset.gate, arr=S.draft.checks||[];
    S.draft.checks = arr.includes(g) ? arr.filter(x=>x!==g) : [...arr,g];
    S.keepScroll=true; render(); return;
  }
  if(t.dataset.result){
    S.draft.result = S.draft.result===t.dataset.result ? null : t.dataset.result;
    if(S.draft.result!=="TP") S.draft.resultPct=null;
    S.keepScroll=true; render(); return;
  }

  if(t.dataset.period){ S.period=t.dataset.period; S.keepScroll=true; render(); return; }
  if(t.dataset.dash){ S.dash=t.dataset.dash; render(); return; }
  if(t.dataset.map){ S.draft=newDraft(t.dataset.map); go("trade"); return; }

  if(t.dataset.go){
    const g=t.dataset.go;
    go(g); return;
  }

  if(t.dataset.trade){
    const tr=S.trades.find(x=>x.id===t.dataset.trade); if(!tr) return;
    if(S.screen==="eod" || S.screen==="alltrades" || S.screen==="dashboard"){
      S.reviewFrom = S.screen==="dashboard" ? "dashboard" : S.screen;
      S.draft={...tr}; go("review"); return;
    }
    if(S.screen==="intake"){
      const I=S.intake;
      S.draft={...tr, pnl:I.pnl, lots:I.lots??tr.lots,
        reviewNotes:tr.reviewNotes||(I.pips!=null?`Closed from cTrader · ${fx(I.pips,1)} pips`:"")};
      S.intake=null;
    } else S.draft={...tr};
    go("trade"); return;
  }
  if(t.dataset.set){
    const k=t.dataset.set;
    S.draft[k] = k==="confidence" ? +t.dataset.val : t.dataset.val;
    // Touching the session by hand means you meant it — stop deriving it from the clock.
    if(k==="session") S.draft.sessionAuto=false;
    S.keepScroll=true; render(); return;
  }
  if(t.dataset.tick){
    const c=t.dataset.tick, arr=S.draft.confluences||[];
    S.draft.confluences = arr.includes(c) ? arr.filter(x=>x!==c) : [...arr,c];
    S.keepScroll=true; render(); return;
  }
  if(t.dataset.mis){
    const m=t.dataset.mis, arr=S.draft.mistakes||[];
    S.draft.mistakes = arr.includes(m) ? arr.filter(x=>x!==m) : [...arr,m];
    S.keepScroll=true; render(); return;
  }

  switch(t.dataset.act){
    case "signup": {
      const email=$("#email").value.trim(), pw=$("#pw").value;
      if(!email||pw.length<8) return toast("Email, and a password of at least 8 characters");
      S.authMsg=""; S.authBad=false;
      const {data,error}=await sb.auth.signUp({email,password:pw});
      if(error){ S.authBad=true; S.authMsg=authHelp(error); render(); break; }
      // A user with no session means the project still requires email confirmation.
      if(data?.user && !data?.session){
        S.authBad=false;
        S.authMsg="Account created. Check your email for a confirmation link, then sign in. "
                + "To skip this step in future, turn off \"Confirm email\" in the Supabase dashboard.";
        render();
      } else toast("Account created — signing you in");
      break;
    }
    case "signout": await sb.auth.signOut(); S.user=null; S.trades=[]; render(); break;
    case "testoff": setTesting(false); render(); toast("Rules back on"); break;
    case "hardreload": {
      // Tear the service worker and its caches down, then come back from the network.
      toast("Updating…");
      try{
        const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
        await Promise.all(regs.map(r => r.unregister()));
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }catch(_){}
      location.reload();
      break;
    }
    case "liq":
      S.draft.liqBuildup=!S.draft.liqBuildup; S.keepScroll=true; render(); break;
    case "paste": await pasteCTrader(); break;
    case "resetchecks": S.checks={}; render(); break;
    case "rmshot": S.draft[t.dataset.which]=null; S.keepScroll=true; render(); break;
    case "showall": S.intake.symbol=""; render(); break;
    case "intakenew": {
      const I=S.intake;
      S.draft=newDraft("eod",{pair:I.symbol||"XAUUSD",direction:I.direction,pnl:I.pnl,lots:I.lots??""});
      S.intake=null; go("trade"); break;
    }
    case "savetrade": {
      if(S.busy) break;
      const d=S.draft, a=S.account;

      const confs=(m?.confluences||[]).filter(Boolean);
      const ticked=(d.confluences||[]).filter(c=>confs.includes(c)).length;
      const G=gradeFor(ticked);
      const risk = d.riskPct!=null ? num(d.riskPct) : G.risk;
      if(!risk) return toast("Pick the risk for this trade first");
      const body={...d, grade:G.g, riskPct:risk,
        riskUsd:(num(a.size)||0)*(risk/100),
        plannedRR:null};
      S.busy=true; t.textContent="Saving…";
      try{ await saveTrade(body); S.draft=null; go("home"); toast("Logged"); }
      catch(_){ t.textContent="Log it"; }
      finally{ S.busy=false; }
      break;
    }
    case "savereview": {
      if(S.busy) break;
      const d=S.draft;
      if(!d.result) return toast("Pick TP, BE or SL first");
      if(d.result==="TP" && num(d.resultPct)==null) return toast("How many percent was it?");
      S.busy=true; t.textContent="Saving…";
      try{ await saveTrade({...d, pnl:null}); S.draft=null;
           go(S.reviewFrom||"eod"); toast("Written up"); }
      catch(_){ t.textContent="Save write-up"; }
      finally{ S.busy=false; }
      break;
    }
    case "deltrade":
      if(!confirm("Delete this trade permanently? The bad ones are the ones worth keeping.")) break;
      await removeTrade(S.draft.id); S.draft=null; go("home"); break;
    case "export": {
      const cols=["date","time","pair","direction","session","model","grade","confluences",
        "confidence","riskPct","riskUsd","entry","sl","tp","exit","pnl","lots","plannedRR",
        "mentalBefore","followedPlan","mistakes","entryReason","slReason","reviewNotes"];
      const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
      const rows=[...S.trades].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time))
        .map(tr=>cols.map(c=>q(Array.isArray(tr[c])?tr[c].join(", "):tr[c])).concat(q(fx(rOf(tr),2))).join(","));
      try{ await navigator.clipboard.writeText([cols.concat("R").join(","),...rows].join("\n"));
           toast(`Copied ${S.trades.length} trades`); }
      catch(_){ toast("Could not reach the clipboard"); }
      break;
    }
  }
});

document.addEventListener("input", e=>{
  const el=e.target, d=S.draft;
  if(el.dataset.d!=null && d){
    d[el.dataset.d]=el.value;
    if(["date","time"].includes(el.dataset.d) && d.sessionAuto){
      const s=sessionFromFields(d.date,d.time);
      if(s && s!==d.session){ d.session=s; S.keepScroll=true; render(); return; }
    }
    if(["entry","sl","tp","pnl","exit","resultPct"].includes(el.dataset.d)){
      const k=el.dataset.d, pos=el.selectionStart;
      S.keepScroll=true; render();
      const again=document.querySelector(`[data-d="${k}"]`);
      if(again){ again.focus(); try{ again.setSelectionRange(pos,pos); }catch(_){} }
    }
    return;
  }
  if(el.dataset.m!=null && d){ d[el.dataset.m]=el.value; return; }
  if(el.dataset.conf!=null && d){ d.confluences[+el.dataset.conf]=el.value; return; }
  if(el.dataset.test!=null && d){ (d.tests??=["","","",""])[+el.dataset.test]=el.value; return; }
});

document.addEventListener("change", async e=>{
  const el=e.target;
  if(el.hasAttribute("data-testing")){ setTesting(el.checked); S.keepScroll=true; render(); return; }
  if(el.dataset.check!=null){ S.checks[+el.dataset.check]=el.checked; S.keepScroll=true; render(); return; }
  if(el.dataset.dbool!=null && S.draft){ S.draft[el.dataset.dbool]=el.checked; S.keepScroll=true; render(); return; }
  if(el.dataset.acct!=null){
    const k=el.dataset.acct;
    S.account={...S.account,[k]: k==="firm" ? el.value : (num(el.value) ?? DEFAULT_ACCOUNT[k])};
    await saveAccount(); S.keepScroll=true; render(); return;
  }
  if(el.dataset.acctbool!=null){
    S.account={...S.account,[el.dataset.acctbool]:el.checked};
    await saveAccount(); S.keepScroll=true; render(); return;
  }
  if(el.dataset.d!=null && S.draft && (el.tagName==="SELECT" || el.type==="date" || el.type==="time")){
    S.draft[el.dataset.d]=el.value;
    if(["date","time"].includes(el.dataset.d) && S.draft.sessionAuto){
      const s=sessionFromFields(S.draft.date,S.draft.time);
      if(s) S.draft.session=s;
    }
    S.keepScroll=true; render(); return;
  }
  if(el.dataset.shot!=null && S.draft){
    const f=el.files?.[0]; if(!f) return;
    el.disabled=true; toast("Uploading…");
    const path=await uploadShot(f);
    if(path){ S.draft[el.dataset.shot]=path; S.keepScroll=true; render(); }
    else el.disabled=false;
  }
});

/* ========================= boot ========================= */

sb.auth.onAuthStateChange((_e,session)=>{
  const was=S.user?.id;
  S.user=session?.user||null;
  S.booted=true;
  if(S.user && S.user.id!==was) loadAll();
  else if(!S.user) render();
});

(async ()=>{
  const {data}=await sb.auth.getSession();
  S.user=data.session?.user||null;
  S.booted=true;
  if(S.user){ if(readURLIntake()) S.screen="intake"; await loadAll(); }
  else render();
})();

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
}
