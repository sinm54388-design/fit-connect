
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
       'saveInbody'
     ];

     if (!allowedActions.includes(action)) {
       return reply(res, 400, {
         status: 'error',
         message: '지원하지 않는 작업입니다.'
       });
     }

     if (
       req.method === 'GET' &&
       !['read', 'readInbody'].includes(action)
     ) {
       return reply(res, 405, {
         status: 'error',
         message: '저장은 POST만 가능합니다.'
       });
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

     // Original spreadsheet InBody rows stay untouched. New rows are stored
     // under a member-specific namespace with a unique measurement-date key.
     const inbodySheet = 'InbodyRecords.' + found.id;
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
