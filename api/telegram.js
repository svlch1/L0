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

function compactTokens(n) {
  n = Number(n || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function usd(n) {
  return "$" + Number(n || 0).toFixed(3);
}

function money(n) {
  n = Number(n || 0);
  return n > 0 ? "$" + Math.round(n).toLocaleString("en-US") : "нет данных";
}

function almostText(state) {
  const items = Object.values(state.almost_gems_by_key || {})
    .filter((x) => Number(x.score || 0) >= 7.8 && Number(x.score || 0) < 8.5)
    .sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff) return scoreDiff;
      return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    })
    .slice(0, 8);

  if (!items.length) {
    return [
      "🟡 Почти гемы 7.8–8.4",
      "",
      "Сейчас таких машин в кэше нет.",
      "Они появятся здесь после следующих глубоких проверок.",
      "",
      "🔥 Настоящий GEM начинается с 8.5/10."
    ].join("\n");
  }

  const blocks = items.map((x, i) => {
    const url = x.auto_ria_url || x.telegram_url || "";
    const mileage = Number(x.mileage_km || 0) > 0
      ? Math.round(Number(x.mileage_km)).toLocaleString("ru-RU") + " км"
      : "нет данных";
    const target = Number(x.target_buy_price_usd || 0) > 0
      ? money(x.target_buy_price_usd)
      : "нет данных";
    const verdict = String(x.verdict || "").replace(/\s+/g, " ").slice(0, 220);

    return [
      `${i + 1}. 🟡 ${x.model || "Авто"} ${x.year || ""} ${x.trim || ""}`.trim(),
      `⭐ ${Number(x.score || 0).toFixed(2)}/10 · confidence ${Number(x.confidence_pct || 0)}%`,
      `💵 ${money(x.price_usd)} · 🛣 ${mileage}`,
      `🎯 Интересная цена: ${target}`,
      verdict ? `💬 ${verdict}` : null,
      url ? `🔗 ${url}` : null,
    ].filter(Boolean).join("\n");
  });

  return [
    "🟡 Почти гемы — рейтинг 7.8–8.4",
    "Автоматически я их не присылаю. Только по /almost.",
    "",
    ...blocks
  ].join("\n\n").slice(0, 3900);
}

function topText(state) {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const items = Object.values(state.top_gems_by_key || {})
    .filter((x) => {
      const at = Date.parse(x.found_at || x.updated_at || "");
      return at && at >= cutoff && Number(x.score || 0) >= 8.5;
    })
    .sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff) return scoreDiff;
      return String(b.found_at || "").localeCompare(String(a.found_at || ""));
    })
    .slice(0, 10);

  if (!items.length) {
    return [
      "🏆 Топ ГЕМов за последние 30 дней",
      "",
      "Пока ни одной машины не прошло финальный порог >=8.5/10.",
      "Как только бот найдёт первый ГЕМ — он появится здесь."
    ].join("\n");
  }

  const blocks = items.map((x, i) => {
    const date = x.found_at ? formatKyiv(x.found_at).split(",")[0] : "нет даты";
    const pluses = Array.isArray(x.pluses) && x.pluses.length
      ? x.pluses.map((p) => "✅ " + String(p).replace(/\s+/g, " ")).join("\n")
      : "✅ Сильная совокупность цены и состояния";
    const minus = String(x.minus || "Явных критичных минусов не найдено.")
      .replace(/\s+/g, " ")
      .slice(0, 170);

    return [
      `${i + 1}. 🔥 ${x.model || "Авто"} ${x.year || ""} ${x.trim || ""}`.trim(),
      `⭐ ${Number(x.score || 0).toFixed(2)}/10 · ${money(x.price_usd)} · найден ${date}`,
      pluses,
      `⚠️ ${minus}`,
      x.url ? `🔗 ${x.url}` : null,
    ].filter(Boolean).join("\n");
  });

  return [
    "🏆 Топ ГЕМов за последние 30 дней",
    "",
    ...blocks
  ].join("\n\n").slice(0, 4000);
}

function statusText(state) {
  let result = "ещё не было проверки";
  if (state.last_check_status === "no_gem") result = "ГЕМов не найдено";
  else if (state.last_check_status === "found") result = `найдено ГЕМов: ${state.last_sent_count || 0}`;
  else if (state.last_check_status === "error") result = "ошибка последнего прохода";

  const healthy = state.last_check_status !== "error";
  const usage = state.last_api_usage || null;
  const today = state.api_usage_today || null;
  const watchCount = Object.keys(state.market_watch || {}).length;
  const almostCount = Object.values(state.almost_gems_by_key || {})
    .filter((x) => Number(x.score || 0) >= 7.8 && Number(x.score || 0) < 8.5)
    .length;

  return [
    healthy ? "🟢 Car Gem Scout работает" : "🔴 Car Gem Scout: есть ошибка",
    "",
    `🕒 Последняя проверка: ${formatKyiv(state.last_check_at)}`,
    `🔎 Результат: ${result}`,
    `🔬 Глубоко проверено Luna: ${state.last_deep_analyzed_count || 0}`,
    `👀 Машин под наблюдением: ${watchCount}`,
    `🟡 Почти гемов 7.8–8.4: ${almostCount}`,
    `🔥 Всего отправлено ГЕМов: ${state.total_gems_sent || 0}`,
    usage ? `💸 Последний проход: ~${usd(usage.estimated_cost_usd)}` : "💸 Стоимость появится после следующего прохода",
    today ? `📅 Сегодня: ~${usd(today.estimated_cost_usd)}` : null,
    `⏭ Следующая проверка: ~${formatKyiv(nextScheduledCheck())}`,
    "",
    "⌨️ Команды",
    "/status — статус бота",
    "/almost — машины 7.8–8.4",
    "/top — лучшие ГЕМЫ за 30 дней",
  ].filter(Boolean).join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, service: "Car Gem Scout webhook" });
  }

  const message = req.body?.message;
  if (!message?.chat?.id || message.chat.type !== "private") {
    return res.status(200).json({ ok: true });
  }

  const text = String(message.text || "").trim().toLowerCase();
  if (!/^\/(start|status|almost|top)(@\w+)?\b/.test(text)) {
    return res.status(200).json({ ok: true });
  }

  const state = await loadState();
  const reply = /^\/almost(@\w+)?\b/.test(text)
    ? almostText(state)
    : /^\/top(@\w+)?\b/.test(text)
      ? topText(state)
      : statusText(state);

  return res.status(200).json({
    method: "sendMessage",
    chat_id: String(message.chat.id),
    text: reply,
    disable_web_page_preview: false
  });
}
