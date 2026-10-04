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
  const usage = state.last_api_usage || null;
  const today = state.api_usage_today || null;
  const lunaCalls = Number(usage?.by_model?.["gpt-6-luna"]?.calls || 0);
  const solCalls = Number(usage?.by_model?.["gpt-6.1-sol"]?.calls || 0);
  const collector = state.last_collector_stats || {};

  return [
    healthy ? "🟢 Car Gem Scout работает" : "🔴 Car Gem Scout: есть ошибка",
    "",
    "⏱ Режим: каждые 4 часа / 6 раз в сутки",
    `🕒 Последняя проверка: ${formatKyiv(state.last_check_at)}`,
    `🔎 Результат: ${result}`,
    collector.auto_ria_models ? `🗺 Покрытие: AUTO.RIA ${collector.auto_ria_models} моделей / ${collector.auto_ria_pages_scanned || 0} страниц; Telegram ${collector.telegram_pages_scanned || 0} страниц` : null,
    `🧲 Кандидатов в последнем discovery: ${state.last_discovered_count || 0}`,
    `🔬 Luna deep-analysis: ${state.last_deep_analyzed_count || 0}`,
    `🧠 Sol final audit: ${state.last_sol_audits || 0}`,
    `👀 Машин под price-watch: ${Object.keys(state.market_watch || {}).length}`,
    `📊 Всего показано гемов: ${state.total_gems_sent || 0}`,
    usage ? `💸 API последний проход: ~${usd(usage.estimated_cost_usd)} (Luna ${lunaCalls} / Sol ${solCalls})` : "💸 API последний проход: учёт включится со следующего прохода",
    usage ? `🪙 Tokens: in ${compactTokens(usage.input_tokens)} / out ${compactTokens(usage.output_tokens)} / web ${usage.web_search_calls || 0}` : null,
    today ? `📅 API сегодня (учтено ботом): ~${usd(today.estimated_cost_usd)}` : null,
    `🔁 Завершённых проходов: ${state.completed_runs || 0}`,
    `⏭ Следующая проверка: ~${formatKyiv(nextScheduledCheck())}`,
    "",
    "Источники: AUTO.RIA + KIEVAVTO + IsAuto",
    "Фильтр: только реальные ГЕМЫ ≥ 8.5/10",
    "Команды: /status · /almost",
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
  if (!/^\/(start|status|almost)(@\w+)?\b/.test(text)) {
    return res.status(200).json({ ok: true });
  }

  const state = await loadState();
  const reply = /^\/almost(@\w+)?\b/.test(text)
    ? almostText(state)
    : statusText(state);

  return res.status(200).json({
    method: "sendMessage",
    chat_id: String(message.chat.id),
    text: reply,
    disable_web_page_preview: false
  });
}
