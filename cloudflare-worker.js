// FIT-CONNECT Cloudflare preview: read-only Supabase endpoint.
// Writes and member logins continue to use the existing Apps Script backend.
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
async function handleRecords(request,env) {
  if(request.method!=='POST')return json({status:'error',code:'method_not_allowed'},405);
  if(Number(request.headers.get('content-length')||0)>16384)
    return json({status:'error',code:'too_large'},413);
  let input;
  try{input=await request.json();}catch{return json({status:'error',code:'invalid_json'},400);}
  if(!input||input.action!=='read')return json({status:'error',code:'read_only'},405);
  if(!env.TRAINER_PASSWORD||!constantTimeEquals(input.password,env.TRAINER_PASSWORD))
    return json({status:'denied',code:'unauthorized'},403);
  const member=String(input.member||'').trim(),date=input.date;
  if(!member||member.length>100||!validDay(date))
    return json({status:'error',code:'invalid_query'},400);
  const base=String(env.SUPABASE_URL||'').trim().replace(/\/+$/,'');
  const key=String(env.SUPABASE_SECRET_KEY||'').trim();
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)||!key)
    return json({status:'error',code:'missing_runtime_configuration'},503);
  const supaGet=async path=>{
    const response=await fetch(base+path,{
      headers:{apikey:key,Accept:'application/json'},
      signal:AbortSignal.timeout(8000)
    });
    if(!response.ok)throw Error('Supabase HTTP '+response.status);
    return response.json();
  };
  const start=performance.now();
  try {
    const cached=memberCache.get(member);
    let memberId;
    if(cached && Date.now()-cached.timestamp<90000) memberId=cached.id;
    else {
      const matches=await supaGet('/rest/v1/fit_members?select=id&name=eq.'+
        encodeURIComponent(member)+'&limit=1');
      if(matches.length!==1)return json({status:'denied',code:'member_not_found'},403);
      memberId=matches[0].id;
      memberCache.set(member,{id:memberId,timestamp:Date.now()});
      if(memberCache.size>64)memberCache.delete(memberCache.keys().next().value);
    }
    const lookupMs=performance.now()-start;
    const daily=await supaGet('/rest/v1/fit_daily_records?select=data&member_id=eq.'+
      encodeURIComponent(memberId)+'&record_date=eq.'+date+'&limit=1');
    return json(daily.length?daily[0].data:{},200,{
      'Server-Timing':'member;dur='+lookupMs.toFixed(1)+
        ', daily;dur='+(performance.now()-start-lookupMs).toFixed(1),
      'X-Fit-Function-Region':request.cf?.colo||'cloudflare'
    });
  }catch{
    return json({status:'error',code:'supabase_read_failed'},502);
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
