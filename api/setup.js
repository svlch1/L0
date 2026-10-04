export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!token || !host) return res.status(500).json({ok:false,error:"missing_env"});
  const url = "https://" + host + "/api/telegram";
  const r = await fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({url})
  });
  const data = await r.json();
  return res.status(r.ok ? 200 : 500).json({ok:r.ok, webhook:url, telegram:data});
}
