const APPROVED_VIDEO_COPY={"member": "김윤지", "fileId": "163H14Nzkyky0LgAURwQ3wK1hJrlrm4ZE", "name": "ㅇㅇ", "sourceId": "a4feb824-8d87-4cac-9afc-9bff7cbc2093", "size": 12709733, "mime": "video/mp4", "sha256": "ece5c2712f647d911bdae1d78d8d7ce198aba3e8d363228ce1f34e99c4b691cd"};
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
const MEMBER_ACTIONS=['read','workoutHistory','memberInsights'];
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
  const prefix='/rest/v1/fit_daily_records?select=record_date,routines:data->routines,diet:data->diet'+
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
    data:{routines:r.routines,diet:r.diet}}));
}
function buildMemberInsights(rows,date) {
  const start=weekMonday(date),lastStart=shiftDay(start,-7),end=shiftDay(start,6);
  const weeklyBucket=()=>({days:new Set(),sets:0,exercises:0,latest:{}});
  const week={current:weeklyBucket(),previous:weeklyBucket()};
  const month=date.slice(0,7),prevMonth=shiftDay(month+'-01',-1).slice(0,7);
  const monthBucket=()=>({days:new Set(),sets:0,exercises:0,dietDays:new Set()});
  const monthly={current:monthBucket(),previous:monthBucket()};
  const progress=new Map();
  for(const row of rows) {
    const d=row.date,data=row.data||{},done=doneRoutines(data);
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
    weekly:{start,end,current:weeklyStat(week.current),previous:weeklyStat(week.previous),improvements},
    monthly:{month,previousMonth:prevMonth,current:monthlyStat(monthly.current),
      previous:monthlyStat(monthly.previous),inbodyChange:null},
    progress:exercises};
}
// One approved original file only. No source deletion, feedback edits, or general import route.
function copyBytesFromBase64(value){
  const raw=atob(String(value||'').replace(/\s/g,''));
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  return bytes;
}
async function approvedVideoDigest(bytes){
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
async function handleApprovedVideoCopy(action,input,env,memberId,supaGet,base,key){
  const job=APPROVED_VIDEO_COPY;
  const copyError=code=>Object.assign(Error(code),{diagnostic:code});
  if(String(input.member||'').trim()!==job.member)return json({status:'denied',code:'copy_scope_denied'},403);
  const headers={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json'};
  const path='copies-20261117/'+String(memberId)+'/'+job.sha256+'.mp4';
  const encoded=path.split('/').map(encodeURIComponent).join('/');
  const send=async(route,method,body,extra={})=>{
    const response=await fetch(base+route,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw copyError('copy_storage_http_'+response.status);
    const raw=await response.text();return raw?JSON.parse(raw):null;
  };
  const scope='/rest/v1/fit_video_metadata?select=id,source_id,file_id,storage_path&member_id=eq.'+encodeURIComponent(memberId)+'&kind=eq.form&source_id=eq.'+encodeURIComponent(job.sourceId)+'&limit=2';
  let rows=await supaGet(scope,'copy_existing');
  if(rows.length>1||(rows[0]&&(rows[0].file_id!==job.fileId||(rows[0].storage_path&&rows[0].storage_path!==path))))return json({status:'error',code:'copy_existing_link_conflict'},409);
  const signRead=async()=>{
    const signed=await send('/storage/v1/object/sign/fit-private-videos/'+encoded,'POST',{expiresIn:300});
    const partial=String(signed?.signedURL||signed?.signedUrl||'');if(!partial)throw copyError('copy_read_signature_missing');
    const url=new URL(partial.startsWith('/object/')?'/storage/v1'+partial:partial,base);
    if(url.origin!==base)throw copyError('copy_read_origin_invalid');return url.toString();
  };
  const confirmSource=async()=>{
    const upstream=await fetch(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},redirect:'follow',body:JSON.stringify({action:'listFormVideos',member:job.member,date:input.date,password:env.TRAINER_PASSWORD}),signal:AbortSignal.timeout(60000)});
    if(!upstream.ok)throw copyError('copy_source_http_'+upstream.status);
    const source=await upstream.json();
    if(source?.status!=='success'||!Array.isArray(source.videos)||!source.videos.some(v=>String(v.id)===job.sourceId&&String(v.fileId)===job.fileId))return false;
    return true;
  };
  const verifyAndLink=async()=>{
    const playbackUrl=await signRead();
    const uploaded=await fetch(playbackUrl,{signal:AbortSignal.timeout(30000)});
    if(!uploaded.ok)throw copyError('copy_verify_http_'+uploaded.status);
    const declared=Number(uploaded.headers.get('Content-Length')||0);
    if(declared&&declared!==job.size)return json({status:'error',code:'copy_size_mismatch'},409);
    const bytes=new Uint8Array(await uploaded.arrayBuffer());
    if(bytes.byteLength!==job.size)return json({status:'error',code:'copy_size_mismatch'},409);
    const digest=await approvedVideoDigest(bytes);
    if(digest!==job.sha256)return json({status:'error',code:'copy_hash_mismatch'},409);
    if(!rows[0]){
      await send('/rest/v1/fit_video_metadata?on_conflict=member_id,kind,source_id','POST',{member_id:memberId,kind:'form',source_id:job.sourceId,file_id:job.fileId,storage_path:path},{Prefer:'resolution=ignore-duplicates,return=minimal'});
    }else if(!rows[0].storage_path){
      await send('/rest/v1/fit_video_metadata?id=eq.'+encodeURIComponent(rows[0].id)+'&member_id=eq.'+encodeURIComponent(memberId)+'&storage_path=is.null','PATCH',{storage_path:path},{Prefer:'return=minimal'});
    }
    const final=await supaGet(scope,'copy_confirm');
    if(final.length!==1||final[0].file_id!==job.fileId||final[0].storage_path!==path)return json({status:'error',code:'copy_link_conflict'},409);
    return json({status:'success',verified:true,bytes:job.size,sha256:digest,url:playbackUrl});
  };
  if(action==='approvedVideoCopyBegin'){
    if(!await confirmSource())return json({status:'denied',code:'copy_source_not_confirmed'},403);
    if(rows[0]?.storage_path===path)return json({status:'success',alreadyLinked:true,expected:{size:job.size,mime:job.mime,sha256:job.sha256}});
    const signed=await send('/storage/v1/object/upload/sign/fit-private-videos/'+encoded,'POST',{});
    const partial=String(signed?.url||signed?.signedURL||'');if(!partial)throw copyError('copy_upload_signature_missing');
    const url=new URL(partial.startsWith('/object/')?'/storage/v1'+partial:partial,base);
    if(url.origin!==base)throw copyError('copy_upload_origin_invalid');
    return json({status:'success',uploadUrl:url.toString(),expected:{size:job.size,mime:job.mime,sha256:job.sha256}});
  }
  if(action==='approvedVideoCopyServer'){
    if(!await confirmSource())return json({status:'denied',code:'copy_source_not_confirmed'},403);
    if(!rows[0]?.storage_path){
      const source=await fetch(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},redirect:'follow',body:JSON.stringify({action:'videoDownload',member:job.member,date:input.date,password:env.TRAINER_PASSWORD,fileId:job.fileId}),signal:AbortSignal.timeout(60000)});
      if(!source.ok)throw copyError('copy_download_http_'+source.status);
      const payload=await source.json();
      if(payload?.status!=='success'||String(payload.mime||'')!==job.mime)return json({status:'error',code:'copy_download_invalid'},502);
      const bytes=copyBytesFromBase64(payload.base64);
      if(bytes.byteLength!==job.size)return json({status:'error',code:'copy_source_size_mismatch'},409);
      if(await approvedVideoDigest(bytes)!==job.sha256)return json({status:'error',code:'copy_source_hash_mismatch'},409);
      const signed=await send('/storage/v1/object/upload/sign/fit-private-videos/'+encoded,'POST',{});
      const partial=String(signed?.url||signed?.signedURL||'');if(!partial)throw copyError('copy_upload_signature_missing');
      const url=new URL(partial.startsWith('/object/')?'/storage/v1'+partial:partial,base);
      if(url.origin!==base)throw copyError('copy_upload_origin_invalid');
      const write=await fetch(url.toString(),{method:'PUT',headers:{'Content-Type':job.mime},body:bytes,signal:AbortSignal.timeout(60000)});
      if(!write.ok&&write.status!==409)throw copyError('copy_upload_http_'+write.status);
    }
    return verifyAndLink();
  }
  return verifyAndLink();
}

// Trainer-authorized legacy form-video migration. Each request copies exactly
// one canonical Apps Script video, validates bytes + SHA-256, then creates a
// private Storage mapping. No Drive source, feedback or daily record is edited.
async function handleLegacyFormVideoCopy(input,env,memberId,supaGet,base,key){
  const copyError=code=>Object.assign(Error(code),{diagnostic:code});
  const member=String(input.member||'').trim();
  const sourceId=String(input.sourceId||'').trim();
  const fileId=String(input.fileId||'').trim();
  if(!member||member.length>100||!sourceId||sourceId.length>200||!fileId||fileId.length>200)
    return json({status:'error',code:'legacy_copy_invalid_target'},400);
  const upstream=await fetch(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},redirect:'follow',
    body:JSON.stringify({action:'listFormVideos',member,date:input.date,password:env.TRAINER_PASSWORD}),signal:AbortSignal.timeout(60000)});
  if(!upstream.ok)throw copyError('legacy_copy_list_http_'+upstream.status);
  const listed=await upstream.json();
  const canonical=listed?.status==='success'&&Array.isArray(listed.videos)
    ?listed.videos.find(v=>String(v?.id)===sourceId&&String(v?.fileId)===fileId):null;
  if(!canonical)return json({status:'denied',code:'legacy_copy_source_not_confirmed'},403);
  const headers={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json'};
  const send=async(route,method,body,extra={})=>{
    const response=await fetch(base+route,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw copyError('legacy_copy_storage_http_'+response.status);
    const raw=await response.text();return raw?JSON.parse(raw):null;
  };
  const scope='/rest/v1/fit_video_metadata?select=id,file_id,storage_path&member_id=eq.'+encodeURIComponent(memberId)+'&kind=eq.form&source_id=eq.'+encodeURIComponent(sourceId)+'&limit=2';
  const rows=await supaGet(scope,'legacy_copy_existing');
  if(rows.length>1||(rows[0]&&String(rows[0].file_id)!==fileId))return json({status:'error',code:'legacy_copy_existing_link_conflict'},409);
  const signRead=async path=>{
    const signed=await send('/storage/v1/object/sign/fit-private-videos/'+path.split('/').map(encodeURIComponent).join('/'),'POST',{expiresIn:300});
    const partial=String(signed?.signedURL||signed?.signedUrl||'');if(!partial)throw copyError('legacy_copy_read_signature_missing');
    const url=new URL(partial.startsWith('/object/')?'/storage/v1'+partial:partial,base);
    if(url.origin!==base)throw copyError('legacy_copy_read_origin_invalid');return url.toString();
  };
  if(rows[0]?.storage_path)return json({status:'success',alreadyLinked:true,sourceId,fileId,url:await signRead(String(rows[0].storage_path))});
  const source=await fetch(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},redirect:'follow',
    body:JSON.stringify({action:'videoDownload',member,date:input.date,password:env.TRAINER_PASSWORD,fileId}),signal:AbortSignal.timeout(60000)});
  if(!source.ok)throw copyError('legacy_copy_download_http_'+source.status);
  const payload=await source.json();
  const mime=String(payload?.mime||'');
  if(payload?.status!=='success'||!['video/mp4','video/webm','video/quicktime'].includes(mime))return json({status:'error',code:'legacy_copy_download_invalid'},502);
  const bytes=copyBytesFromBase64(payload.base64);
  if(bytes.byteLength<1||bytes.byteLength>50000000)return json({status:'error',code:'legacy_copy_size_rejected'},413);
  const digest=await approvedVideoDigest(bytes);
  const ext={ 'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'}[mime];
  const path='legacy-20261118/'+String(memberId)+'/'+digest+'.'+ext;
  const signed=await send('/storage/v1/object/upload/sign/fit-private-videos/'+path.split('/').map(encodeURIComponent).join('/'),'POST',{});
  const partial=String(signed?.url||signed?.signedURL||'');if(!partial)throw copyError('legacy_copy_upload_signature_missing');
  const url=new URL(partial.startsWith('/object/')?'/storage/v1'+partial:partial,base);
  if(url.origin!==base)throw copyError('legacy_copy_upload_origin_invalid');
  const write=await fetch(url.toString(),{method:'PUT',headers:{'Content-Type':mime},body:bytes,signal:AbortSignal.timeout(60000)});
  if(!write.ok&&write.status!==409)throw copyError('legacy_copy_upload_http_'+write.status);
  const copied=await fetch(await signRead(path),{signal:AbortSignal.timeout(30000)});
  if(!copied.ok)throw copyError('legacy_copy_verify_http_'+copied.status);
  const copiedBytes=new Uint8Array(await copied.arrayBuffer());
  if(copiedBytes.byteLength!==bytes.byteLength||await approvedVideoDigest(copiedBytes)!==digest)return json({status:'error',code:'legacy_copy_hash_mismatch'},409);
  if(!rows[0]){
    await send('/rest/v1/fit_video_metadata?on_conflict=member_id,kind,source_id','POST',{member_id:memberId,kind:'form',source_id:sourceId,file_id:fileId,storage_path:path},{Prefer:'resolution=ignore-duplicates,return=minimal'});
  }else{
    await send('/rest/v1/fit_video_metadata?id=eq.'+encodeURIComponent(rows[0].id)+'&member_id=eq.'+encodeURIComponent(memberId)+'&storage_path=is.null','PATCH',{storage_path:path},{Prefer:'return=minimal'});
  }
  const final=await supaGet(scope,'legacy_copy_confirm');
  if(final.length!==1||String(final[0].file_id)!==fileId||String(final[0].storage_path)!==path)return json({status:'error',code:'legacy_copy_link_conflict'},409);
  return json({status:'success',verified:true,sourceId,fileId,bytes:bytes.byteLength,sha256:digest,url:await signRead(path)});
}

async function handleRecords(request,env) {
  if(request.method!=='POST')return json({status:'error',code:'method_not_allowed'},405);
  if(Number(request.headers.get('content-length')||0)>16384)
    return json({status:'error',code:'too_large'},413);
  let input;
  try{input=await request.json();}catch{return json({status:'error',code:'invalid_json'},400);}
  const action=input?.action;
  const approvedCopy=['approvedVideoCopyBegin','approvedVideoCopyFinish','approvedVideoCopyServer'].includes(action);
  const legacyCopy=action==='legacyFormVideoCopy';
  const directVideo=['directVideoBegin','directVideoFinish','directVideoList','directVideoPlay','directVideoFeedback','directVideoRead','directVideoDelete'].includes(action);
  if(!['read','verify','trainerOverview','listMembersFast','workoutHistory','memberInsights','memberSession','videoPlaybackUrl'].includes(action)&&!directVideo&&!approvedCopy&&!legacyCopy)
    return json({status:'error',code:'read_only'},405);
  const member=String(input.member||'').trim(),date=input.date;
  const sessionSecret=String(env.MEMBER_SESSION_SECRET||'');
  // Member path: either exchange a member link for a session, or use a session.
  if((action==='videoPlaybackUrl'||directVideo)&&input.password===undefined){
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
  const needsMember=approvedCopy||legacyCopy||directVideo||action==='read'||action==='workoutHistory'||action==='memberInsights'||action==='videoPlaybackUrl';
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
  if(action==='listMembersFast') {
    try {
      const rows=await supaGet('/rest/v1/fit_members?select=name&order=name.asc&limit=1000','members');
      if(rows.length===1000)throw Error('member list pagination required');
      return json({status:'success',source:'supabase',members:rows.map(row=>String(row.name||'').trim()).filter(Boolean)});
    }catch(error){return failed(error);}
  }
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
    if(approvedCopy)return await handleApprovedVideoCopy(action,input,env,memberId,supaGet,base,key);
    if(legacyCopy)return await handleLegacyFormVideoCopy(input,env,memberId,supaGet,base,key);
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
        return json({status:'success',videos:rows.map(format)});
      }
      const id=String(input.id||'').replace(/^direct:/,'');
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return json({status:'error',code:'invalid_id'},400);
      const filter=scope+'&id=eq.'+encodeURIComponent(id);
      let row;
      if(action==='directVideoBegin'){
        if(trainer)return json({status:'denied',code:'member_upload_only'},403);
        const size=Number(input.size),mime=String(input.mime||''),name=String(input.name||'').trim().slice(0,150),question=String(input.question||'').slice(0,1000);
        const ext={'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'}[mime];
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
        if(trainer)return json({status:'denied'},403);
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

