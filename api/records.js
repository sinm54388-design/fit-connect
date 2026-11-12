
 // FIT-CONNECT: Supabase route.
 // Google Sheets remains active until the final cutover.
 // Writes require the fit_save_daily RPC.
 const crypto = require('node:crypto');

 function reply(res, status, body) {
   res.setHeader('Cache-Control', 'no-store');
   return res.status(status).json(body);
 }

 function sameSecret(a, b) {
   if (!a || !b) return false;
   const left = crypto.createHash('sha256').update(String(a)).digest();
   const right = crypto.createHash('sha256').update(String(b)).digest();
   return crypto.timingSafeEqual(left, right);
 }

 function validDay(value) {
   if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
   const day = new Date(`${value}T00:00:00Z`);
   return !Number.isNaN(day.getTime()) &&
     day.toISOString().slice(0, 10) === value;
 }

 async function supabaseGet(base, key, path) {
   const response = await fetch(`${base}${path}`, {
     headers: {
       apikey: key,
       Accept: 'application/json'
     },
     signal: AbortSignal.timeout(8000)
   });

   if (!response.ok) {
     throw new Error(`Supabase HTTP ${response.status}`);
   }
   return response.json();
 }

 async function supabaseWrite(base, key, path, payload) {
   const response = await fetch(`${base}${path}`, {
     method: 'POST',
     headers: {
       apikey: key,
       'Content-Type': 'application/json',
       Accept: 'application/json'
     },
     body: JSON.stringify(payload),
     signal: AbortSignal.timeout(10000)
   });

   if (!response.ok) {
     throw new Error(`Supabase RPC HTTP ${response.status}`);
   }
   return response.json();
 }


 // Supabase daily records power fast history/reports without a Sheets roundtrip.
 function shiftDay(day, offset) {
   const d = new Date(day + 'T00:00:00Z');
   d.setUTCDate(d.getUTCDate() + offset);
   return d.toISOString().slice(0, 10);
 }
 function weekMonday(day) {
   const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
   return shiftDay(day, -(weekday + 6) % 7);
 }
 function doneRoutines(data) {
   return (Array.isArray(data?.routines) ? data.routines : []).map(r => ({
     ...r, doneCount: Array.isArray(r.completedSets) ? r.completedSets.filter(Boolean).length : 0
   })).filter(r => r.doneCount);
 }
 async function getMemberHistory(base, key, memberId, date) {
   // Query newest-first so that a Supabase/PostgREST page limit cannot
   // silently return old records while omitting the latest.
   const rows = await supabaseGet(base, key,
     '/rest/v1/fit_daily_records?select=record_date,data&member_id=eq.' +
     encodeURIComponent(memberId) + '&record_date=lte.' + date +
     '&order=record_date.desc&limit=1000');
   if (rows.length === 1000) throw new Error('record history pagination is required');
   return rows.reverse().map(r => ({ date: String(r.record_date), data: r.data || {} }));
 }
 function buildWorkoutHistory(rows, date, month) {
   const days = new Set(), previous = {};
   for (let i = rows.length - 1; i >= 0; i--) {
     const record = rows[i], done = doneRoutines(record.data);
     if (record.date.startsWith(month) && done.length) days.add(record.date);
     if (record.date >= date) continue;
     for (const r of done) {
       const name = String(r.name || '').trim().toLowerCase();
       if (name && !previous[name]) previous[name] = {
         date: record.date, weight: String(r.weight || ''), reps: String(r.reps || '')
       };
     }
   }
   return { status: 'success', month, days: [...days].sort(), previous };
 }
 function buildMemberInsights(rows, date) {
   const start = weekMonday(date), lastStart = shiftDay(start, -7),
     end = shiftDay(start, 6);
   const weeklyBucket = () => ({ days: new Set(), sets: 0, exercises: 0, latest: {} });
   const week = { current: weeklyBucket(), previous: weeklyBucket() };
   const month = date.slice(0, 7), prevMonth = shiftDay(month + '-01', -1).slice(0, 7);
   const monthBucket = () => ({ days: new Set(), sets: 0, exercises: 0, dietDays: new Set() });
   const monthly = { current: monthBucket(), previous: monthBucket() };
   const progress = new Map();
   for (const row of rows) {
     const d = row.date, data = row.data || {}, done = doneRoutines(data);
     if (d >= lastStart && d <= end) {
       const bucket = d < start ? week.previous : week.current;
       for (const r of done) {
         bucket.days.add(d); bucket.sets += r.doneCount; bucket.exercises++;
         const name = String(r.name || '').trim();
         const normalized = name.toLowerCase().replace(/\s+/g, '');
         const weight = Number(r.weight);
         if (normalized && Number.isFinite(weight) && weight > 0 &&
             (!bucket.latest[normalized] || d >= bucket.latest[normalized].day))
           bucket.latest[normalized] = { day: d, name, weight };
       }
     }
     const mb = d.startsWith(month) ? monthly.current :
       d.startsWith(prevMonth) ? monthly.previous : null;
     if (mb) {
       for (const r of done) {
         mb.days.add(d); mb.sets += r.doneCount; mb.exercises++;
       }
       const diet = data.diet || {};
       if (['breakfast','lunch','dinner','snack'].some(k => {
         const food = diet[k] || {};
         return !!String(food.desc || '').trim() ||
           (Array.isArray(food.photos) && food.photos.length > 0) ||
           (Array.isArray(food.foods) && food.foods.length > 0);
       })) mb.dietDays.add(d);
     }
     for (const r of done) {
       const name = String(r.name || '').trim();
       const key = name.toLowerCase().replace(/\s+/g, '');
       const weight = Number(r.weight), reps = Number(r.reps);
       if (!name || name.length > 80 || !Number.isFinite(weight) ||
           weight <= 0 || weight > 1500) continue;
       if (!progress.has(key)) progress.set(key, { name, points: [] });
       progress.get(key).points.push({
         date: d, weight, reps: Number.isFinite(reps) && reps >= 0 ? reps : 0
       });
     }
   }
   const weeklyStat = b => ({ days: b.days.size, sets: b.sets, exercises: b.exercises });
   const monthlyStat = b => ({
     days: b.days.size, sets: b.sets, exercises: b.exercises, dietDays: b.dietDays.size
   });
   const improvements = Object.entries(week.current.latest).flatMap(([key, now]) => {
     const prev = week.previous.latest[key];
     return prev && now.weight > prev.weight ?
       [{ name: now.name, previous: prev.weight, current: now.weight }] : [];
   }).slice(0, 8);
   const exercises = [...progress.values()].map(item => {
     const byDay = new Map(item.points.map(p => [p.date, p]));
     item.points = [...byDay.values()].slice(-24);
     return item;
   }).sort((a,b) => b.points.length - a.points.length).slice(0,30);
   return {
     status: 'success',
     weekly: { start, end, current: weeklyStat(week.current),
       previous: weeklyStat(week.previous), improvements },
     monthly: { month, previousMonth: prevMonth,
       current: monthlyStat(monthly.current), previous: monthlyStat(monthly.previous),
       inbodyChange: null },
     progress: exercises
   };
 }

 module.exports = async function handler(req, res) {
   if (req.method !== 'GET' && req.method !== 'POST') {
     return reply(res, 405, {
       status: 'error',
       message: '허용되지 않은 요청입니다.'
     });
   }

   const base = String(process.env.SUPABASE_URL || '')
     .replace(/\/+$/, '');
   const key = String(process.env.SUPABASE_SECRET_KEY || '');

   if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) || !key) {
     return reply(res, 503, {
       status: 'error',
       message: '서버 설정이 없습니다.'
     });
   }

   try {
     let params = req.query || {};

     if (req.method === 'POST') {
       const body = typeof req.body === 'string'
         ? JSON.parse(req.body)
         : req.body;

       params = body && typeof body === 'object'
         ? body
         : {};
     }

     const action = String(
       params.action || (params.data ? 'save' : 'read')
     );

     const trainer = sameSecret(
       params.password,
       process.env.TRAINER_PASSWORD
     );

     if (action === 'verify') {
       return reply(res, 200, {
         status: trainer ? 'success' : 'denied'
       });
     }

     const allowedActions = [
       'read',
       'save',
       'patchData',
       'setProgressBatch',
       'readInbody',
       'saveInbody',
       'readMemberGoal',
       'saveMemberGoal',
       'memberInsights',
       'workoutHistory',
       'insightsBundle',
       'trainerOverview',
       'listMembersFast',
       'videoPlaybackUrl',
       'linkVideoStorage'
     ];

     if (!allowedActions.includes(action)) {
       return reply(res, 400, {
         status: 'error',
         message: '지원하지 않는 작업입니다.'
       });
     }

     if (
       req.method === 'GET' &&
       !['read', 'readInbody', 'readMemberGoal'].includes(action)
     ) {
       return reply(res, 405, {
         status: 'error',
         message: '저장은 POST만 가능합니다.'
       });
     }

     // Fast read-only list; Sheets remains the authority during migration.
     if (action === 'listMembersFast') {
       if (!trainer) return reply(res, 403, {
         status: 'denied', message: '트레이너 전용 기능입니다.'
       });
       const rows = await supabaseGet(base, key,
         '/rest/v1/fit_members?select=name&order=name.asc&limit=1000');
       if (rows.length === 1000) throw Error('member list pagination required');
       return reply(res, 200, {status:'success',members:rows.map(r=>r.name)});
     }

     // Trainer dashboard: build activity and feedback status from Supabase.
     // Video feedback metadata stays in Apps Script until media migration.
     if (action === 'trainerOverview') {
       if (!trainer) return reply(res, 403, {
         status: 'denied', message: '트레이너 전용 기능입니다.'
       });
       const overviewDate = String(params.date || '');
       if (!validDay(overviewDate)) return reply(res, 400, {
         status: 'error', message: '날짜 형식 오류'
       });
       const pageSize = 1000;
       const recordPrefix = '/rest/v1/fit_daily_records?select=member_id,record_date,data&record_date=lte.' +
         overviewDate + '&order=record_date.desc&limit=' + pageSize;
       // Independent Supabase queries can run concurrently.
       const [allMembers, firstPage] = await Promise.all([
         supabaseGet(base, key,
           '/rest/v1/fit_members?select=id,name&order=name.asc&limit=1000'),
         supabaseGet(base, key, recordPrefix + '&offset=0')
       ]);
       if (allMembers.length === 1000) throw Error('too many members for overview');
       const result = new Map(allMembers.map(row => [row.id, {
         name: row.name, lastDate: '', activeToday: false,
         pendingWorkout: false, pendingDiet: false, pendingVideos: 0,
         feedbackDone: false
       }]));
       let offset = 0;
       let records = firstPage;
       while (true) {
         for (const record of records) {
           const item = result.get(record.member_id);
           if (!item) continue;
           const day = String(record.record_date || '');
           const data = record.data || {};
           const routines = Array.isArray(data.routines) ? data.routines : [];
           const completed = routines.some(r =>
             Array.isArray(r.completedSets) && r.completedSets.some(Boolean));
           const reflection = !!String((data.reflection?.good || '') +
             (data.reflection?.bad || '')).trim();
           const diet = data.diet || {};
           const hasDiet = ['breakfast','lunch','dinner','snack'].some(k => {
             const food = diet[k] || {};
             return !!String(food.desc || '').trim() ||
               (Array.isArray(food.photos) && food.photos.length > 0) ||
               (Array.isArray(food.foods) && food.foods.length > 0);
           });
           const active = completed || reflection || hasDiet;
           if (active && day > item.lastDate) item.lastDate = day;
           if (day === overviewDate) {
             item.activeToday ||= active;
             const feedback = data.feedback || {};
             item.pendingWorkout ||= (completed || reflection) &&
               !String(feedback.workout || '').trim();
             item.pendingDiet ||= hasDiet && !String(feedback.diet || '').trim();
             item.feedbackDone ||= !!String(feedback.workout || '').trim() ||
               !!String(feedback.diet || '').trim();
           }
         }
         if (records.length < pageSize) break;
         offset += pageSize;
         if (offset >= 10000) throw Error('overview pagination limit exceeded');
         records = await supabaseGet(base, key, recordPrefix + '&offset=' + offset);
       }
       return reply(res, 200, {status:'success',date:overviewDate,
         members:[...result.values()]});
     }

     const member = String(params.member || '').trim();
     const date = String(params.date || '').trim();
     const token = String(params.token || '').trim();

     if (!member || member.length > 100 || !validDay(date)) {
       return reply(res, 400, {
         status: 'error',
         message: '회원 이름 또는 날짜 형식 오류'
       });
     }

     const matches = await supabaseGet(
       base,
       key,
       `/rest/v1/fit_members?select=id,access_token_hash&name=eq.${encodeURIComponent(member)}&limit=1`
     );

     const found = matches[0];

     if (
       !found ||
       (!trainer && !sameSecret(token, found.access_token_hash))
     ) {
       return reply(res, 403, {
         status: 'denied',
         message: '접근 권한이 없습니다.'
       });
     }

     // Trainer-only staging link for two existing test uploads.
     // Keep all Apps Script rows, feedback and Drive objects unchanged.
     if (action === 'linkVideoStorage') {
       if (!trainer) return reply(res, 403, {
         status:'denied',message:'트레이너 전용 작업입니다.'
       });
       if (req.method !== 'POST') return reply(res, 405, {
         status:'error',message:'POST만 허용됩니다.'
       });
       if (member !== '김윤지') return reply(res, 400, {
         status:'error',message:'테스트 회원 외에는 연결할 수 없습니다.'
       });
       const sourceId=String(params.sourceId||'').trim();
       const fileId=String(params.fileId||'').trim();
       const storagePath=String(params.storagePath||'').trim();
       const allowedPaths=[
         'kim-yunji/kim-yunji-01.mp4.mp4',
         'kim-yunji/kim-yunji-02.mp4.mp4'
       ];
       if (!sourceId || sourceId.length>200 ||
           !fileId || fileId.length>200 ||
           !allowedPaths.includes(storagePath))
         return reply(res, 400, {status:'error',message:'연결 정보가 올바르지 않습니다.'});
       const prefix='/rest/v1/fit_video_metadata?select=id,file_id,storage_path&member_id=eq.'+
         encodeURIComponent(found.id);
       let bySource, byPath;
       try {
         [bySource,byPath]=await Promise.all([
           supabaseGet(base,key,prefix+'&kind=eq.form&source_id=eq.'+
             encodeURIComponent(sourceId)+'&limit=2'),
           supabaseGet(base,key,prefix+'&storage_path=eq.'+
             encodeURIComponent(storagePath)+'&limit=2')
         ]);
       } catch(error) {
         const status=String(error.message||'').match(/Supabase HTTP (\d{3})/);
         console.error('FIT-CONNECT video link metadata read:',error.message);
         return reply(res,503,{status:'error',
           message:'영상 테이블 조회 실패'+(status?' · Supabase HTTP '+status[1]:' · 연결 확인 필요')});
       }
       if(bySource.length===1 && bySource[0].file_id===fileId &&
          bySource[0].storage_path===storagePath)
         return reply(res,200,{status:'success',alreadyLinked:true});
       if(bySource.length || byPath.length) return reply(res, 409, {
         status:'error',message:'이미 다른 파일에 연결된 영상입니다. 원본을 변경하지 않았습니다.'
       });
       // Verify through the same signed URL operation used for actual playback.
       // This avoids inconsistent Storage /object/info auth behavior.
       let proof;
       try {
         proof=await fetch(base+'/storage/v1/object/sign/fit-private-videos/'+
           storagePath.split('/').map(encodeURIComponent).join('/'),{
             method:'POST',
             headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),
               'Content-Type':'application/json'},
             body:JSON.stringify({expiresIn:60}),
             signal:AbortSignal.timeout(10000)
           });
       } catch(error) {
         console.error('FIT-CONNECT video link sign check:',error.message);
         return reply(res,503,{status:'error',
           message:'영상 저장소 서명 연결 실패'});
       }
       if(!proof.ok) {
         let code='';
         try {
           const detail=await proof.json();
           code=String(detail.code||detail.error||detail.error_code||'')
             .replace(/[^a-zA-Z0-9_-]/g,'').slice(0,48);
         } catch(error) {}
         console.error('FIT-CONNECT video link sign status:',proof.status,code);
         return reply(res,409,{status:'error',
           message:'영상 서명 검증 실패 · Storage HTTP '+proof.status+
             (code?' · '+code:'')});
       }
       const signedProof=await proof.json().catch(()=>({}));
       if(!signedProof.signedURL && !signedProof.signedUrl)
         return reply(res,409,{status:'error',
           message:'영상 서명 주소가 생성되지 않았습니다.'});
       const payload={
         member_id:found.id,kind:'form',source_id:sourceId,
         file_id:fileId,storage_path:storagePath
       };
       const inserted=await fetch(base+'/rest/v1/fit_video_metadata',{
         method:'POST',
         headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),
           'Content-Type':'application/json','Prefer':'return=minimal'},
         body:JSON.stringify(payload),
         signal:AbortSignal.timeout(10000)
       });
       if(!inserted.ok){
         if(inserted.status===409)return reply(res,409,{
           status:'error',message:'영상 연결 충돌. 원본은 변경하지 않았습니다.'
         });
         console.error('FIT-CONNECT video link insert:',inserted.status);
         return reply(res,503,{status:'error',
           message:'영상 테이블 연결 저장 실패 · Supabase HTTP '+inserted.status});
       }
       return reply(res,200,{status:'success'});
     }

     // Streamable private video playback after a metadata + Storage migration.
     // Until the object exists in Storage, the client uses legacy Drive playback.
     if (action === 'videoPlaybackUrl') {
       const fileId = String(params.fileId || '').trim();
       if (!fileId || fileId.length > 200)
         return reply(res, 400, {status:'error',message:'영상 ID 오류'});
       const matches = await supabaseGet(base, key,
         '/rest/v1/fit_video_metadata?select=storage_path&member_id=eq.' +
         encodeURIComponent(found.id) + '&file_id=eq.' + encodeURIComponent(fileId) +
         '&limit=2');
       if (!matches.length || !matches[0].storage_path)
         return reply(res, 200, {status:'not_migrated'});
       if (matches.length !== 1)
         return reply(res, 409, {status:'error',message:'영상 중복 데이터 확인 필요'});
       const path = String(matches[0].storage_path || '');
       if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(path) ||
           path.includes('..') || path.length > 500)
         return reply(res, 409, {status:'error',message:'영상 저장 경로 오류'});
       const bucket = 'fit-private-videos';
       const signed = await fetch(base + '/storage/v1/object/sign/' + bucket + '/' +
         path.split('/').map(encodeURIComponent).join('/'), {
           method:'POST',
           headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json'},
           body:JSON.stringify({expiresIn:3600}),
           signal:AbortSignal.timeout(10000)
         });
       if (!signed.ok) throw Error('private video signing failed');
       const item = await signed.json();
       const partial = String(item.signedURL || item.signedUrl || '');
       if (!partial) throw Error('private video signature missing');
       const relative = partial.startsWith('/object/')
         ? '/storage/v1' + partial : partial;
       const url = new URL(relative, base);
       if (url.origin !== base)
         throw Error('private video signature origin mismatch');
       return reply(res, 200, {status:'success',url:url.toString()});
     }

     // Original spreadsheet InBody rows stay untouched. New rows are stored
     // under a member-specific namespace with a unique measurement-date key.
     const inbodySheet = 'InbodyRecords.' + found.id;
     // Consolidated read: 1 authenticated Vercel request, parallel DB queries.
     if (action === 'insightsBundle') {
       // Bundle four metadata lookups into a single indexed PostgREST read.
       // Preserve legacy/new namespaces and existing goal precedence.
       const sheets = ['InbodyRecords', inbodySheet, 'MemberGoals',
         'MemberGoals.' + found.id];
       const auxPath = '/rest/v1/fit_auxiliary_records?select=source_sheet,source_row,data' +
         '&member_id=eq.' + encodeURIComponent(found.id) +
         '&source_sheet=in.(' + sheets.map(encodeURIComponent).join(',') + ')' +
         '&limit=1000';
       const [rows, auxiliary] = await Promise.all([
         getMemberHistory(base, key, found.id, date),
         supabaseGet(base, key, auxPath)
       ]);
       if (auxiliary.length === 1000)
         throw Error('auxiliary record pagination required');
       const getSheetRows = name => auxiliary.filter(x => x.source_sheet === name)
         .sort((a,b) => Number(a.source_row) - Number(b.source_row));
       const oldInbody = getSheetRows('InbodyRecords');
       const newInbody = getSheetRows(inbodySheet);
       const oldGoals = getSheetRows('MemberGoals').reverse().slice(0,1);
       const newGoals = getSheetRows('MemberGoals.' + found.id).slice(0,1);
       const records = new Map();
       for (const row of [...oldInbody, ...newInbody]) {
         const item = row?.data || {};
         const d = String(item.Date || item.date || '');
         if (!validDay(d)) continue;
         const weight = Number(item.Weight ?? item.weight);
         const muscle = Number(item.Muscle ?? item.muscle);
         const fat = Number(item.FatPercent ?? item.fat);
         if (![weight, muscle, fat].every(Number.isFinite)) continue;
         records.set(d, { date: d, weight, muscle, fat });
       }
       const inbody = [...records.values()].sort((a,b) => a.date.localeCompare(b.date));
       const goalRow = (newGoals[0] || oldGoals[0] || {}).data || {};
       const goal = {
         targetWeight: goalRow.TargetWeight ?? goalRow.targetWeight ?? '',
         weeklyDays: goalRow.WeeklyDays ?? goalRow.weeklyDays ?? 0,
         deadline: goalRow.Deadline ?? goalRow.deadline ?? '',
         note: goalRow.Note ?? goalRow.note ?? ''
       };
       const result = buildMemberInsights(rows, date);
       const monthlyInbody = inbody.filter(x => x.date.startsWith(date.slice(0,7)) && x.date <= date);
       if (monthlyInbody.length > 1) {
         const first = monthlyInbody[0], last = monthlyInbody[monthlyInbody.length-1];
         result.monthly.inbodyChange = {
           weight: last.weight - first.weight,
           muscle: last.muscle - first.muscle,
           fat: last.fat - first.fat
         };
       }
       return reply(res, 200, { ...result, inbody, goal });
     }

     if (action === 'readInbody') {
       const prefix = '/rest/v1/fit_auxiliary_records?select=data&member_id=eq.'
         + encodeURIComponent(found.id) + '&source_sheet=eq.';
       const [legacy, recent] = await Promise.all([
         supabaseGet(base, key, prefix + encodeURIComponent('InbodyRecords') + '&order=source_row.asc'),
         supabaseGet(base, key, prefix + encodeURIComponent(inbodySheet) + '&order=source_row.asc')
       ]);
       const byDate = new Map();
       for (const record of [...legacy, ...recent]) {
         const item = record && record.data;
         if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
         const day = String(item.Date || item.date || '');
         if (!validDay(day)) continue;
         const weight = Number(item.Weight ?? item.weight);
         const muscle = Number(item.Muscle ?? item.muscle);
         const fat = Number(item.FatPercent ?? item.fat);
         if (![weight, muscle, fat].every(Number.isFinite)) continue;
         byDate.set(day, { date: day, weight, muscle, fat });
       }
       return reply(res, 200, {
         status: 'success',
         records: [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date))
       });
     }

     if (action === 'saveInbody') {
       if (!trainer) return reply(res, 403, {
         status: 'denied', message: '트레이너 전용 기능입니다.'
       });
       const recordDate = String(params.recordDate || '');
       const numeric = (v) => v === '' || v === null || v === undefined ? NaN : Number(v);
       const weight = numeric(params.weight);
       const muscle = numeric(params.muscle);
       const fat = numeric(params.fat);
       if (!validDay(recordDate) || !Number.isFinite(weight) || weight <= 0 || weight > 500
         || !Number.isFinite(muscle) || muscle < 0 || muscle > 500
         || !Number.isFinite(fat) || fat < 0 || fat > 100) {
         return reply(res, 400, { status: 'error', message: '인바디 측정값을 확인해주세요.' });
       }
       const row = {
         source_sheet: inbodySheet,
         source_row: Number(recordDate.replace(/-/g, '')),
         member_id: found.id,
         data: { Date: recordDate, Weight: weight, Muscle: muscle, FatPercent: fat }
       };
       const response = await fetch(
         base + '/rest/v1/fit_auxiliary_records?on_conflict=source_sheet,source_row',
         {
           method: 'POST',
           headers: {
             apikey: key,
             'Content-Type': 'application/json',
             Prefer: 'resolution=merge-duplicates,return=minimal'
           },
           body: JSON.stringify(row),
           signal: AbortSignal.timeout(10000)
         }
       );
       if (!response.ok) throw new Error('Supabase InBody save HTTP ' + response.status);
       return reply(res, 200, { status: 'success' });
     }

     // Keep imported spreadsheet goals intact; new goals are member-scoped.
     const goalSheet = 'MemberGoals.' + found.id;
     if (action === 'readMemberGoal') {
       const prefix = '/rest/v1/fit_auxiliary_records?select=data&member_id=eq.'
         + encodeURIComponent(found.id) + '&source_sheet=eq.';
       const [legacy, current] = await Promise.all([
         supabaseGet(base, key, prefix + encodeURIComponent('MemberGoals') + '&order=source_row.desc&limit=1'),
         supabaseGet(base, key, prefix + encodeURIComponent(goalSheet) + '&limit=1')
       ]);
       const goal = (current[0] || legacy[0] || {}).data || {};
       return reply(res, 200, {
         status: 'success',
         goal: {
           targetWeight: goal.TargetWeight ?? goal.targetWeight ?? '',
           weeklyDays: goal.WeeklyDays ?? goal.weeklyDays ?? 0,
           deadline: goal.Deadline ?? goal.deadline ?? '',
           note: goal.Note ?? goal.note ?? ''
         }
       });
     }

     if (action === 'saveMemberGoal') {
       if (!trainer) return reply(res, 403, {
         status: 'denied', message: '트레이너 전용 기능입니다.'
       });
       const numberOrEmpty = v => v === '' || v === null || v === undefined ? null : Number(v);
       const targetWeight = numberOrEmpty(params.targetWeight);
       const weeklyDays = numberOrEmpty(params.weeklyDays);
       const deadline = String(params.deadline || '');
       const note = String(params.note || '').trim();
       if ((targetWeight !== null && (!Number.isFinite(targetWeight) || targetWeight <= 0 || targetWeight > 500))
         || (weeklyDays !== null && (!Number.isInteger(weeklyDays) || weeklyDays < 0 || weeklyDays > 7))
         || (deadline && !validDay(deadline)) || note.length > 500) {
         return reply(res, 400, { status: 'error', message: '회원 목표 입력값을 확인해주세요.' });
       }
       const row = {
         source_sheet: goalSheet,
         source_row: 1,
         member_id: found.id,
         data: {
           TargetWeight: targetWeight,
           WeeklyDays: weeklyDays ?? 0,
           Deadline: deadline,
           Note: note
         }
       };
       const response = await fetch(base + '/rest/v1/fit_auxiliary_records?on_conflict=source_sheet,source_row', {
         method: 'POST',
         headers: {
           apikey: key,
           'Content-Type': 'application/json',
           Prefer: 'resolution=merge-duplicates,return=minimal'
         },
         body: JSON.stringify(row),
         signal: AbortSignal.timeout(10000)
       });
       if (!response.ok) throw new Error('Supabase MemberGoal save HTTP ' + response.status);
       return reply(res, 200, { status: 'success' });
     }

     if (action === 'memberInsights' || action === 'workoutHistory') {
       const rows = await getMemberHistory(base, key, found.id, date);
       if (action === 'workoutHistory') {
         const month = String(params.month || date.slice(0, 7));
         if (!/^\d{4}-\d{2}$/.test(month))
           return reply(res, 400, {status:'error',message:'월 형식 오류'});
         return reply(res, 200, buildWorkoutHistory(rows, date, month));
       }
       return reply(res, 200, buildMemberInsights(rows, date));
     }

     // Existing daily record reading.
     if (action === 'read') {
       const records = await supabaseGet(
         base,
         key,
         `/rest/v1/fit_daily_records?select=data&member_id=eq.${encodeURIComponent(found.id)}&record_date=eq.${date}&limit=1`
       );

       return reply(
         res,
         200,
         records.length ? records[0].data : {}
       );
     }

     if (JSON.stringify(params).length > 200000) {
       return reply(res, 413, {
         status: 'error',
         message: '저장 데이터가 너무 큽니다.'
       });
     }

     let payload;

     if (action === 'save') {
       const incoming = params.data;

       if (
         !incoming ||
         typeof incoming !== 'object' ||
         Array.isArray(incoming)
       ) {
         return reply(res, 400, {
           status: 'error',
           message: '잘못된 저장 데이터입니다.'
         });
       }

       const allowed = trainer
         ? [
             'routines',
             'reflection',
             'diet',
             'memos',
             'feedback',
             'headerMessage'
           ]
         : [
             'routines',
             'reflection',
             'diet',
             'memos'
           ];

       payload = {
         data: Object.fromEntries(
           allowed
             .filter(k =>
               Object.prototype.hasOwnProperty.call(incoming, k)
             )
             .map(k => [k, incoming[k]])
         )
       };
     } else if (action === 'patchData') {
       payload = { patch: params.patch };
     } else {
       payload = { changes: params.changes };
     }

     const saved = await supabaseWrite(
       base,
       key,
       '/rest/v1/rpc/fit_save_daily',
       {
         p_member_id: found.id,
         p_date: date,
         p_action: action,
         p_payload: payload,
         p_trainer: trainer
       }
     );

     return reply(res, 200, {
       status: 'success',
       data: saved
     });

   } catch (error) {
     console.error(
       'FIT-CONNECT read route:',
       error.message
     );

     return reply(res, 503, {
       status: 'error',
       message: '데이터 조회가 실패했습니다.'
     });
   }
 };
