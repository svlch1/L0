const STATE_URL = "https://raw.githubusercontent.com/svlch1/L0/main/seen.json";

function formatKyiv(iso) {
  if (!iso) return "ещё не было";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function nextScheduledCheck() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(Math.floor(d.getUTCHours() / 4) * 4 + 4);
  return d.toISOString();
}

async function loadState() {
  try {
    const r = await fetch(STATE_URL + "?t=" + Date.now(), {
      headers: { "cache-control": "no-cache" },
    });
    if (!r.ok) throw new Error("state fetch failed");
    return await r.json();
  } catch {
    return {};
  }
}

function statusText(state) {
  let result = "ещё нет завершённых проверок";

  if (state.last_check_status === "no_gem") {
    result = "ничего достойного не найдено";
  } else if (state.last_check_status === "found") {
    result = `найдено и показано: ${state.last_sent_count || 0}`;
  } else if (state.last_check_status === "error") {
    result = `ошибка: ${state.last_error || "неизвестная"}`;
  }

  const healthy = state.last_check_status !== "error";

  return [
    healthy ? "🟢 Car Gem Scout работает" : "🔴 Car Gem Scout: есть ошибка",
    "",
    "⏱ Режим: каждые 4 часа / 6 раз в сутки",
    `🕒 Последняя проверка: ${formatKyiv(state.last_check_at)}`,
    `🔎 Результат: ${result}`,
    `📊 Всего показано гемов: ${state.total_gems_sent || 0}`,
    `🔁 Завершённых проходов: ${state.completed_runs || 0}`,
    `⏭ Следующая проверка: ~${formatKyiv(nextScheduledCheck())}`,
    "",
    "Источники: AUTO.RIA + KIEVAVTO + IsAuto",
    "Фильтр: только реальные ГЕМЫ ≥ 8.5/10",
  ].join("\n");
}

async function sendTelegram(token, chatId, text) {
  const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error("Telegram sendMessage failed: " + body.slice(0, 500));
  }
}

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, service: "Car Gem Scout webhook" });
  }

  if (!token) {
    return res.status(500).json({ ok: false, error: "missing_bot_token" });
  }

  const message = req.body?.message;
  if (!message?.chat?.id || message.chat.type !== "private") {
    return res.status(200).json({ ok: true });
  }

  const text = String(message.text || "").trim().toLowerCase();
  if (!/^\/(start|status)(@\w+)?\b/.test(text)) {
    return res.status(200).json({ ok: true });
  }

  const state = await loadState();
  await sendTelegram(token, String(message.chat.id), statusText(state));

  return res.status(200).json({ ok: true });
}
