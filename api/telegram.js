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

function candidatesText(state) {
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  const seen = new Map();

  for (const item of Object.values(state.preliminary_candidates_by_key || {})) {
    const score = Number(item.discovery_score || 0);
    const at = Date.parse(item.updated_at || item.first_seen_at || "");
    if (score < 7.5 || score >= 8.5 || !at || at < cutoff) continue;
    seen.set(item.key || item.url, item);
  }

  // Backward-compatible fallback for candidates already sitting in deep_queue
  // before this command was introduced.
  for (const item of Object.values(state.deep_queue || {})) {
    const score = Number(item.discovery_score || 0);
    if (score < 7.5 || score >= 8.5) continue;
    const key = item.candidate_key || item.auto_ria_url || item.telegram_url || item.source_url;
    if (seen.has(key)) continue;
    seen.set(key, {
      key,
      model: item.model || "",
      year: Number(item.year || 0),
      discovery_score: score,
      price_usd: Number(item.price_usd || 0),
      mileage_km: Number(item.mileage_km || 0),
      source: item.source || "",
      url: item.auto_ria_url || item.telegram_url || item.source_url || "",
      reason: item.listing_note || "в очереди на глубокую проверку Luna",
      updated_at: item.last_queued_at || item.enqueued_at || "",
    });
  }

  const items = [...seen.values()]
    .sort((a,b) => {
      const d = Number(b.discovery_score || 0) - Number(a.discovery_score || 0);
      if (d) return d;
      return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    })
    .slice(0, 10);

  if (!items.length) {
    return [
      "🎯 Кандидаты до deep — preliminary 7.5–8.4",
      "",
      "Сейчас таких машин нет.",
      "Сюда попадают варианты после дешёвого первичного отбора, но до полноценной VIN/history-проверки Luna."
    ].join("\n");
  }

  const blocks = items.map((x,i) => {
    const mileage = Number(x.mileage_km || 0) > 0
      ? Math.round(Number(x.mileage_km)).toLocaleString("ru-RU") + " км"
      : "нет данных";
    const reason = String(x.reason || "").replace(/\s+/g," ").trim().slice(0,170);
    return [
      `${i+1}. 🎯 ${x.model || "Авто"} ${x.year || ""}`.trim(),
      `⭐ preliminary ${Number(x.discovery_score || 0).toFixed(1)}/10 · ${money(x.price_usd)} · ${mileage}`,
      x.source ? `📍 Источник: ${x.source}` : null,
      reason ? `💬 ${reason}` : null,
      x.url ? `🔗 ${x.url}` : null,
    ].filter(Boolean).join("\n");
  });

  return [
    "🎯 Кандидаты до deep — preliminary 7.5–8.4",
    "Это НЕ финальный рейтинг: VIN/history и реальные риски ещё не проверены глубоко.",
    "",
    ...blocks
  ].join("\n\n").slice(0, 4000);
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

function interestingText(state) {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const items = Object.values(state.interesting_by_key || {})
    .filter((x) => {
      const at = Date.parse(x.updated_at || x.found_at || "");
      return at && at >= cutoff && Number(x.potential_score || 0) >= 8.0;
    })
    .sort((a,b) => {
      const d = Number(b.potential_score || 0) - Number(a.potential_score || 0);
      if (d) return d;
      return Number(b.penalty_points || 0) - Number(a.penalty_points || 0);
    })
    .slice(0, 8);

  if (!items.length) {
    return [
      "🧩 Интересные варианты",
      "",
      "Сейчас нет машин, которые выглядели бы как потенциальные 8+/10, но получили заметный штраф за конкретный риск.",
      "Команда заполняется только после глубокой проверки Luna."
    ].join("\n");
  }

  const blocks = items.map((x,i) => {
    const reasons = Array.isArray(x.reasons) && x.reasons.length
      ? x.reasons.map((r) => "⚠️ " + String(r).replace(/\s+/g," ")).join("\n")
      : "⚠️ Причина штрафа сохранена не полностью";
    return [
      `${i+1}. 🧩 ${x.model || "Авто"} ${x.year || ""} ${x.trim || ""}`.trim(),
      `⭐ Итог: ${Number(x.score || 0).toFixed(2)}/10 · потенциал: ${Number(x.potential_score || 0).toFixed(2)}/10`,
      `📉 Штраф: -${Number(x.penalty_points || 0).toFixed(2)} балла · ${money(x.price_usd)}`,
      reasons,
      x.verdict ? `💬 ${String(x.verdict).slice(0,180)}` : null,
      x.url ? `🔗 ${x.url}` : null,
    ].filter(Boolean).join("\n");
  });

  return [
    "🧩 Интересные варианты",
    "Это машины с хорошим потенциалом, которым итоговый рейтинг заметно снизил конкретный риск. Автоматически их не присылаю.",
    "",
    ...blocks
  ].join("\n\n").slice(0,4000);
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

function telegramCoverageText(stats) {
  const channels = stats?.telegram_channels || {};
  const parts = Object.values(channels)
    .map((x) => ({
      label: String(x.label || "").trim(),
      posts: Number(x.raw_posts_seen || 0),
    }))
    .filter((x) => x.label);

  if (!parts.length) return "Telegram: данных пока нет";
  const total = parts.reduce((sum,x) => sum + x.posts, 0);
  return `Telegram: ${parts.length} каналов / ${total} постов · ` +
    parts.map((x) => `${x.label} ${x.posts}`).join(" · ");
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
  const interestingCount = Object.keys(state.interesting_by_key || {}).length;
  const preliminaryKeys = new Set();
  for (const x of Object.values(state.preliminary_candidates_by_key || {})) {
    const score = Number(x.discovery_score || 0);
    if (score >= 7.5 && score < 8.5) preliminaryKeys.add(x.key || x.url);
  }
  for (const x of Object.values(state.deep_queue || {})) {
    const score = Number(x.discovery_score || 0);
    if (score >= 7.5 && score < 8.5) {
      preliminaryKeys.add(x.candidate_key || x.auto_ria_url || x.telegram_url || x.source_url);
    }
  }
  const preliminaryCount = preliminaryKeys.size;
  const tgLine = telegramCoverageText(state.last_collector_stats || {});
  const deepQueue = Number(state.last_deep_queue_count || 0);
  const lastQuality = Array.isArray(state.quality_history) && state.quality_history.length
    ? state.quality_history[state.quality_history.length - 1]
    : null;
  const cheapReviewed = Number(lastQuality?.source_batch_to_luna || 0);

  return [
    healthy ? "🟢 Car Gem Scout работает" : "🔴 Car Gem Scout: есть ошибка",
    "",
    `🕒 Последняя проверка: ${formatKyiv(state.last_check_at)}`,
    `🔎 Итог: ${result}`,
    "",
    cheapReviewed ? `👓 Luna первично просмотрела: ${cheapReviewed}` : null,
    `🎯 Из них перспективными сочла: ${state.last_discovered_count || 0}`,
    `🔬 Luna успешно проверила: ${Math.max(0, Number(state.last_deep_analyzed_count || 0) - Number(state.last_deep_failed_count || 0))}`,
    `⏳ Ждут глубокой проверки Luna: ${deepQueue}`,
    Number(state.last_deep_failed_count || 0) ? `↻ На повтор после ошибки: ${state.last_deep_failed_count}` : null,
    `🎯 Кандидатов 7.5–8.4 до deep: ${preliminaryCount}`,
    `🟡 Почти гемов 7.8–8.4: ${almostCount}`,
    `🧩 Интересных вариантов со штрафом: ${interestingCount}`,
    `🔥 Всего отправлено ГЕМов: ${state.total_gems_sent || 0}`,
    `👀 Машин под наблюдением за ценой: ${watchCount}`,
    "",
    `📲 ${tgLine}`,
    usage ? `💸 Последний проход: ~${usd(usage.estimated_cost_usd)}` : "💸 Стоимость появится после следующего прохода",
    today ? `📅 Сегодня: ~${usd(today.estimated_cost_usd)}` : null,
    `⏭ Следующая проверка: ~${formatKyiv(nextScheduledCheck())}`,
    "",
    "⌨️ /status · /candidates · /almost · /interesting · /top",
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
  if (!/^\/(start|status|candidates|almost|interesting|top)(@\w+)?\b/.test(text)) {
    return res.status(200).json({ ok: true });
  }

  const state = await loadState();
  const reply = /^\/candidates(@\w+)?\b/.test(text)
    ? candidatesText(state)
    : /^\/almost(@\w+)?\b/.test(text)
      ? almostText(state)
      : /^\/interesting(@\w+)?\b/.test(text)
        ? interestingText(state)
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
