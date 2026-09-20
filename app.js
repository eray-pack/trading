/* Confluence — trading journal.
   The whole design rests on one chain: confluences ticked -> grade -> risk % -> lot size.
   Everything else is bookkeeping around that. */

"use strict";

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
  firm:"", size:50000, dailyDDPct:5, maxDDPct:10, targetPct:10,
  ownDailyStopPct:2, ownWeeklyStopPct:4,
  maxTradesDay:2, maxConsecLosses:2, minRR:2, greenLock:true,
};

const CHECKLIST = [
  ["Am I inside my session?","Outside it is a no-trade, however good it looks."],
  ["Is this one of my mapped entry models?","If you can't name it, you're improvising."],
  ["Do I have a trade left today?",""],
  ["Am I inside my daily stop?",""],
  ["How many confluences are present?","This sets the size. Not your mood."],
  ["Where is my stop, and why there?","A level, not a dollar amount."],
  ["Where is my target, and why there?","A liquidity target."],
  ["Is planned RR above my floor?",""],
  ["Screenshot taken with levels drawn?","Before entry, not after."],
  ["What is my mental state, honestly?","FOMO, revenge or tired is a no-trade."],
];

/* ========================= state ========================= */

const S = {
  user:null, booted:false, loading:true,
  screen:"home", trades:[], models:[], account:{...DEFAULT_ACCOUNT},
  period:"day", draft:null, dash:"stats", checks:{}, checkDate:"",
  intake:null, keepScroll:false, busy:false,
};

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
function rOf(t){
  const risk=num(t.riskUsd), pnl=num(t.pnl);
  if(pnl!=null && risk) return pnl/risk;
  const e=num(t.entry), s=num(t.sl), x=num(t.exit);
  if(e==null||s==null||x==null) return null;
  const d=Math.abs(e-s); if(!d) return null;
  return t.direction==="Short" ? (e-x)/d : (x-e)/d;
}
function pnlOf(t){
  const p=num(t.pnl); if(p!=null) return p;
  const r=rOf(t), risk=num(t.riskUsd);
  return (r!=null && risk) ? r*risk : null;
}
function plannedRR(t){
  const e=num(t.entry), s=num(t.sl), p=num(t.tp);
  if(e==null||s==null||p==null) return null;
  const d=Math.abs(e-s); return d ? Math.abs(p-e)/d : null;
}
function lotsFor(pair,entry,sl,riskUsd){
  const e=num(entry), s=num(sl);
  if(e==null||s==null||!riskUsd) return null;
  const I=inst(pair), pips=Math.abs(e-s)/I.pip;
  return (pips && I.pv) ? riskUsd/(pips*I.pv) : null;
}
function slPips(pair,entry,sl){
  const e=num(entry), s=num(sl);
  return (e==null||s==null) ? null : Math.abs(e-s)/inst(pair).pip;
}
const isOpen = t => num(t.pnl)==null && (t.exit==null || t.exit==="");
function outcomeOf(t){
  if(isOpen(t)) return "Open";
  const r=rOf(t); if(r==null) return "Open";
  return r>0.02 ? "Win" : r<-0.02 ? "Loss" : "BE";
}
const closedTrades = () => S.trades.filter(t=>!isOpen(t) && !t.hypothetical);
const openTrades   = () => S.trades.filter(isOpen);

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
  const todays=S.trades.filter(x=>x.date===t && !x.hypothetical);
  const done=todays.filter(x=>!isOpen(x));

  const rToday=done.reduce((s,x)=>s+(rOf(x)??0),0);
  const pnlToday=done.reduce((s,x)=>s+(pnlOf(x)??0),0);
  const pctToday=acct ? pnlToday/acct*100 : 0;

  const wk=closedTrades().filter(x=>weekStart(x.date||t)===weekStart(t));
  const pctWeek=acct ? wk.reduce((s,x)=>s+(pnlOf(x)??0),0)/acct*100 : 0;

  const seq=[...closedTrades()].sort((x,y)=>(y.date+y.time).localeCompare(x.date+x.time));
  let streak=0; for(const x of seq){ if(outcomeOf(x)==="Loss") streak++; else break; }

  const byDay={};
  for(const x of closedTrades()) byDay[x.date]=(byDay[x.date]??0)+(pnlOf(x)??0);
  let redDays=0;
  for(const d of Object.keys(byDay).sort().reverse()){ if(byDay[d]<0) redDays++; else break; }

  const blocks=[], warns=[];
  if(todays.length>=a.maxTradesDay) blocks.push(`${todays.length} trades taken. Win, lose or breakeven — you're done.`);
  if(pctToday<=-a.ownDailyStopPct)  blocks.push(`Down ${fx(pctToday,2)}% today. Your stop is −${a.ownDailyStopPct}%.`);
  if(streak>=a.maxConsecLosses)     blocks.push(`${streak} losses in a row.`);
  if(pctWeek<=-a.ownWeeklyStopPct)  blocks.push(`Down ${fx(pctWeek,2)}% this week. Flat until Monday.`);

  if(redDays>=3) warns.push(`${redDays} red days running. Take a day off, then C size only until a green day.`);
  if(a.greenLock && done.length===1 && rToday>=2) warns.push(`Trade 1 closed ${asR(rToday)}. Green-lock says stop here.`);

  return {blocks,warns,todays,done,rToday,pnlToday,pctToday,pctWeek,streak,acct};
}

function periodStats(period){
  const acct=num(S.account.size)||0;
  const ts=closedTrades().filter(t=>inPeriod(t.date,period));
  const pnl=ts.reduce((s,t)=>s+(pnlOf(t)??0),0);
  return {pct:acct?pnl/acct*100:0, pnl, r:ts.reduce((s,t)=>s+(rOf(t)??0),0), count:ts.length};
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
  hypothetical:r.hypothetical,
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
  updated_at:new Date().toISOString(),
});
const modelFromRow = r => ({
  id:r.id, name:r.name, confluences:r.confluences||[], tests:r.tests||[],
  sessions:r.sessions, pairs:r.pairs, invalidation:r.invalidation, failureMode:r.failure_mode,
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
  const [tr,md,ac] = await Promise.all([
    sb.from("trades").select("*").order("trade_date",{ascending:false}),
    sb.from("models").select("*").order("created_at"),
    sb.from("accounts").select("*").maybeSingle(),
  ]);
  if(tr.error) toast("Could not load trades"); else S.trades=(tr.data||[]).map(tradeFromRow);
  if(md.error) toast("Could not load models"); else S.models=(md.data||[]).map(modelFromRow);
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
async function saveModel(m){
  const row={user_id:S.user.id,name:m.name.trim(),
    confluences:(m.confluences||[]).map(c=>c.trim()).filter(Boolean),
    tests:(m.tests||[]).map(c=>c.trim()), sessions:m.sessions||"", pairs:m.pairs||"",
    invalidation:m.invalidation||"", failure_mode:m.failureMode||""};
  const q = m.id
    ? sb.from("models").update(row).eq("id",m.id).select().single()
    : sb.from("models").insert(row).select().single();
  const {data,error}=await q;
  if(error){ toast("Save failed: "+error.message); throw error; }
  const rec=modelFromRow(data);
  const i=S.models.findIndex(x=>x.id===rec.id);
  if(i>=0) S.models[i]=rec; else S.models.push(rec);
}
async function removeModel(id){
  const {error}=await sb.from("models").delete().eq("id",id);
  if(error) return toast("Delete failed");
  S.models=S.models.filter(m=>m.id!==id);
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
  back:'<path d="M15 18l-6-6 6-6"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
};
const ic = k => `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${PATHS[k]}</svg>`;

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
  </div>`;
}

function screenHome(){
  const G=guard(), a=S.account, P=periodStats(S.period);
  const blocked=G.blocks.length>0;
  const ck=(S.checkDate===today()) ? Object.values(S.checks).filter(Boolean).length : 0;
  const op=openTrades();

  const status = blocked
    ? `<div class="status stop"><span class="dot"></span><div><b>Done for the day.</b> ${esc(G.blocks[0])}</div></div>`
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
    <div class="herosub"><span class="num">${asR(P.r)}</span> · <span class="num">${money(P.pnl)}</span> · ${P.count} ${P.count===1?"trade":"trades"}</div>
  </div>

  ${status}

  <div class="tiles">
    <button class="tile go" data-go="map" ${blocked?"disabled":""}>
      ${ic("plus")}<span class="t">Map a trade</span>
      <span class="c">${blocked?"blocked":"thesis first"}</span>
    </button>
    <button class="tile" data-go="checklist">
      ${ic("check")}<span class="t">Checklist</span>
      <span class="c">${ck}/${CHECKLIST.length} today</span>
    </button>
    <button class="tile" data-go="dashboard">
      ${ic("chart")}<span class="t">Dashboard</span>
      <span class="c">${closedTrades().length} closed</span>
    </button>
    <button class="tile" data-go="models">
      ${ic("model")}<span class="t">Entry models</span>
      <span class="c">${S.models.length} defined</span>
    </button>
  </div>

  ${op.length?`<div class="sec">
    <div class="rowb sec-t"><span>Open — needs an exit</span>
      <button class="link" data-act="paste">Paste cTrader result</button></div>
    <div class="list">${op.map(tradeItem).join("")}</div>
  </div>`:""}

  ${(!S.models.length)?`<div class="sec">
    <p class="hint">Nothing is sizing your trades yet — an entry model is a name plus four
    confluences you can't argue yourself into.</p>
    <button class="btn" style="margin-top:14px" data-go="newmodel">Define your first model</button>
  </div>`:""}`;
}

function tradeItem(t){
  const o=outcomeOf(t), r=rOf(t);
  const c = o==="Win"?"var(--up)" : o==="Loss"?"var(--down)" : o==="BE"?"var(--tx-3)" : "var(--blue)";
  return `<button class="item" data-trade="${esc(t.id)}">
    <span class="bar" style="background:${c}"></span>
    <span class="main">
      <span class="nm">${esc(t.pair||"—")}</span>
      <span class="tag" style="margin-left:7px">${esc(t.direction||"")}</span>
      ${t.grade&&t.grade!=="—"?`<span class="tag" style="margin-left:4px">${esc(t.grade)}</span>`:""}
      <span class="mt">${esc(t.date||"")} ${esc(t.time||"")}${t.session?" · "+esc(t.session):""}${t.model?" · "+esc(t.model):""}</span>
    </span>
    <span class="val ${tone(r)}">${o==="Open"?`<span class="tag open">OPEN</span>`:asR(r)}</span>
  </button>`;
}

/* ---------- checklist ---------- */
function screenChecklist(){
  if(S.checkDate!==today()){ S.checks={}; S.checkDate=today(); }
  const a=S.account, G=guard();
  const dyn={2:`${a.maxTradesDay-G.todays.length} of ${a.maxTradesDay} left`,
             3:`${fx(G.pctToday,2)}% today, stop at −${a.ownDailyStopPct}%`,
             7:`your floor is ${a.minRR}:1`};
  const done=Object.values(S.checks).filter(Boolean).length;
  return `${head("Checklist")}
  <p class="hint" style="margin-bottom:26px">Read them out loud. It only works out loud. Resets daily.</p>
  ${CHECKLIST.map(([q,w],i)=>`
    <label class="check ${S.checks[i]?"done":""}">
      <input type="checkbox" data-check="${i}" ${S.checks[i]?"checked":""}>
      <span class="q">${esc(q)}${(dyn[i]||w)?`<span class="why">${esc(dyn[i]||w)}</span>`:""}</span>
    </label>`).join("")}
  <div style="margin-top:28px">
    ${done===CHECKLIST.length
      ? `<button class="btn pri" data-go="map">All ten clear — map the trade</button>`
      : `<p class="hint" style="text-align:center">${CHECKLIST.length-done} still unanswered</p>`}
    <button class="btn ghost" style="margin-top:12px" data-act="resetchecks">Reset</button>
  </div>`;
}

/* ---------- dashboard ---------- */
function screenDashboard(){
  return `${head("Dashboard")}
  <div class="seg" style="margin:6px 0 26px">
    <button data-dash="stats"  aria-pressed="${S.dash==="stats"}">Stats</button>
    <button data-dash="trades" aria-pressed="${S.dash==="trades"}">Trades</button>
  </div>
  ${S.dash==="stats" ? statsBody() : tradesBody()}`;
}

function statsBody(){
  const cl=closedTrades();
  if(!cl.length) return `<div class="blank"><h3>Nothing to measure yet</h3>
    <p class="hint" style="max-width:34ch;margin:0 auto">Once trades close, this answers the only
    question that matters: which of your models actually pays. Give it 30 trades before you
    trust the splits.</p></div>`;

  const rs=cl.map(rOf).filter(v=>v!=null);
  const wins=rs.filter(r=>r>0.02), losses=rs.filter(r=>r<-0.02);
  const avgW=wins.length?wins.reduce((a,b)=>a+b,0)/wins.length:0;
  const avgL=losses.length?losses.reduce((a,b)=>a+b,0)/losses.length:0;
  const exp=rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:0;
  const tot=rs.reduce((a,b)=>a+b,0);
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
  <div class="metrics">
    <div class="metric"><div class="k">Expectancy</div>
      <div class="v ${tone(exp)}">${asR(exp)}</div><div class="x">per trade</div></div>
    <div class="metric"><div class="k">Win rate</div>
      <div class="v">${fx(rs.length?wins.length/rs.length*100:0,0)}%</div>
      <div class="x">${wins.length}W ${losses.length}L</div></div>
    <div class="metric"><div class="k">Total</div>
      <div class="v ${tone(tot)}">${asR(tot)}</div><div class="x">DD ${asR(mdd)}</div></div>
    <div class="metric"><div class="k">Avg win</div><div class="v s up">${asR(avgW)}</div></div>
    <div class="metric"><div class="k">Avg loss</div><div class="v s down">${asR(avgL)}</div></div>
    <div class="metric"><div class="k">Payoff</div>
      <div class="v s">${avgL?fx(Math.abs(avgW/avgL),2):"—"}</div></div>
  </div>

  <div class="sec"><div class="sec-t">Equity curve — R</div>${curve(cl)}</div>

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
  const pts=[...cl].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(rOf).filter(v=>v!=null);
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
  const c=cum[cum.length-1]>=0?"#5B9BFF":"#FF6B7A";
  return `<div class="scroll"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block"
    role="img" aria-label="Cumulative R across ${pts.length} closed trades, ending ${asR(cum[cum.length-1])}">
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
    const r=ts.filter(t=>!isOpen(t)).reduce((s,t)=>s+(rOf(t)??0),0);
    return `<div class="sec" style="margin-top:26px">
      <div class="rowb sec-t"><span>${esc(d)}</span><span class="num ${tone(r)}">${asR(r)}</span></div>
      <div class="list">${ts.map(tradeItem).join("")}</div></div>`;
  }).join("");
}

/* ---------- entry models ---------- */
function screenModels(){
  return `${head("Entry models")}
  <p class="hint" style="margin-bottom:24px">Four confluences each, binary and objective.
  If one needs a paragraph to evaluate, it isn't a confluence — it's a feeling.</p>
  ${S.models.length?`<div class="list">${S.models.map(m=>`
    <button class="item" data-model="${esc(m.id)}">
      <span class="bar" style="background:var(--blue)"></span>
      <span class="main"><span class="nm">${esc(m.name)}</span>
      <span class="mt">${(m.confluences||[]).filter(Boolean).join(" · ")||"no confluences set"}</span></span>
    </button>`).join("")}</div>`:""}
  <button class="btn" style="margin-top:22px" data-go="newmodel">Add an entry model</button>`;
}

function screenModelEdit(){
  const d=S.draft;
  return `${head(d.id?"Edit model":"New entry model","models")}
  <div class="field"><span class="lab">Name</span>
    <input type="text" data-m="name" value="${esc(d.name)}" placeholder="London sweep reversal"></div>
  <div class="two" style="margin-bottom:22px">
    <div class="field"><span class="lab">Sessions</span>
      <input type="text" data-m="sessions" value="${esc(d.sessions||"")}" placeholder="London"></div>
    <div class="field"><span class="lab">Pairs</span>
      <input type="text" data-m="pairs" value="${esc(d.pairs||"")}" placeholder="XAUUSD"></div>
  </div>
  <hr class="rule">
  <div class="sec-t">The four confluences</div>
  ${[0,1,2,3].map(i=>`
    <div class="field" style="margin-bottom:10px"><span class="lab">${i+1}</span>
      <input type="text" data-conf="${i}" value="${esc(d.confluences[i]||"")}" placeholder="What must be present"></div>
    <div class="field"><input type="text" data-test="${i}" value="${esc((d.tests||[])[i]||"")}"
      placeholder="The objective test — no judgement call"></div>`).join("")}
  <p class="note">4 = A+ · 1.00%   3 = B · 0.50%   2 = C · 0.25%   under 2 = no trade</p>
  <hr class="rule">
  <div class="field"><span class="lab">Invalidation — when NOT to take it</span>
    <textarea data-m="invalidation" placeholder="Conditions that kill an otherwise valid setup.">${esc(d.invalidation||"")}</textarea></div>
  <div class="field"><span class="lab">Known failure mode</span>
    <textarea data-m="failureMode" placeholder="Every model has a signature loss. What's this one's?">${esc(d.failureMode||"")}</textarea></div>
  <div class="btnrow">
    <button class="btn pri" data-act="savemodel">Save</button>
    ${d.id?`<button class="btn del" data-act="delmodel" style="flex:0 0 auto;width:auto;padding-inline:22px">Delete</button>`:""}
  </div>`;
}

/* ---------- map / edit a trade ---------- */
function screenTrade(){
  const d=S.draft, a=S.account;
  const m=S.models.find(x=>x.name===d.model);
  const confs=(m?.confluences||[]).filter(Boolean);
  const ticked=(d.confluences||[]).filter(c=>confs.includes(c)).length;
  const G=gradeFor(ticked);
  const riskUsd = d.hypothetical ? 0 : (num(a.size)||0)*(G.risk/100);
  const lots=lotsFor(d.pair,d.entry,d.sl,riskUsd);
  const pips=slPips(d.pair,d.entry,d.sl);
  const rr=plannedRR(d), rrOk = rr==null || rr>=a.minRR;
  const editing=!!d.id, r=rOf(d);

  return `${head(editing?(isOpen(d)?"Close trade":"Edit trade"):"Map a trade")}

  <div class="field"><span class="lab">Instrument</span>
    <select data-d="pair">${Object.keys(INSTRUMENTS).map(p=>
      `<option ${d.pair===p?"selected":""}>${p}</option>`).join("")}</select></div>

  <div class="field"><span class="lab">Direction</span>
    <div class="chips">${["Long","Short"].map(x=>
      `<button class="chip" data-set="direction" data-val="${x}" aria-pressed="${d.direction===x}">${x}</button>`).join("")}</div></div>

  <div class="field"><span class="lab">Session</span>
    <div class="chips">${SESSIONS.map(x=>
      `<button class="chip" data-set="session" data-val="${x}" aria-pressed="${d.session===x}">${x}</button>`).join("")}</div></div>

  <div class="field"><span class="lab">Entry model</span>
    <select data-d="model"><option value="">—</option>
      ${S.models.map(x=>`<option ${d.model===x.name?"selected":""}>${esc(x.name)}</option>`).join("")}
    </select></div>

  <div class="two" style="margin-bottom:22px">
    <div class="field"><span class="lab">Date</span><input type="date" data-d="date" value="${esc(d.date)}"></div>
    <div class="field"><span class="lab">Time</span><input type="time" data-d="time" value="${esc(d.time)}"></div>
  </div>

  <hr class="rule">
  <div class="sec-t">Confluences — these set your size, not your conviction</div>
  ${confs.length
    ? `<div class="chips">${confs.map(c=>`<button class="chip" data-tick="${esc(c)}"
        aria-pressed="${(d.confluences||[]).includes(c)}">${esc(c)}</button>`).join("")}</div>`
    : `<p class="note bad">Pick an entry model first — its confluences are what size the trade.</p>`}

  <div class="grade">
    <span class="glyph ${G.cls}">${G.g}</span>
    <div style="flex:1;min-width:0">
      <div class="rowb"><span class="hint">Risk</span>
        <span class="num">${G.risk?`${fx(G.risk,2)}% · ${money(riskUsd)}`:"—"}</span></div>
      <div class="bars">${[0,1,2,3].map(i=>`<i class="${i<ticked?"on":""}"></i>`).join("")}</div>
      <p class="hint" style="margin-top:10px">${G.note}</p>
    </div>
  </div>

  <hr class="rule">
  <div class="three" style="margin-bottom:20px">
    <div class="field"><span class="lab">Entry</span>
      <input class="n" inputmode="decimal" data-d="entry" value="${esc(d.entry??"")}"></div>
    <div class="field"><span class="lab">Stop</span>
      <input class="n" inputmode="decimal" data-d="sl" value="${esc(d.sl??"")}"></div>
    <div class="field"><span class="lab">Target</span>
      <input class="n" inputmode="decimal" data-d="tp" value="${esc(d.tp??"")}"></div>
  </div>
  <div class="metrics">
    <div class="metric"><div class="k">Stop</div>
      <div class="v s">${pips==null?"—":fx(pips,1)}</div><div class="x">pips</div></div>
    <div class="metric"><div class="k">Planned RR</div>
      <div class="v s ${rr==null?"":rrOk?"up":"down"}">${rr==null?"—":fx(rr,2)}</div></div>
    <div class="metric"><div class="k">Lots</div>
      <div class="v s">${lots==null?"—":fx(lots,2)}</div></div>
  </div>
  ${(rr!=null&&!rrOk)?`<p class="note bad" style="margin-top:18px">
    ${fx(rr,2)}:1 is under your ${a.minRR}:1 floor. That's a no-trade.</p>`:""}

  <hr class="rule">
  <div class="sec-t">Why — written now, while you still don't know the answer</div>
  <div class="field"><span class="lab">Why this entry</span>
    <textarea data-d="entryReason" placeholder="What on the chart puts you in here.">${esc(d.entryReason)}</textarea></div>
  <div class="field"><span class="lab">Why the stop is there</span>
    <textarea data-d="slReason" placeholder="A place, not a pip count. What proves the idea wrong?">${esc(d.slReason)}</textarea></div>
  <div class="field"><span class="lab">Why the target is there</span>
    <textarea data-d="tpReason" placeholder="Which liquidity are you aiming at?">${esc(d.tpReason)}</textarea></div>

  <hr class="rule">
  <div class="field"><span class="lab">Confidence</span>
    <div class="chips">${[1,2,3,4,5].map(i=>
      `<button class="chip" data-set="confidence" data-val="${i}" aria-pressed="${+d.confidence===i}">${i}</button>`).join("")}</div></div>
  <div class="field"><span class="lab">Mental state</span>
    <div class="chips">${MENTAL.map(x=>
      `<button class="chip" data-set="mentalBefore" data-val="${x}" aria-pressed="${d.mentalBefore===x}">${x}</button>`).join("")}</div></div>
  ${["FOMO","Revenge","Tired"].includes(d.mentalBefore)
    ? `<p class="note bad">Your own rules say that's a no-trade.</p>` : ""}

  <hr class="rule">
  <div class="sec-t">Chart before</div>
  ${d.chartBefore
    ? `<img class="shot" data-shot="${esc(d.chartBefore)}" alt="Chart at entry">
       <button class="link" style="margin-top:10px" data-act="rmshot" data-which="chartBefore">Remove</button>`
    : `<input type="file" accept="image/*" data-shot="chartBefore">`}
  ${editing?`<div class="sec-t" style="margin-top:24px">Chart after</div>
    ${d.chartAfter
      ? `<img class="shot" data-shot="${esc(d.chartAfter)}" alt="Chart at exit">
         <button class="link" style="margin-top:10px" data-act="rmshot" data-which="chartAfter">Remove</button>`
      : `<input type="file" accept="image/*" data-shot="chartAfter">`}`:""}

  ${editing?`
  <hr class="rule">
  <div class="sec-t">Outcome</div>
  <div class="two" style="margin-bottom:20px">
    <div class="field"><span class="lab">Net P&amp;L</span>
      <input class="n" inputmode="decimal" data-d="pnl" value="${esc(d.pnl??"")}" placeholder="from cTrader"></div>
    <div class="field"><span class="lab">Exit price</span>
      <input class="n" inputmode="decimal" data-d="exit" value="${esc(d.exit??"")}"></div>
  </div>
  ${r!=null?`<div class="metrics" style="grid-template-columns:1fr 1fr;margin-bottom:20px">
    <div class="metric"><div class="k">Result</div><div class="v s ${tone(r)}">${asR(r)}</div></div>
    <div class="metric"><div class="k">P&amp;L</div><div class="v s ${tone(r)}">${money(pnlOf(d))}</div></div>
  </div>`:""}
  <label class="check" style="border-top:0">
    <input type="checkbox" data-dbool="followedPlan" ${d.followedPlan?"checked":""}>
    <span class="q">I followed the plan</span></label>
  <div class="field" style="margin-top:22px"><span class="lab">What went wrong</span>
    <div class="chips">${MISTAKES.map(x=>
      `<button class="chip" data-mis="${esc(x)}" aria-pressed="${(d.mistakes||[]).includes(x)}">${esc(x)}</button>`).join("")}</div></div>
  <div class="field"><span class="lab">Review notes</span>
    <textarea data-d="reviewNotes" placeholder="What actually happened, and what you'd do differently.">${esc(d.reviewNotes)}</textarea></div>`:""}

  <div class="btnrow">
    <button class="btn pri" data-act="savetrade">${editing?"Save":"Log it"}</button>
    ${editing?`<button class="btn del" data-act="deltrade" style="flex:0 0 auto;width:auto;padding-inline:22px">Delete</button>`:""}
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
      <div class="v s ${tone(I.pnl)}">${money(I.pnl)}</div></div>
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
  const f=(k,l,step="any")=>`<div class="field"><span class="lab">${l}</span>
    <input class="n" type="number" step="${step}" data-acct="${k}" value="${a[k]??""}"></div>`;
  return `${head("Settings")}
  <div class="sec-t">Account</div>
  <div class="field"><span class="lab">Prop firm</span>
    <input type="text" data-acct="firm" value="${esc(a.firm||"")}" placeholder="FTMO"></div>
  ${f("size","Account size","1")}
  <div class="three" style="margin-bottom:22px">
    ${f("dailyDDPct","Firm daily %")}${f("maxDDPct","Firm max %")}${f("targetPct","Target %")}
  </div>
  <p class="note">Stopping at ${a.ownDailyStopPct}% against a ${a.dailyDDPct}% firm limit leaves
    ${fx(a.dailyDDPct-a.ownDailyStopPct,1)}% for slippage, gaps, and being wrong about your own discipline.</p>

  <hr class="rule">
  <div class="sec-t">Your rules</div>
  <div class="two" style="margin-bottom:22px">${f("ownDailyStopPct","Daily stop %")}${f("ownWeeklyStopPct","Weekly stop %")}</div>
  <div class="three" style="margin-bottom:22px">
    ${f("maxTradesDay","Trades/day","1")}${f("maxConsecLosses","Losses in a row","1")}${f("minRR","Min RR","0.1")}
  </div>
  <label class="check">
    <input type="checkbox" data-acctbool="greenLock" ${a.greenLock?"checked":""}>
    <span class="q">Green-lock<span class="why">Stop for the day if trade 1 closes +2R or better</span></span></label>

  <hr class="rule">
  <div class="sec-t">Data</div>
  <p class="hint">Signed in as ${esc(S.user?.email||"—")} · ${S.trades.length} trades stored.</p>
  <button class="btn" style="margin-top:16px" data-act="export">Copy all trades as CSV</button>
  <button class="btn ghost" style="margin-top:10px" data-act="signout">Sign out</button>
  <p class="hint" style="text-align:center;margin-top:34px">Log the thesis before the outcome exists.</p>`;
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
    : S.screen==="models"    ? screenModels()
    : S.screen==="modeledit" ? screenModelEdit()
    : S.screen==="trade"     ? screenTrade()
    : S.screen==="intake"    ? screenIntake()
    : screenSettings();

  if(!S.keepScroll) window.scrollTo(0,0);
  S.keepScroll=false;
  hydrateShots();
}
function go(s){ S.screen=s; render(); }

const newDraft = (over={}) => ({
  id:null, date:today(), time:nowHM(), pair:"XAUUSD", direction:"Long", session:"London",
  model:S.models[0]?.name||"", confluences:[], confidence:3,
  entry:"", sl:"", tp:"", exit:"", pnl:"", lots:"",
  mentalBefore:"Calm", followedPlan:true, mistakes:[],
  entryReason:"", slReason:"", tpReason:"", reviewNotes:"",
  chartBefore:null, chartAfter:null, hypothetical:false, ...over,
});

/* ========================= events ========================= */

document.addEventListener("submit", async e=>{
  if(e.target.id!=="authform") return;
  e.preventDefault();
  const email=$("#email").value.trim(), pw=$("#pw").value;
  const {error}=await sb.auth.signInWithPassword({email,password:pw});
  if(error) toast(error.message);
});

document.addEventListener("click", async e=>{
  const t=e.target.closest("[data-go],[data-act],[data-set],[data-tick],[data-mis],[data-trade],[data-model],[data-period],[data-dash]");
  if(!t) return;

  if(t.dataset.period){ S.period=t.dataset.period; S.keepScroll=true; render(); return; }
  if(t.dataset.dash){ S.dash=t.dataset.dash; render(); return; }

  if(t.dataset.go){
    const g=t.dataset.go;
    if(g==="map"){ S.draft=newDraft(); go("trade"); return; }
    if(g==="newmodel"){
      S.draft={id:null,name:"",confluences:["","","",""],tests:["","","",""],
               sessions:"",pairs:"",invalidation:"",failureMode:""};
      go("modeledit"); return;
    }
    go(g); return;
  }

  if(t.dataset.trade){
    const tr=S.trades.find(x=>x.id===t.dataset.trade); if(!tr) return;
    if(S.screen==="intake"){
      const I=S.intake;
      S.draft={...tr, pnl:I.pnl, lots:I.lots??tr.lots,
        reviewNotes:tr.reviewNotes||(I.pips!=null?`Closed from cTrader · ${fx(I.pips,1)} pips`:"")};
      S.intake=null;
    } else S.draft={...tr};
    go("trade"); return;
  }
  if(t.dataset.model){
    const m=S.models.find(x=>x.id===t.dataset.model); if(!m) return;
    S.draft={...m, confluences:[...(m.confluences||[]),"","","",""].slice(0,4),
                   tests:[...(m.tests||[]),"","","",""].slice(0,4)};
    go("modeledit"); return;
  }
  if(t.dataset.set){
    const k=t.dataset.set;
    S.draft[k] = k==="confidence" ? +t.dataset.val : t.dataset.val;
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
      const {error}=await sb.auth.signUp({email,password:pw});
      if(error) toast(error.message);
      else toast("Account created — signing you in");
      break;
    }
    case "signout": await sb.auth.signOut(); S.user=null; S.trades=[]; S.models=[]; render(); break;
    case "paste": await pasteCTrader(); break;
    case "resetchecks": S.checks={}; render(); break;
    case "rmshot": S.draft[t.dataset.which]=null; S.keepScroll=true; render(); break;
    case "showall": S.intake.symbol=""; render(); break;
    case "intakenew": {
      const I=S.intake;
      S.draft=newDraft({pair:I.symbol||"XAUUSD",direction:I.direction,pnl:I.pnl,lots:I.lots??""});
      S.intake=null; go("trade"); break;
    }
    case "savetrade": {
      if(S.busy) break;
      const d=S.draft, a=S.account;
      const m=S.models.find(x=>x.name===d.model);
      const confs=(m?.confluences||[]).filter(Boolean);
      const ticked=(d.confluences||[]).filter(c=>confs.includes(c)).length;
      const G=gradeFor(ticked);
      const body={...d, grade:G.g, riskPct:G.risk,
        riskUsd: d.riskUsd ?? (num(a.size)||0)*(G.risk/100),
        plannedRR:plannedRR(d)};
      S.busy=true; t.textContent="Saving…";
      try{ await saveTrade(body); S.draft=null; go("home"); toast("Logged"); }
      catch(_){ t.textContent="Log it"; }
      finally{ S.busy=false; }
      break;
    }
    case "deltrade":
      if(!confirm("Delete this trade permanently? The bad ones are the ones worth keeping.")) break;
      await removeTrade(S.draft.id); S.draft=null; go("home"); break;
    case "savemodel": {
      if(!S.draft.name.trim()) return toast("Give the model a name");
      try{ await saveModel(S.draft); S.draft=null; go("models"); toast("Saved"); }catch(_){}
      break;
    }
    case "delmodel":
      if(!confirm("Delete this model? Logged trades keep their model name.")) break;
      await removeModel(S.draft.id); S.draft=null; go("models"); break;
    case "export": {
      const cols=["date","time","pair","direction","session","model","grade","confluences",
        "confidence","riskPct","riskUsd","entry","sl","tp","exit","pnl","lots","plannedRR",
        "mentalBefore","followedPlan","mistakes","entryReason","slReason","tpReason","reviewNotes"];
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
    if(["entry","sl","tp","pnl","exit"].includes(el.dataset.d)){
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
  if(el.dataset.d!=null && el.tagName==="SELECT" && S.draft){
    S.draft[el.dataset.d]=el.value; S.keepScroll=true; render(); return;
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
