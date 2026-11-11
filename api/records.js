// FIT-CONNECT: stage 1 read-only Supabase route.
// Safe to deploy alongside the current Google Sheets app. No writes are performed.
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
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

async function supabaseGet(base, key, path) {
  const response = await fetch(`${base}${path}`, {
    headers: { apikey: key, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST')
    return reply(res, 405, { status: 'error', message: '허용되지 않은 요청입니다.' });

  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SECRET_KEY || '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) || !key)
    return reply(res, 503, { status: 'error', message: '서버 설정이 없습니다.' });

  try {
    let params = req.query || {};
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      params = body && typeof body === 'object' ? body : {};
    }
    const action = String(params.action || 'read');
    const trainer = sameSecret(params.password, process.env.TRAINER_PASSWORD);
    if (action === 'verify') return reply(res, 200, { status: trainer ? 'success' : 'denied' });
    if (action !== 'read')
      return reply(res, 400, { status: 'error', message: '현재 읽기 테스트만 지원합니다.' });

    const member = String(params.member || '').trim();
    const date = String(params.date || '').trim();
    const token = String(params.token || '').trim();
    if (!member || member.length > 100 || !validDay(date))
      return reply(res, 400, { status: 'error', message: '회원 이름 또는 날짜 형식 오류' });

    const matches = await supabaseGet(base, key,
      `/rest/v1/fit_members?select=id,access_token_hash&name=eq.${encodeURIComponent(member)}&limit=1`);
    const found = matches[0];
    if (!found || (!trainer && !sameSecret(token, found.access_token_hash)))
      return reply(res, 403, { status: 'denied', message: '접근 권한이 없습니다.' });

    const records = await supabaseGet(base, key,
      `/rest/v1/fit_daily_records?select=data&member_id=eq.${encodeURIComponent(found.id)}&record_date=eq.${date}&limit=1`);
    return reply(res, 200, records.length ? records[0].data : {});
  } catch (error) {
    console.error('FIT-CONNECT read route:', error.message);
    return reply(res, 503, { status: 'error', message: '데이터 조회가 실패했습니다.' });
  }
};
