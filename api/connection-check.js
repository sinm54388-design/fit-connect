// Temporary FIT-CONNECT migration readiness check.
// The Supabase secret remains exclusively in Vercel server environment variables.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false });

  const base = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!base || !secret) return res.status(503).json({ ok: false, status: 'configuration_missing' });

  try {
    const project = new URL(base);
    if (project.protocol !== 'https:' || !project.hostname.endsWith('.supabase.co')) {
      return res.status(503).json({ ok: false, status: 'configuration_invalid' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(`${project.origin}/rest/v1/fit_members?select=id&limit=0`, {
        headers: { apikey: secret, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    if (!response.ok) return res.status(503).json({ ok: false, status: 'database_unavailable' });
    return res.status(200).json({ ok: true, status: 'connected' });
  } catch (_) {
    return res.status(503).json({ ok: false, status: 'connection_failed' });
  }
}
