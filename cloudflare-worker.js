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
const MEMBER_ACTIONS=['read','workoutHistory','memberInsights','videoPlaybackUrl','directVideoBegin','directVideoFinish','directVideoList','directVideoPlay','directVideoFeedback','directVideoRead','dailyCheckin','dietSave','columnList'];
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
const memberLookups=new Map();
function rememberMember(name,id) {
  memberCache.delete(name);
  memberCache.set(name,{id,timestamp:Date.now()});
  if(memberCache.size>256)memberCache.delete(memberCache.keys().next().value);
}
async function lookupMember(base,member,supaGet) {
  const key=JSON.stringify([base,member]);
  const cached=memberCache.get(key);
  if(cached && Date.now()-cached.timestamp<600000) return cached.id;
  const pending=memberLookups.get(key);
  if(pending) return pending;
  const lookup=supaGet('/rest/v1/fit_members?select=id&name=eq.'+
    encodeURIComponent(member)+'&limit=1','member').then(matches=>{
    if(matches.length!==1) return null;
    const id=matches[0].id;
    rememberMember(key,id);
    return id;
  });
  memberLookups.set(key,lookup);
  try{return await lookup;}finally{memberLookups.delete(key);}
}
async function ensureMember(base,supaKey,member,supaGet) {
  const existing=await lookupMember(base,member,supaGet);
  if(existing!==null)return existing;
  const headers={
    apikey:supaKey,
    ...(supaKey.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+supaKey}),
    'Content-Type':'application/json',
    Prefer:'resolution=ignore-duplicates,return=representation'
  };
  let res=await fetch(base+'/rest/v1/fit_members?on_conflict=name',{
    method:'POST',headers,body:JSON.stringify({name:member}),signal:AbortSignal.timeout(8000)
  });
  if(!res.ok && res.status===400){
    res=await fetch(base+'/rest/v1/fit_members',{
      method:'POST',
      headers:{...headers,Prefer:'return=representation'},
      body:JSON.stringify({name:member}),
      signal:AbortSignal.timeout(8000)
    });
  }
  if(res.ok){
    try{
      const rows=await res.json();
      if(Array.isArray(rows)&&rows[0]?.id!=null){
        rememberMember(JSON.stringify([base,member]),rows[0].id);
        return rows[0].id;
      }
    }catch{}
  }
  const matches=await supaGet('/rest/v1/fit_members?select=id&name=eq.'+
    encodeURIComponent(member)+'&limit=1','member_ensure');
  if(matches.length===1){
    rememberMember(JSON.stringify([base,member]),matches[0].id);
    return matches[0].id;
  }
  return null;
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
async function buildOverview(supaGet,date,base) {
  const weekStart=shiftDay(date,-6),windowStart=shiftDay(date,-OVERVIEW_WINDOW_DAYS);
  const pageSize=1000;
  const prefix='/rest/v1/fit_daily_records?select=member_id,record_date,'+
    'routines:data->routines,reflection:data->reflection,diet:data->diet,feedback:data->feedback'+
    '&record_date=gte.'+windowStart+'&record_date=lte.'+date+
    '&order=record_date.desc&limit='+pageSize;
  const directPending=(async()=>{
    const counts=new Map(),size=1000;
    for(let offset=0;;offset+=size){
      if(offset>=10000)throw Error('video overview pagination limit exceeded');
      const rows=await supaGet('/rest/v1/fit_direct_videos?select=member_id,feedback,mime&state=eq.ready&order=id.asc&limit='+size+'&offset='+offset,'overview_videos');
      for(const row of rows)if(!String(row.feedback||'').trim()&&!String(row.mime||'').startsWith('image/'))counts.set(String(row.member_id),(counts.get(String(row.member_id))||0)+1);
      if(rows.length<size)return counts;
    }
  })();
  const [allMembers,firstPage,directCounts]=await Promise.all([
    supaGet('/rest/v1/fit_members?select=id,name&order=name.asc&limit=1000','overview'),
    supaGet(prefix+'&offset=0','overview'),directPending
  ]);
  if(allMembers.length===1000)throw Error('too many members for overview');
  const result=new Map();
  for(const row of allMembers) {
    if(base)rememberMember(JSON.stringify([base,String(row.name)]),row.id);
    result.set(row.id,{name:row.name,lastDate:'',activeToday:false,
      pendingWorkout:false,pendingDiet:false,pendingVideos:0,directPendingVideos:directCounts.get(String(row.id))||0,feedbackDone:false,
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
// Weekly/monthly reports and strength progress, computed exactly like
// api/records.js buildMemberInsights from the member's daily records up to
// `date`. InBody, PT and goal data live elsewhere and are not included; the
// page fills those from Apps Script.
function weekMonday(day) {
  const weekday=new Date(day+'T00:00:00Z').getUTCDay();
  return shiftDay(day,-(weekday+6)%7);
}
function doneRoutines(data) {
  return (Array.isArray(data?.routines)?data.routines:[]).map(r=>({
    ...r,doneCount:Array.isArray(r?.completedSets)?r.completedSets.filter(Boolean).length:0
  })).filter(r=>r.doneCount);
}
async function memberRowsAscending(supaGet,memberId,date) {
  const pageSize=1000;
  const prefix='/rest/v1/fit_daily_records?select=record_date,routines:data->routines,diet:data->diet,feedback:data->feedback'+
    '&member_id=eq.'+encodeURIComponent(memberId)+'&record_date=lte.'+date+
    '&order=record_date.desc&limit='+pageSize;
  const rows=[];
  for(let offset=0;;offset+=pageSize) {
    if(offset>=10000)throw Error('insights pagination limit exceeded');
    const page=await supaGet(prefix+'&offset='+offset,'insights');
    rows.push(...page);
    if(page.length<pageSize)break;
  }
  return rows.reverse().map(r=>({date:String(r.record_date),
    data:{routines:r.routines,diet:r.diet,feedback:r.feedback}}));
}
function buildMemberInsights(rows,date) {
  const start=weekMonday(date),lastStart=shiftDay(start,-7),end=shiftDay(start,6);
  const weeklyBucket=()=>({days:new Set(),sets:0,exercises:0,latest:{}});
  const week={current:weeklyBucket(),previous:weeklyBucket()};
  const month=date.slice(0,7),prevMonth=shiftDay(month+'-01',-1).slice(0,7);
  const monthBucket=()=>({days:new Set(),sets:0,exercises:0,dietDays:new Set()});
  const monthly={current:monthBucket(),previous:monthBucket()};
  const progress=new Map();
  const care={workoutDays:new Set(),dietDays:new Set(),feedbackDays:new Set()};
  for(const row of rows) {
    const d=row.date,data=row.data||{},done=doneRoutines(data);
    if(d>=start&&d<=date){
      if(done.length)care.workoutDays.add(d);
      if(['breakfast','lunch','dinner','snack'].some(k=>{
        const meal=data.diet?.[k]||{};
        return !!String(meal.desc||'').trim()||(Array.isArray(meal.photos)&&meal.photos.length>0)||(Array.isArray(meal.foods)&&meal.foods.length>0);
      }))care.dietDays.add(d);
      if(String(data.feedback?.workout||'').trim()||String(data.feedback?.diet||'').trim())care.feedbackDays.add(d);
    }
    if(d>=lastStart&&d<=end) {
      const bucket=d<start?week.previous:week.current;
      for(const r of done) {
        bucket.days.add(d);bucket.sets+=r.doneCount;bucket.exercises++;
        const name=String(r.name||'').trim();
        const normalized=name.toLowerCase().replace(/\s+/g,'');
        const weight=Number(r.weight);
        if(normalized&&Number.isFinite(weight)&&weight>0&&
            (!bucket.latest[normalized]||d>=bucket.latest[normalized].day))
          bucket.latest[normalized]={day:d,name,weight};
      }
    }
    const mb=d.startsWith(month)?monthly.current:d.startsWith(prevMonth)?monthly.previous:null;
    if(mb) {
      for(const r of done){mb.days.add(d);mb.sets+=r.doneCount;mb.exercises++;}
      const diet=data.diet||{};
      if(['breakfast','lunch','dinner','snack'].some(k=>{
        const food=diet[k]||{};
        return !!String(food.desc||'').trim()||
          (Array.isArray(food.photos)&&food.photos.length>0)||
          (Array.isArray(food.foods)&&food.foods.length>0);
      }))mb.dietDays.add(d);
    }
    for(const r of done) {
      const name=String(r.name||'').trim();
      const key=name.toLowerCase().replace(/\s+/g,'');
      const weight=Number(r.weight),reps=Number(r.reps);
      if(!name||name.length>80||!Number.isFinite(weight)||weight<=0||weight>1500)continue;
      if(!progress.has(key))progress.set(key,{name,points:[]});
      progress.get(key).points.push({date:d,weight,reps:Number.isFinite(reps)&&reps>=0?reps:0});
    }
  }
  const weeklyStat=b=>({days:b.days.size,sets:b.sets,exercises:b.exercises});
  const monthlyStat=b=>({days:b.days.size,sets:b.sets,exercises:b.exercises,dietDays:b.dietDays.size});
  const improvements=Object.entries(week.current.latest).flatMap(([key,now])=>{
    const prev=week.previous.latest[key];
    return prev&&now.weight>prev.weight?[{name:now.name,previous:prev.weight,current:now.weight}]:[];
  }).slice(0,8);
  const exercises=[...progress.values()].map(item=>{
    const byDay=new Map(item.points.map(p=>[p.date,p]));
    item.points=[...byDay.values()].slice(-24);
    return item;
  }).sort((a,b)=>b.points.length-a.points.length).slice(0,30);
  return {status:'success',partial:true,
    careSummary:{start,end:date,workoutDays:care.workoutDays.size,dietDays:care.dietDays.size,feedbackDays:care.feedbackDays.size},
    weekly:{start,end,current:weeklyStat(week.current),previous:weeklyStat(week.previous),improvements},
    monthly:{month,previousMonth:prevMonth,current:monthlyStat(monthly.current),
      previous:monthlyStat(monthly.previous),inbodyChange:null},
    progress:exercises};
}
async function handleRecords(request,env) {
  const requestStarted=performance.now();
  if(request.method!=='POST')return json({status:'error',code:'method_not_allowed'},405);
  if(Number(request.headers.get('content-length')||0)>131072)
    return json({status:'error',code:'too_large'},413);
  let input;
  try{input=await request.json();}catch{return json({status:'error',code:'invalid_json'},400);}
  // Content-Length can be absent (chunked transfer); enforce the limit after parsing too.
  if(!input||typeof input!=='object'||Array.isArray(input))
    return json({status:'error',code:'invalid_json'},400);
  if(JSON.stringify(input).length>131072)return json({status:'error',code:'too_large'},413);
  const action=input?.action;
  const directVideo=['directVideoBegin','directVideoFinish','directVideoList','directVideoPlay','directVideoFeedback','directVideoRead','directVideoDelete'].includes(action);
  if(!['read','verify','trainerOverview','trainerVideoQueue','listMembersFast','workoutHistory','memberInsights','memberSession','videoPlaybackUrl','dailyCheckin','dietSave','columnList','columnSave'].includes(action)&&!directVideo)
    return json({status:'error',code:'read_only'},405);
  const member=String(input.member||'').trim(),date=input.date;
  const sessionSecret=String(env.MEMBER_SESSION_SECRET||'');
  // Member path: either exchange a member link for a session, or use a session.
  if((action==='videoPlaybackUrl'||directVideo||action==='columnList'||action==='memberInsights'||action==='dietSave')&&input.password===undefined&&input.session===undefined){
    if(!member||member.length>100||typeof input.token!=='string'||!input.token||input.token.length>200||!validDay(date))return json({status:'denied'},403);
    try{if(!await appsScriptAcceptsMember(member,String(input.token),date))return json({status:'denied'},403);}catch{return json({status:'error',code:'apps_script_unreachable'},502);}
  } else if(action==='memberSession'||(input.session!==undefined&&input.password===undefined)) {
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
      const session=await signMemberSession(sessionSecret,member);
      return json({status:'success',...session},200,{
        'Server-Timing':'session;dur='+(performance.now()-requestStarted).toFixed(1)
      });
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
  const needsMember=directVideo||action==='read'||action==='workoutHistory'||action==='memberInsights'||action==='videoPlaybackUrl'||action==='dailyCheckin'||action==='dietSave';
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
  const supaWrite=async(path,method,payload,label)=>{
    step=label||step;
    const response=await fetch(base+path,{method,headers:{
      apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json',
      Prefer:path.includes('/fit_meal_photos?')?'return=representation,resolution=merge-duplicates':'return=representation'
    },body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
    if(!response.ok){
      let detail='';try{const body=await response.json();detail=clean(body?.message||body?.error||body?.code);}catch{}
      const error=Error('Supabase HTTP '+response.status);error.diagnostic=response.status+(detail?':'+detail:'');throw error;
    }
    return response.json();
  };
  const start=performance.now();
  if(action==='listMembersFast') {
    try {
      const rows=await supaGet('/rest/v1/fit_members?select=name&order=name.asc&limit=1000','members');
      if(rows.length===1000)throw Error('member list pagination required');
      return json({status:'success',source:'supabase',members:rows.map(row=>String(row.name||'').trim()).filter(Boolean)});
    }catch(error){return failed(error);}
  }
  if(action==='columnList') {
    try {
      const isTrainer=input.password!==undefined;
      const filter=isTrainer?'':'&status=eq.published';
      const rows=await supaGet('/rest/v1/fit_columns?select=id,title,category,summary,content,author,published_at,status,updated_at'+filter+'&order=published_at.desc&limit=60','columns');
      return json({status:'success',columns:rows},200,{
        'Server-Timing':'columns;dur='+(performance.now()-start).toFixed(1),
        'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
      });
    }catch(error){return failed(error);}
  }
  if(action==='columnSave') {
    const c=input.column;
    const categories=new Set(['영양/식단','트레이닝','회복/습관']);
    const lines=Array.isArray(c?.content)?c.content.map(v=>String(v||'').trim()).filter(Boolean):[];
    const title=String(c?.title||'').trim(),category=String(c?.category||'').trim(),summary=String(c?.summary||'').trim();
    const publishedAt=String(c?.published_at||'').trim(),author=String(c?.author||'신명진 코치').trim();
    if(title.length<3||title.length>90||!categories.has(category)||summary.length<10||summary.length>280||
      lines.length<1||lines.length>6||lines.some(v=>v.length>500)||author.length<2||author.length>50||!validDay(publishedAt))
      return json({status:'error',code:'invalid_column'},400);
    const payload={title,category,summary,content:lines,author,published_at:publishedAt,status:'published',updated_at:new Date().toISOString()};
    const id=String(c?.id||'').trim();
    try {
      const rows=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        ?await supaWrite('/rest/v1/fit_columns?id=eq.'+encodeURIComponent(id),'PATCH',payload,'column_save')
        :await supaWrite('/rest/v1/fit_columns','POST',payload,'column_publish');
      return json({status:'success',column:rows?.[0]||null});
    }catch(error){return failed(error);}
  }
  if(action==='trainerOverview') {
    try {
      const overview=await buildOverview(supaGet,date,base);
      return json(overview,200,{
        'Server-Timing':'overview;dur='+(performance.now()-start).toFixed(1),
        'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
      });
    }catch(error){
      return failed(error);
    }
  }
  // Compact coach queue for the dashboard. It includes who uploaded, the video title and upload time.
  if(action==='trainerVideoQueue') {
    try {
      const [members, videos]=await Promise.all([
        supaGet('/rest/v1/fit_members?select=id,name&limit=1000','video_queue_members'),
        supaGet('/rest/v1/fit_direct_videos?select=member_id,name,created_at,feedback,mime&state=eq.ready&order=created_at.desc&limit=1000','video_queue')
      ]);
      const names=new Map(members.map(row=>[String(row.id),String(row.name||'').trim()]));
      const queue=videos.filter(row=>!String(row.feedback||'').trim()&&!String(row.mime||'').startsWith('image/')&&names.has(String(row.member_id)))
        .slice(0,12).map(row=>({member:names.get(String(row.member_id)),title:String(row.name||'운동 영상'),createdAt:row.created_at||''}));
      return json({status:'success',videos:queue},200,{'X-Fit-Function-Region':request.cf?.colo||'cloudflare'});
    }catch(error){ return failed(error); }
  }
  try {
    step='member';
    const memberId=await ensureMember(base,key,member,supaGet);
    if(memberId===null)return json({status:'denied',code:'member_not_found'},403);
    const lookupMs=performance.now()-start;
    if(action==='dailyCheckin'){
      const raw=input.checkin;
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return json({status:'error',code:'invalid_checkin'},400);
      const workout=['done','rest'].includes(raw.workout)?raw.workout:undefined;
      const diet=['done','partial'].includes(raw.diet)?raw.diet:undefined;
      const mood=['good','normal','tired'].includes(raw.mood)?raw.mood:undefined;
      if(!workout&&!diet&&!mood)return json({status:'error',code:'invalid_checkin'},400);
      const changes={...(workout?{workout}:{}),...(diet?{diet}:{}),...(mood?{mood}:{})};
      const table='/rest/v1/fit_daily_records';
      const scope='member_id=eq.'+encodeURIComponent(memberId)+'&record_date=eq.'+date;
      const headers={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json',Prefer:'return=representation'};
      for(let attempt=0;attempt<3;attempt++){
        const rows=await supaGet(table+'?select=id,data,updated_at&'+scope+'&limit=2','daily_checkin_read');
        if(rows.length>1)break;
        const row=rows[0];
        const previousVersion=Date.parse(row?.updated_at);
        const updatedAt=new Date(Math.max(Date.now(),Number.isFinite(previousVersion)?previousVersion+1:0)).toISOString();
        const data={...row?.data,dailyCheckin:{...row?.data?.dailyCheckin,...changes,updatedAt}};
        const version=row?.updated_at==null?'is.null':'eq.'+encodeURIComponent(row.updated_at);
        const target=row?table+'?id=eq.'+encodeURIComponent(row.id)+'&updated_at='+version:table;
        const payload=row?{data,updated_at:updatedAt}:{member_id:memberId,record_date:date,data,updated_at:updatedAt};
        const response=await fetch(base+target,{method:row?'PATCH':'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
        if(!row&&response.status===409)continue;
        if(!response.ok)throw Error('daily_checkin_write_'+response.status);
        const [saved]=await response.json();
        if(saved)return json({status:'success',data:saved.data});
      }
      return json({status:'error',code:'checkin_conflict'},409);
    }
    if(action==='dietSave'){
      const rawDiet=input.diet;
      if(!rawDiet||typeof rawDiet!=='object'||Array.isArray(rawDiet))return json({status:'error',code:'invalid_diet'},400);
      for(const k of ['breakfast','lunch','dinner','snack']){
        if(rawDiet[k]===undefined)continue;
        if(!rawDiet[k]||typeof rawDiet[k]!=='object'||Array.isArray(rawDiet[k]))
          return json({status:'error',code:'invalid_meal'},400);
        if(rawDiet[k].photos!==undefined){
          if(!Array.isArray(rawDiet[k].photos)||rawDiet[k].photos.length>1)
            return json({status:'error',code:'invalid_photos'},400);
          for(const photo of rawDiet[k].photos){
            const src=typeof photo==='string'?photo:(photo?.url||photo?.src||photo?.data||'');
            if(typeof src!=='string'||src.length>95000||
              !(src.startsWith('data:image/jpeg;base64,')||src.startsWith('data:image/png;base64,')||
                src.startsWith('data:image/webp;base64,')||src.startsWith('https://')||src.startsWith('direct:')))
              return json({status:'error',code:'invalid_photo'},400);
          }
        }
      }
      const table='/rest/v1/fit_daily_records';
      const scope='member_id=eq.'+encodeURIComponent(memberId)+'&record_date=eq.'+date;
      const headers={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json',Prefer:'return=representation,resolution=merge-duplicates'};
      for(let attempt=0;attempt<3;attempt++){
        const rows=await supaGet(table+'?select=id,data,updated_at&'+scope+'&limit=2','diet_read');
        if(rows.length>1)break;
        const row=rows[0];
        const previousVersion=Date.parse(row?.updated_at);
        const updatedAt=new Date(Math.max(Date.now(),Number.isFinite(previousVersion)?previousVersion+1:0)).toISOString();
        const prevDiet=(row?.data?.diet&&typeof row.data.diet==='object')?row.data.diet:{};
        const mergedDiet={...prevDiet};
        for(const k of ['breakfast','lunch','dinner','snack']){
          if(rawDiet[k]&&typeof rawDiet[k]==='object'&&!Array.isArray(rawDiet[k])){
            const previous=prevDiet[k]&&typeof prevDiet[k]==='object'?prevDiet[k]:{};
            const incoming=rawDiet[k];
            // Missing photos means "leave the photo unchanged", not "delete it".
            // Apps Script's text-only meal writes must never clear existing images.
            const existingPhotos=Array.isArray(previous.photos)?previous.photos:[];
            const nextPhotos=Array.isArray(incoming.photos)&&incoming.photos.length
              ?incoming.photos:existingPhotos;
            mergedDiet[k]={...previous,...incoming,photos:nextPhotos};
          }
        }
        if(rawDiet.water!==undefined)mergedDiet.water=Number(rawDiet.water)||0;
        // Photo bytes have their own table so a subsequent Apps Script mirror
        // cannot erase them by replacing fit_daily_records.data.
        for(const k of ['breakfast','lunch','dinner','snack']){
          const photos=rawDiet[k]?.photos;
          const candidate=Array.isArray(photos)?photos[0]:null;
          const src=typeof candidate==='string'?candidate:(candidate?.url||candidate?.src||candidate?.data||'');
          if(src && (src.startsWith('data:image/jpeg;base64,') || src.startsWith('data:image/png;base64,') || src.startsWith('data:image/webp;base64,') || src.startsWith('https://'))){
            await supaWrite('/rest/v1/fit_meal_photos?on_conflict=member_id,record_date,meal_key','POST',
              {member_id:memberId,record_date:date,meal_key:k,photo:src,updated_at:new Date().toISOString()},'meal_photo_write');
          }
        }
        // Photo data is rehydrated from fit_meal_photos on reads. Avoid
        // writing new base64 copies into the daily JSONB record.
        const compactDiet={...mergedDiet};
        for(const k of ['breakfast','lunch','dinner','snack']){
          if(compactDiet[k]&&typeof compactDiet[k]==='object'&&rawDiet[k]){
            const candidate=rawDiet[k].photos?.[0];
            const src=typeof candidate==='string'?candidate:(candidate?.url||candidate?.src||candidate?.data||'');
            if(src.startsWith('data:image/')||src.startsWith('https://'))
              compactDiet[k]={...compactDiet[k],photos:[]};
          }
        }
        const data={...(row?.data||{}),diet:compactDiet};
        const version=row?.updated_at==null?'is.null':'eq.'+encodeURIComponent(row.updated_at);
        const target=row?table+'?id=eq.'+encodeURIComponent(row.id)+'&updated_at='+version:table;
        const payload=row?{data,updated_at:updatedAt}:{member_id:memberId,record_date:date,data,updated_at:updatedAt};
        const response=await fetch(base+target,{method:row?'PATCH':'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
        if(!row&&response.status===409)continue;
        if(!response.ok)throw Error('diet_write_'+response.status);
        const [saved]=await response.json();
        if(saved)return json({status:'success',data:saved.data});
      }
      return json({status:'error',code:'diet_conflict'},409);
    }
    if(directVideo){
      const trainer=input.password!==undefined;
      const headers={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json'};
      const table='/rest/v1/fit_direct_videos';
      const scope='member_id=eq.'+encodeURIComponent(memberId);
      const bucket='/storage/v1/object';
      const send=async(path,method,body,extra={})=>{
        const res=await fetch(base+path,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000)});
        if(!res.ok){const error=Error('direct_video_http_'+res.status);error.diagnostic='direct_video_http_'+res.status;throw error;}
        const raw=await res.text();return raw?JSON.parse(raw):null;
      };
      const format=row=>({id:'direct:'+row.id,fileId:'direct:'+row.id,name:row.name,question:row.question,feedback:row.feedback,readAt:row.read_at||'',createdAt:row.created_at});
      if(action==='directVideoList'){
        const rows=await supaGet(table+'?select=*&'+scope+'&state=eq.ready&order=created_at.desc&limit=200','direct_list');
        return json({status:'success',videos:rows.filter(row=>!String(row.mime||'').startsWith('image/')).map(format)});
      }
      const id=String(input.id||'').replace(/^direct:/,'');
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return json({status:'error',code:'invalid_id'},400);
      const filter=scope+'&id=eq.'+encodeURIComponent(id);
      let row;
      if(action==='directVideoBegin'){
        const size=Number(input.size),mime=String(input.mime||''),name=String(input.name||'').trim().slice(0,150),question=String(input.question||'').slice(0,1000);
        const ext={'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[mime];
        if(!ext||!name||!Number.isInteger(size)||size<1||size>50000000)return json({status:'error',code:'invalid_file'},400);
        const storage_path='member-'+encodeURIComponent(String(memberId)).replace(/%/g,'_')+'/'+id+'.'+ext;
        // Insert and return the row in one round trip; conflicts are scoped to this member.
        const inserted=await send(table+'?on_conflict=id','POST',{id,member_id:String(memberId),storage_path,name,question,mime,size_bytes:size},{Prefer:'resolution=ignore-duplicates,return=representation'});
        row=Array.isArray(inserted)?inserted[0]:null;
        if(!row)row=(await supaGet(table+'?select=*&'+filter+'&limit=1','direct_retry'))[0];
        if(row&&String(row.member_id)!==String(memberId))return json({status:'denied'},403);
        if(!row||row.size_bytes!=size||row.mime!==mime||row.state==='deleted')return json({status:'error',code:'upload_conflict'},409);
        if(row.state==='ready')return json({status:'success',alreadyReady:true});
        const path=row.storage_path.split('/').map(encodeURIComponent).join('/');
        const signed=await send(bucket+'/upload/sign/fit-direct-videos/'+path,'POST',{});
        const relative=String(signed.url||signed.signedURL||'');
        if(!relative)return json({status:'error',code:'upload_signature_missing'},502);
        const url=new URL(relative.startsWith('/object/')?'/storage/v1'+relative:relative,base);
        if(url.origin!==base)return json({status:'error',code:'upload_origin_invalid'},502);
        return json({status:'success',url:url.toString(),uploadToken:url.searchParams.get('token')||signed.token||'',objectName:row.storage_path,tusEndpoint:base.replace('.supabase.co','.storage.supabase.co')+'/storage/v1/upload/resumable'});
      }
      row=(await supaGet(table+'?select=*&'+filter+'&limit=1','direct_row'))[0];
      if(!row||row.state==='deleted')return json({status:'error',code:'video_not_found'},404);
      const path=row.storage_path.split('/').map(encodeURIComponent).join('/');
      if(action==='directVideoFinish'){
        if(row.state==='ready')return json({status:'success',video:format(row)});
        step='direct_finish_storage';
        const info=await send(bucket+'/info/fit-direct-videos/'+path,'GET');
        const bytes=Number(info.size??info.metadata?.size);
        if(bytes!==Number(row.size_bytes))return json({status:'error',code:'upload_size_mismatch'},409);
        const updated=await send(table+'?'+filter+'&state=eq.pending','PATCH',{state:'ready'},{Prefer:'return=representation'});
        const ready=updated?.[0]||(await supaGet(table+'?select=*&'+filter+'&state=eq.ready&limit=1','direct_finish_retry'))[0];
        if(!ready)return json({status:'error',code:'upload_state_changed'},409);
        return json({status:'success',video:format(ready)});
      }
      if(row.state!=='ready')return json({status:'error',code:'not_ready'},409);
      if(action==='directVideoPlay'){
        const signed=await send(bucket+'/sign/fit-direct-videos/'+path,'POST',{expiresIn:300});
        const partial=String(signed.signedURL||signed.signedUrl||'');
        if(!partial)return json({status:'error',code:'signature_missing'},502);
        const url=new URL(partial.startsWith('/object/')?'/storage/v1'+partial:partial,base);
        if(url.origin!==base)return json({status:'error',code:'origin_invalid'},502);
        return json({status:'success',url:url.toString()});
      }
      let patch;
      if(action==='directVideoFeedback'&&trainer)patch={feedback:String(input.feedback||'').slice(0,2000),read_at:null};
      if(action==='directVideoRead'&&!trainer&&row.feedback)patch={read_at:new Date().toISOString()};
      if(action==='directVideoDelete'&&trainer)patch={state:'deleted'};
      if(!patch)return json({status:'denied'},403);
      await send(table+'?'+filter+'&state=eq.ready','PATCH',patch,{Prefer:'return=minimal'});
      return json({status:'success'});
    }
    if(action==='videoPlaybackUrl'){
      const fileId=String(input.fileId||'').trim();
      if(!fileId||fileId.length>200)return json({status:'error',code:'invalid_video'},400);
      const matches=await supaGet('/rest/v1/fit_video_metadata?select=storage_path&member_id=eq.'+encodeURIComponent(memberId)+'&file_id=eq.'+encodeURIComponent(fileId)+'&limit=2','video');
      if(!matches.length)return json({status:'not_migrated'});
      const path=String(matches[0].storage_path||'');
      if(matches.length!==1||!path||path.includes('..')||!path.split('/').every(x=>/^[a-zA-Z0-9_.-]+$/.test(x)))return json({status:'error',code:'invalid_video_path'},409);
      const signed=await fetch(base+'/storage/v1/object/sign/fit-private-videos/'+path.split('/').map(encodeURIComponent).join('/'),{
        method:'POST',headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json'},
        body:JSON.stringify({expiresIn:300}),signal:AbortSignal.timeout(10000)
      });
      if(!signed.ok)return json({status:'error',code:'video_sign_failed'},502);
      const item=await signed.json(),partial=String(item.signedURL||item.signedUrl||'');
      if(!partial)return json({status:'error',code:'video_signature_missing'},502);
      const url=new URL(partial.startsWith('/object/')?'/storage/v1'+partial:partial,base);
      if(url.origin!==base)return json({status:'error',code:'video_origin_invalid'},502);
      return json({status:'success',url:url.toString()});
    }
    if(action==='workoutHistory') {
      const history=await buildWorkoutHistory(supaGet,memberId,date,month);
      return json(history,200,{
        'Server-Timing':'member;dur='+lookupMs.toFixed(1)+
          ', history;dur='+(performance.now()-start-lookupMs).toFixed(1),
        'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
      });
    }
    if(action==='memberInsights') {
      const insights=buildMemberInsights(await memberRowsAscending(supaGet,memberId,date),date);
      return json(insights,200,{
        'Server-Timing':'member;dur='+lookupMs.toFixed(1)+
          ', insights;dur='+(performance.now()-start-lookupMs).toFixed(1),
        'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
      });
    }
    const [daily,photoRows]=await Promise.all([
      supaGet('/rest/v1/fit_daily_records?select=data&member_id=eq.'+
        encodeURIComponent(memberId)+'&record_date=eq.'+date+'&limit=1','daily'),
      supaGet('/rest/v1/fit_meal_photos?select=meal_key,photo&member_id=eq.'+
        encodeURIComponent(memberId)+'&record_date=eq.'+date+'&limit=4','meal_photos')
    ]);
    const result={...(daily[0]?.data||{})};
    const diet={...(result.diet||{})};
    for(const item of photoRows){
      if(!['breakfast','lunch','dinner','snack'].includes(item.meal_key))continue;
      diet[item.meal_key]={...(diet[item.meal_key]||{}),photos:[item.photo]};
    }
    if(photoRows.length)result.diet=diet;
    return json(result,200,{
      'Server-Timing':'member;dur='+lookupMs.toFixed(1)+
        ', daily;dur='+(performance.now()-start-lookupMs).toFixed(1),
      'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
    });
  }catch(error){
    return failed(error);
  }
}
// Same-origin bridge for the existing Apps Script POST API. Auth remains in Apps Script.
async function handleAppsScriptPost(request) {
  if(request.method!=='POST')return json({status:'error',message:'Method not allowed'},405);
  const origin=request.headers.get('Origin');
  if(origin && origin!==new URL(request.url).origin)return json({status:'error',message:'Origin denied'},403);
  try {
    const body=await request.text();
    const input=JSON.parse(body);
    if(!input || typeof input!=='object' || Array.isArray(input))return json({status:'error',message:'Invalid request'},400);
    const upstream=await fetch(APPS_SCRIPT_URL,{
      method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body,
      redirect:'follow',signal:AbortSignal.timeout(60000)
    });
    if(!upstream.ok)return json({status:'error',message:'Apps Script HTTP '+upstream.status},502);
    const type=upstream.headers.get('content-type')||'';
    const raw=await upstream.text();
    let result;
    try { result=JSON.parse(raw); } catch {
      return json({status:'error',message:'Apps Script returned non-JSON ('+(type.split(';')[0]||'unknown')+'); '+( /quota|too many times/i.test(raw)?'quota limit':/sign in|accounts.google.com/i.test(raw)?'authentication required':/exception|script error/i.test(raw)?'script exception':'unexpected response')},502);
    }
    return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }catch(e){
    return json({status:'error',message:'Apps Script transport failure: '+(e?.name==='TimeoutError'?'timeout':e?.name==='AbortError'?'aborted':e?.name==='SyntaxError'?'invalid JSON':'network error')},502);
  }
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/api/records')return handleRecords(request,env);
    if(path==='/api/apps-script')return handleAppsScriptPost(request);
    if(path.startsWith('/api/'))return json({status:'error',code:'not_found'},404);
    return env.ASSETS.fetch(request);
  }
};
