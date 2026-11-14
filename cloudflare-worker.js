// FIT-CONNECT Cloudflare preview: read-only Supabase endpoint
// (daily record read, trainer password check, trainer dashboard summary,
// workout history calendar).
// Writes continue to use the existing Apps Script backend.
//
// Member links: Apps Script stays the only judge of member tokens. The page
// asks for a short-lived "member session" (action memberSession); the Worker
// checks the token by asking Apps Script itself, then signs
// {member, expiry} with MEMBER_SESSION_SECRET. That session can only read that
// one member's daily record and workout history. A rotated link is refused by
// Apps Script immediately, and any session made before it expires within
// MEMBER_SESSION_HOURS.
const APPS_SCRIPT_URL='https://script.google.com/macros/s/AKfycby63-Ky8FNZSxZdX1fa5cvIP3CgW0A9x5YEHQQXfc8NRJ6gqm79pH6T78ib14nHpsqs/exec';
const MEMBER_SESSION_HOURS=8;
const MEMBER_ACTIONS=['read','workoutHistory'];
const b64url={
  encode:bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),
  decode:text=>{
    const s=String(text).replace(/-/g,'+').replace(/_/g,'/');
    const bin=atob(s+'='.repeat((4-s.length%4)%4));
    return Uint8Array.from(bin,c=>c.charCodeAt(0));
  }
};
async function sessionKey(secret) {
  return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),
    {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
async function signMemberSession(secret,member) {
  const exp=Date.now()+MEMBER_SESSION_HOURS*3600000;
  const payload=b64url.encode(new TextEncoder().encode(JSON.stringify({m:member,exp})));
  const sig=new Uint8Array(await crypto.subtle.sign('HMAC',await sessionKey(secret),
    new TextEncoder().encode('fit-member-v1.'+payload)));
  return {session:payload+'.'+b64url.encode(sig),exp};
}
// Returns the member name inside a valid, unexpired session, or ''.
async function readMemberSession(secret,session) {
  try {
    const [payload,sig,extra]=String(session||'').split('.');
    if(!payload||!sig||extra!==undefined||session.length>1000)return '';
    const ok=await crypto.subtle.verify('HMAC',await sessionKey(secret),b64url.decode(sig),
      new TextEncoder().encode('fit-member-v1.'+payload));
    if(!ok)return '';
    const data=JSON.parse(new TextDecoder().decode(b64url.decode(payload)));
    if(typeof data?.m!=='string'||!data.m||typeof data.exp!=='number'||data.exp<Date.now())return '';
    return data.m;
  }catch{return '';}
}
// Asks Apps Script whether this member link is valid, the same way the page
// reads a member's day. Anything other than a clean JSON record means "no".
async function appsScriptAcceptsMember(member,token,date) {
  const url=APPS_SCRIPT_URL+'?member='+encodeURIComponent(member)+'&date='+date+
    '&token='+encodeURIComponent(token)+'&_t='+Date.now();
  const response=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(10000)});
  if(!response.ok)return false;
  let body;
  try{body=await response.json();}catch{return false;}
  return !!body&&typeof body==='object'&&!Array.isArray(body)&&
    body.status!=='error'&&body.status!=='denied';
}
const json=(body,status=200,extra={})=>new Response(JSON.stringify(body),{
  status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',...extra}
});
function constantTimeEquals(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;
  const encoder=new TextEncoder();
  const x=encoder.encode(a),y=encoder.encode(b);
  let difference=x.length^y.length;
  const count=Math.max(x.length,y.length);
  for(let i=0;i<count;i++)difference|=(x[i]||0)^(y[i]||0);
  return difference===0;
}
function validDay(v) {
  if(typeof v!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v))return false;
  const date=new Date(v+'T00:00:00Z');
  return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===v;
}
const memberCache=new Map();
function rememberMember(name,id) {
  memberCache.delete(name);
  memberCache.set(name,{id,timestamp:Date.now()});
  if(memberCache.size>256)memberCache.delete(memberCache.keys().next().value);
}
function shiftDay(day,offset) {
  const d=new Date(day+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+offset);
  return d.toISOString().slice(0,10);
}
// Read-only trainer dashboard summary. It only looks at a recent window so the
// response stays small; the page always replaces it with the canonical
// Apps Script overview (which also carries video counts) once that arrives.
const OVERVIEW_WINDOW_DAYS=45;
async function buildOverview(supaGet,date) {
  const weekStart=shiftDay(date,-6),windowStart=shiftDay(date,-OVERVIEW_WINDOW_DAYS);
  const pageSize=1000;
  const prefix='/rest/v1/fit_daily_records?select=member_id,record_date,'+
    'routines:data->routines,reflection:data->reflection,diet:data->diet,feedback:data->feedback'+
    '&record_date=gte.'+windowStart+'&record_date=lte.'+date+
    '&order=record_date.desc&limit='+pageSize;
  const [allMembers,firstPage]=await Promise.all([
    supaGet('/rest/v1/fit_members?select=id,name&order=name.asc&limit=1000','overview'),
    supaGet(prefix+'&offset=0','overview')
  ]);
  if(allMembers.length===1000)throw Error('too many members for overview');
  const result=new Map();
  for(const row of allMembers) {
    rememberMember(String(row.name),row.id);
    result.set(row.id,{name:row.name,lastDate:'',activeToday:false,
      pendingWorkout:false,pendingDiet:false,pendingVideos:0,feedbackDone:false,
      workoutToday:false,dietToday:false,
      _w:new Set(),_d:new Set(),_r:new Set(),_a:new Set()});
  }
  let records=firstPage,offset=0;
  while(true) {
    for(const record of records) {
      const item=result.get(record.member_id);
      if(!item)continue;
      const day=String(record.record_date||'');
      const routines=Array.isArray(record.routines)?record.routines:[];
      const completed=routines.some(r=>Array.isArray(r?.completedSets)&&r.completedSets.some(Boolean));
      const reflection=!!String((record.reflection?.good||'')+(record.reflection?.bad||'')).trim();
      const diet=record.diet||{};
      const hasDiet=['breakfast','lunch','dinner','snack'].some(k=>{
        const food=diet[k]||{};
        return !!String(food.desc||'').trim()||
          (Array.isArray(food.photos)&&food.photos.length>0)||
          (Array.isArray(food.foods)&&food.foods.length>0);
      });
      const active=completed||reflection||hasDiet;
      if(day>=weekStart&&day<=date) {
        if(completed)item._w.add(day);
        if(hasDiet)item._d.add(day);
        if(reflection)item._r.add(day);
        if(active)item._a.add(day);
      }
      if(active&&day>item.lastDate)item.lastDate=day;
      if(day===date) {
        item.activeToday||=active;
        item.workoutToday||=completed;
        item.dietToday||=hasDiet;
        const feedback=record.feedback||{};
        const fw=!!String(feedback.workout||'').trim(),fd=!!String(feedback.diet||'').trim();
        item.pendingWorkout||=(completed||reflection)&&!fw;
        item.pendingDiet||=hasDiet&&!fd;
        item.feedbackDone||=fw||fd;
      }
    }
    if(records.length<pageSize)break;
    offset+=pageSize;
    if(offset>=10000)throw Error('overview pagination limit exceeded');
    records=await supaGet(prefix+'&offset='+offset);
  }
  const members=[...result.values()].map(item=>{
    const {_w,_d,_r,_a,...rest}=item;
    return {...rest,weeklyWorkoutDays:_w.size,weeklyDietDays:_d.size,
      weeklyReflectionDays:_r.size,weeklyActiveDays:_a.size};
  });
  return {status:'success',date,weekStart,members,partial:true,windowDays:OVERVIEW_WINDOW_DAYS};
}
// Workout history for the habit calendar and "previous record" hints.
// Same rules as api/records.js buildWorkoutHistory: a day counts when any set
// is completed; "previous" is the latest completed entry per exercise name
// strictly before the selected date. Only the routines field is fetched.
async function buildWorkoutHistory(supaGet,memberId,date,month) {
  const pageSize=1000;
  const prefix='/rest/v1/fit_daily_records?select=record_date,routines:data->routines'+
    '&member_id=eq.'+encodeURIComponent(memberId)+'&record_date=lte.'+date+
    '&order=record_date.desc&limit='+pageSize;
  const days=new Set(),previous={};
  for(let offset=0;;offset+=pageSize) {
    if(offset>=10000)throw Error('history pagination limit exceeded');
    const rows=await supaGet(prefix+'&offset='+offset,'history');
    // Rows arrive newest first, so the first hit per name is the latest one.
    for(const row of rows) {
      const day=String(row.record_date||'');
      const done=(Array.isArray(row.routines)?row.routines:[])
        .filter(r=>Array.isArray(r?.completedSets)&&r.completedSets.some(Boolean));
      if(!done.length)continue;
      if(day.startsWith(month))days.add(day);
      if(day>=date)continue;
      for(const r of done) {
        const name=String(r.name||'').trim().toLowerCase();
        if(name&&!previous[name])previous[name]={date:day,weight:String(r.weight||''),reps:String(r.reps||'')};
      }
    }
    if(rows.length<pageSize)break;
  }
  return {status:'success',month,days:[...days].sort(),previous};
}
async function handleRecords(request,env) {
  if(request.method!=='POST')return json({status:'error',code:'method_not_allowed'},405);
  if(Number(request.headers.get('content-length')||0)>16384)
    return json({status:'error',code:'too_large'},413);
  let input;
  try{input=await request.json();}catch{return json({status:'error',code:'invalid_json'},400);}
  const action=input?.action;
  if(!['read','verify','trainerOverview','workoutHistory','memberSession'].includes(action))
    return json({status:'error',code:'read_only'},405);
  const member=String(input.member||'').trim(),date=input.date;
  const sessionSecret=String(env.MEMBER_SESSION_SECRET||'');
  // Member path: either exchange a member link for a session, or use a session.
  if(action==='memberSession'||(input.session!==undefined&&input.password===undefined)) {
    if(sessionSecret.length<32)
      return json({status:'error',code:'missing_runtime_configuration'},503);
    if(action==='memberSession') {
      const token=String(input.token||'');
      if(!member||member.length>100||!token||token.length>200||!validDay(date))
        return json({status:'error',code:'invalid_query'},400);
      let accepted=false;
      try{accepted=await appsScriptAcceptsMember(member,token,date);}
      catch{return json({status:'error',code:'apps_script_unreachable'},502);}
      if(!accepted)return json({status:'denied',code:'unauthorized'},403);
      return json({status:'success',...await signMemberSession(sessionSecret,member)});
    }
    if(!MEMBER_ACTIONS.includes(action))return json({status:'denied',code:'unauthorized'},403);
    const sessionMember=await readMemberSession(sessionSecret,input.session);
    if(!sessionMember||sessionMember!==member)
      return json({status:'denied',code:'session_invalid'},403);
  } else {
    if(!env.TRAINER_PASSWORD)
      return json({status:'error',code:'missing_runtime_configuration'},503);
    if(!constantTimeEquals(input.password,env.TRAINER_PASSWORD))
      return json({status:'denied',code:'unauthorized'},403);
    if(action==='verify')return json({status:'success'});
  }
  const needsMember=action==='read'||action==='workoutHistory';
  if(!validDay(date)||(needsMember&&(!member||member.length>100)))
    return json({status:'error',code:'invalid_query'},400);
  const month=input.month===undefined||input.month===''?date.slice(0,7):input.month;
  if(action==='workoutHistory'&&(typeof month!=='string'||!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month)))
    return json({status:'error',code:'invalid_query'},400);
  const base=String(env.SUPABASE_URL||'').trim().replace(/\/+$/,'');
  const key=String(env.SUPABASE_SECRET_KEY||'').trim();
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)||!key)
    return json({status:'error',code:'missing_runtime_configuration'},503);
  // Failure details are limited to the query step, HTTP status and Supabase's own
  // short error text. Never include the URL, key, password or member data.
  let step='start';
  const clean=v=>String(v||'').replace(/[^A-Za-z0-9 _.:-]/g,' ').replace(/ +/g,' ').trim().slice(0,90);
  const supaGet=async(path,label)=>{
    step=label||step;
    const response=await fetch(base+path,{
      headers:{apikey:key,Accept:'application/json'},
      signal:AbortSignal.timeout(8000)
    });
    if(!response.ok) {
      let detail='';
      try{const body=await response.json();detail=clean(body?.message||body?.error||body?.code);}catch{}
      const error=Error('Supabase HTTP '+response.status);
      error.diagnostic=response.status+(detail?':'+detail:'');
      throw error;
    }
    return response.json();
  };
  const failed=error=>json({status:'error',
    code:'supabase_read_failed:'+step+':'+(error?.diagnostic||clean(error?.name||'error'))},502);
  const start=performance.now();
  if(action==='trainerOverview') {
    try {
      const overview=await buildOverview(supaGet,date);
      return json(overview,200,{
        'Server-Timing':'overview;dur='+(performance.now()-start).toFixed(1),
        'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
      });
    }catch(error){
      return failed(error);
    }
  }
  try {
    const cached=memberCache.get(member);
    let memberId;
    if(cached && Date.now()-cached.timestamp<600000) memberId=cached.id;
    else {
      const matches=await supaGet('/rest/v1/fit_members?select=id&name=eq.'+
        encodeURIComponent(member)+'&limit=1','member');
      if(matches.length!==1)return json({status:'denied',code:'member_not_found'},403);
      memberId=matches[0].id;
      rememberMember(member,memberId);
    }
    const lookupMs=performance.now()-start;
    if(action==='workoutHistory') {
      const history=await buildWorkoutHistory(supaGet,memberId,date,month);
      return json(history,200,{
        'Server-Timing':'member;dur='+lookupMs.toFixed(1)+
          ', history;dur='+(performance.now()-start-lookupMs).toFixed(1),
        'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
      });
    }
    const daily=await supaGet('/rest/v1/fit_daily_records?select=data&member_id=eq.'+
      encodeURIComponent(memberId)+'&record_date=eq.'+date+'&limit=1','daily');
    return json(daily.length?daily[0].data:{},200,{
      'Server-Timing':'member;dur='+lookupMs.toFixed(1)+
        ', daily;dur='+(performance.now()-start-lookupMs).toFixed(1),
      'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
    });
  }catch(error){
    return failed(error);
  }
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/api/records')return handleRecords(request,env);
    if(path.startsWith('/api/'))return json({status:'error',code:'not_found'},404);
    return env.ASSETS.fetch(request);
  }
};
