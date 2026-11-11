module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      status: "method_not_allowed"
    });
  }

  const base = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!base || !secret) {
    return res.status(503).json({
      ok: false,
      status: "configuration_missing"
    });
  }

  try {
    const project = new URL(base);

    if (
      project.protocol !== "https:" ||
      !project.hostname.endsWith(".supabase.co")
    ) {
      return res.status(503).json({
        ok: false,
        status: "configuration_invalid"
      });
    }

    const response = await fetch(
      `${project.origin}/rest/v1/fit_members?select=id&limit=0`,
      {
        method: "GET",
        headers: {
          apikey: secret,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!response.ok) {
      return res.status(503).json({
        ok: false,
        status: "database_unavailable",
        upstream_http_status: response.status
      });
    }

    return res.status(200).json({
      ok: true,
      status: "connected"
    });

  } catch (error) {
    return res.status(503).json({
      ok: false,
      status: "connection_failed"
    });
  }
};
