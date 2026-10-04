import fs from "node:fs";
import crypto from "node:crypto";
import { collectDirectSources, commitObservedUrls } from "./sources.mjs";
import { weightedScore, calibrateAnalysis } from "./scoring.mjs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TEST_ONLY = process.env.TEST_ONLY === "true";
const ANALYST_ONLY = process.env.ANALYST_ONLY === "true";
const SOURCE_BATCH_LIMIT = Math.max(1, Math.min(96, Number(process.env.SOURCE_BATCH_LIMIT || 32)));

const LUNA_MODEL = "gpt-6-luna";
const SOL_MODEL = "gpt-6.1-sol";
const WEB_SEARCH_CALL_USD = 0.01;

const MODEL_RATES = {
  [LUNA_MODEL]: { input: 0.10, cached: 0.01, cache_write: 0.125, output: 0.50 },
  [SOL_MODEL]: { input: 2.00, cached: 0.20, cache_write: 2.50, output: 10.00 },
};

const runUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  web_search_calls: 0,
  estimated_cost_usd: 0,
  calls: 0,
  by_model: {},
};

function roundUsd(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

function countWebSearchCalls(data) {
  return (data?.output || []).filter((x) => {
    if (x?.type !== "web_search_call") return false;
    const type = x?.action?.type;
    return !type || type === "search";
  }).length;
}

function recordApiUsage(data, model) {
  const usage = data?.usage || {};
  const input = Number(usage.input_tokens || 0);
  const cached = Number(usage.input_tokens_details?.cached_tokens || 0);
  const cacheWrite = Number(usage.input_tokens_details?.cache_write_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const reasoning = Number(usage.output_tokens_details?.reasoning_tokens || 0);
  const webCalls = countWebSearchCalls(data);
  const rates = MODEL_RATES[model] || MODEL_RATES[SOL_MODEL];

  const ordinaryInput = Math.max(0, input - cached - cacheWrite);
  const cost =
    ordinaryInput / 1_000_000 * rates.input +
    cached / 1_000_000 * rates.cached +
    cacheWrite / 1_000_000 * rates.cache_write +
    output / 1_000_000 * rates.output +
    webCalls * WEB_SEARCH_CALL_USD;

  runUsage.input_tokens += input;
  runUsage.cached_input_tokens += cached;
  runUsage.cache_write_tokens += cacheWrite;
  runUsage.output_tokens += output;
  runUsage.reasoning_tokens += reasoning;
  runUsage.web_search_calls += webCalls;
  runUsage.calls += 1;
  runUsage.estimated_cost_usd += cost;

  if (!runUsage.by_model[model]) {
    runUsage.by_model[model] = {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      web_search_calls: 0,
      estimated_cost_usd: 0,
    };
  }
  const m = runUsage.by_model[model];
  m.calls += 1;
  m.input_tokens += input;
  m.output_tokens += output;
  m.reasoning_tokens += reasoning;
  m.web_search_calls += webCalls;
  m.estimated_cost_usd = roundUsd(m.estimated_cost_usd + cost);

  runUsage.estimated_cost_usd = roundUsd(runUsage.estimated_cost_usd);
}

function kyivDay(iso = new Date().toISOString()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function persistApiUsage(state, { markLastResearch = true } = {}) {
  if (markLastResearch) {
    state.last_api_usage = JSON.parse(JSON.stringify(runUsage));
  } else {
    state.last_analyst_api_usage = JSON.parse(JSON.stringify(runUsage));
  }

  const day = kyivDay();
  if (!state.api_usage_today || state.api_usage_today.date !== day) {
    state.api_usage_today = {
      date: day,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      web_search_calls: 0,
      calls: 0,
      estimated_cost_usd: 0,
      by_model: {},
    };
  }

  const t = state.api_usage_today;
  t.input_tokens += runUsage.input_tokens;
  t.output_tokens += runUsage.output_tokens;
  t.reasoning_tokens += runUsage.reasoning_tokens;
  t.web_search_calls += runUsage.web_search_calls;
  t.calls += runUsage.calls;
  t.estimated_cost_usd = roundUsd(t.estimated_cost_usd + runUsage.estimated_cost_usd);

  for (const [model, u] of Object.entries(runUsage.by_model)) {
    if (!t.by_model[model]) {
      t.by_model[model] = {
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        web_search_calls: 0,
        estimated_cost_usd: 0,
      };
    }
    const d = t.by_model[model];
    d.calls += u.calls;
    d.input_tokens += u.input_tokens;
    d.output_tokens += u.output_tokens;
    d.reasoning_tokens += u.reasoning_tokens;
    d.web_search_calls += u.web_search_calls;
    d.estimated_cost_usd = roundUsd(d.estimated_cost_usd + u.estimated_cost_usd);
  }
}


async function telegram(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

function encryptChatId(chatId) {
  const key = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(chatId), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptChatId(payload) {
  try {
    if (!payload?.iv || !payload?.tag || !payload?.data) return null;
    const key = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

async function getChatId() {
  const state = loadSeen();
  const savedChatId = decryptChatId(state.telegram_chat);
  if (savedChatId) return savedChatId;

  for (let attempt = 1; attempt <= 12; attempt++) {
    const updates = await telegram("getUpdates", { limit: 100, timeout: 20 });
    const privateMessages = updates
      .map((u) => u.message)
      .filter((m) => m?.chat?.id && m.chat.type === "private");

    if (privateMessages.length) {
      const chatId = String(privateMessages.at(-1).chat.id);
      state.telegram_chat = encryptChatId(chatId);
      fs.writeFileSync("seen.json", JSON.stringify(state, null, 2) + "\n");
      console.log("Telegram destination discovered and encrypted.");
      return chatId;
    }

    console.log(`Waiting for /start in @DanilCarGemBot... attempt ${attempt}/12`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("No Telegram private chat found after waiting for /start.");
}

async function sendText(chatId, text) {
  let rest = text.trim();
  while (rest.length) {
    let cut = Math.min(3900, rest.length);
    if (rest.length > 3900) {
      const nl = rest.lastIndexOf("\n", 3900);
      if (nl > 2500) cut = nl;
    }
    const chunk = rest.slice(0, cut).trim();
    rest = rest.slice(cut).trim();
    if (!chunk) continue;
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));
  }
}

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync("seen.json", "utf8"));
  } catch {
    return { vins: [], urls: [] };
  }
}

function saveSeen(seen, text) {
  const vins = [...text.matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)].map((m) => m[0]);
  const urls = [...text.matchAll(/https?:\/\/[^\s<>()]+/g)].map((m) => m[0].replace(/[.,;]+$/, ""));
  seen.vins = [...new Set([...(seen.vins || []), ...vins])].slice(-500);
  seen.urls = [...new Set([...(seen.urls || []), ...urls])].slice(-1000);
  fs.writeFileSync("seen.json", JSON.stringify(seen, null, 2) + "\n");
}


function saveState(state) {
  fs.writeFileSync("seen.json", JSON.stringify(state, null, 2) + "\n");
}

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

function statusText(state) {
  let result = "ещё нет завершённых проверок";
  if (state.last_check_status === "no_gem") {
    result = "ничего достойного не найдено";
  } else if (state.last_check_status === "found") {
    result = `найдено и показано: ${state.last_sent_count || 0}`;
  } else if (state.last_check_status === "error") {
    result = `ошибка: ${state.last_error || "неизвестная"}`;
  }

  return [
    "🟢 Car Gem Scout работает",
    "",
    "⏱ Режим: каждые 4 часа / 6 раз в сутки",
    `🕒 Последняя проверка: ${formatKyiv(state.last_check_at)}`,
    `🔎 Результат: ${result}`,
    `📊 Всего показано гемов: ${state.total_gems_sent || 0}`,
    `🔁 Всего завершённых проходов: ${state.completed_runs || 0}`,
    `⏭ Следующая плановая проверка: ~${formatKyiv(nextScheduledCheck())}`,
    "",
    "Источники: AUTO.RIA + 9 Telegram-каналов",
    "Фильтр: только реальные ГЕМЫ ≥ 8.5/10",
  ].join("\n");
}

function splitGems(text) {
  const parts = text
    .split(/(?=🔥\s*ГЕМ\s*\/\s*СМОТРЕТЬ\s*СРОЧНО)/i)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}


function outputText(data) {
  return (data.output || [])
    .filter((x) => x.type === "message")
    .flatMap((x) => x.content || [])
    .filter((x) => x.type === "output_text")
    .map((x) => x.text || "")
    .join("\n")
    .trim();
}

async function openaiJson({
  prompt,
  schema,
  name,
  model = LUNA_MODEL,
  effort = "low",
  maxOutputTokens = 3500,
  background = false,
  useWebSearch = true,
  searchContextSize = "medium",
  maxToolCalls = 3,
}) {
  const payload = {
    model,
    reasoning: { effort },
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name,
        strict: true,
        schema,
      }
    },
    max_output_tokens: maxOutputTokens,
    store: false,
  };

  if (useWebSearch) {
    payload.tools = [{
      type: "web_search",
      search_context_size: searchContextSize,
      user_location: {
        type: "approximate",
        country: "UA",
        timezone: "Europe/Kyiv"
      }
    }];
    payload.max_tool_calls = maxToolCalls;
  }

  if (background) payload.background = true;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI API failed ${r.status}: ${raw.slice(0, 1200)}`);
  let data = JSON.parse(raw);

  if (background) {
    if (!data.id) throw new Error("Background response did not return an id");

    const deadline = Date.now() + 15 * 60 * 1000;
    while ((data.status === "queued" || data.status === "in_progress") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      const poll = await fetch("https://api.openai.com/v1/responses/" + encodeURIComponent(data.id), {
        headers: { authorization: `Bearer ${OPENAI_API_KEY}` },
      });
      const pollRaw = await poll.text();
      if (!poll.ok) {
        throw new Error(`OpenAI background poll failed ${poll.status}: ${pollRaw.slice(0, 1200)}`);
      }
      data = JSON.parse(pollRaw);
    }

    if (data.status === "queued" || data.status === "in_progress") {
      throw new Error("OpenAI background response timed out after 15 minutes");
    }
  }

  recordApiUsage(data, model);

  if (data.status && data.status !== "completed") {
    throw new Error(
      "OpenAI response ended with status=" + String(data.status) +
      "; details=" + JSON.stringify(data.error || data.incomplete_details || null)
    );
  }

  const text = outputText(data);
  if (!text) throw new Error("OpenAI returned empty structured output");
  try {
    return JSON.parse(text);
  } catch (error) {
    const incomplete = data.incomplete_details ? JSON.stringify(data.incomplete_details) : "none";
    throw new Error(
      "Structured JSON parse failed; response_status=" + String(data.status || "unknown") +
      "; incomplete=" + incomplete +
      "; chars=" + text.length +
      "; tail=" + text.slice(-700)
    );
  }
}

const discoverySchema = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          source_url: { type: "string" },
          auto_ria_url: { type: "string" },
          telegram_url: { type: "string" },
          vin: { type: "string" },
          model: { type: "string" },
          year: { type: "integer" },
          price_usd: { type: "integer" },
          mileage_km: { type: "integer" },
          engine: { type: "string" },
          transmission: { type: "string" },
          drive: { type: "string" },
          location: { type: "string" },
          seller_type: { type: "string" },
          listing_note: { type: "string" },
          why_candidate: { type: "string" },
          discovery_score: { type: "number" }
        },
        required: [
          "source","source_url","auto_ria_url","telegram_url","vin","model","year",
          "price_usd","mileage_km","engine","transmission","drive","location",
          "seller_type","listing_note","why_candidate","discovery_score"
        ],
        additionalProperties: false
      }
    }
  },
  required: ["candidates"],
  additionalProperties: false
};

const analysisSchema = {
  type: "object",
  properties: {
    analyses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate_key: { type: "string" },
          model: { type: "string" },
          year: { type: "integer" },
          trim: { type: "string" },
          price_usd: { type: "integer" },
          mileage_km: { type: "integer" },
          engine_transmission_drive: { type: "string" },
          zero_to_100: { type: "string" },
          vin: { type: "string" },
          auto_ria_url: { type: "string" },
          telegram_url: { type: "string" },
          history_url: { type: "string" },
          auction_lot_date: { type: "string" },
          primary_secondary_damage: { type: "string" },
          run_drive_starts: { type: "string" },
          airbags: { type: "string" },
          structure: { type: "string" },
          flood_water: { type: "string" },
          auction_mileage: { type: "string" },
          pre_repair_photos_summary: { type: "string" },
          estimated_repair_cost_usd: { type: "integer" },
          acv_usd: { type: "integer" },
          retail_value_usd: { type: "integer" },
          final_bid_usd: { type: "integer" },
          repair_acv_pct: { type: "number" },
          weak_points: { type: "string" },
          inspection_checklist: { type: "string" },
          major_expense_risk: { type: "string", enum: ["низкий","средний","высокий"] },
          seller_risk: { type: "string" },
          listing_inconsistencies: { type: "string" },
          market_low_usd: { type: "integer" },
          market_high_usd: { type: "integer" },
          resale_1y_low_usd: { type: "integer" },
          resale_1y_high_usd: { type: "integer" },
          resale_2y_low_usd: { type: "integer" },
          resale_2y_high_usd: { type: "integer" },
          expected_loss_note: { type: "string" },
          real_buy_in_low_usd: { type: "integer" },
          real_buy_in_high_usd: { type: "integer" },
          target_buy_price_usd: { type: "integer" },
          confidence_pct: { type: "integer" },
          history_evidence: { type: "string", enum: ["positive","mixed","negative","insufficient"] },
          technical_evidence: { type: "string", enum: ["positive","mixed","negative","insufficient"] },
          confirmed_red_flags: { type: "array", items: { type: "string" } },
          unknowns: { type: "array", items: { type: "string" } },
          price_score: { type: "number" },
          history_score: { type: "number" },
          technical_score: { type: "number" },
          liquidity_score: { type: "number" },
          emotion_score: { type: "number" },
          trim_score: { type: "number" },
          why_gem: {
            type: "array",
            items: { type: "string" }
          },
          hard_reject: { type: "boolean" },
          hard_reject_reason: { type: "string" },
          verdict: { type: "string" }
        },
        required: [
          "candidate_key","model","year","trim","price_usd","mileage_km",
          "engine_transmission_drive","zero_to_100","vin","auto_ria_url","telegram_url",
          "history_url","auction_lot_date","primary_secondary_damage","run_drive_starts",
          "airbags","structure","flood_water","auction_mileage","pre_repair_photos_summary",
          "estimated_repair_cost_usd","acv_usd","retail_value_usd","final_bid_usd",
          "repair_acv_pct","weak_points","inspection_checklist","major_expense_risk",
          "seller_risk","listing_inconsistencies","market_low_usd","market_high_usd",
          "resale_1y_low_usd","resale_1y_high_usd","resale_2y_low_usd",
          "resale_2y_high_usd","expected_loss_note","real_buy_in_low_usd",
          "real_buy_in_high_usd","target_buy_price_usd","confidence_pct",
          "history_evidence","technical_evidence","confirmed_red_flags","unknowns",
          "price_score","history_score","technical_score","liquidity_score",
          "emotion_score","trim_score","why_gem","hard_reject","hard_reject_reason","verdict"
        ],
        additionalProperties: false
      }
    }
  },
  required: ["analyses"],
  additionalProperties: false
};

const analystSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    working_well: { type: "array", items: { type: "string" } },
    problems: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: { type: "string" } },
    watch_next_day: { type: "array", items: { type: "string" } },
    cost_note: { type: "string" }
  },
  required: ["summary","working_well","problems","actions","watch_next_day","cost_note"],
  additionalProperties: false
};

function analystMessage(a) {
  const bullets = (arr, prefix) => (arr || []).slice(0,4).map((x) => prefix + " " + String(x).replace(/\s+/g," ").trim());
  return [
    "🧠 Ежедневный аналитик Car Gem Scout",
    "",
    String(a.summary || "").trim(),
    "",
    "✅ Что работает",
    ...bullets(a.working_well, "•"),
    "",
    "⚠️ Где вижу проблему",
    ...bullets(a.problems, "•"),
    "",
    "🔧 Что бы я улучшил",
    ...bullets(a.actions, "•"),
    "",
    "👀 На что смотреть следующие сутки",
    ...bullets(a.watch_next_day, "•"),
    "",
    "💸 " + String(a.cost_note || "").trim(),
  ].filter((x) => x !== "").join("\n").slice(0,3900);
}

async function runDailyAnalyst(state, chatId) {
  const recent = Array.isArray(state.quality_history) ? state.quality_history.slice(-12) : [];
  const payload = {
    recent_runs: recent,
    last_collector: state.last_collector_stats || {},
    last_api_usage: state.last_api_usage || {},
    api_today: state.api_usage_today || {},
    source_queue: Object.keys(state.source_queue || {}).length,
    deep_queue: Object.keys(state.deep_queue || {}).length,
    almost_count: Object.keys(state.almost_gems_by_key || {}).length,
    interesting_count: Object.keys(state.interesting_by_key || {}).length,
    gems_total: Number(state.total_gems_sent || 0),
    last_error: state.last_error || null,
    current_rules: {
      gem: ">=8.5 and confidence>=70",
      almost: "7.8-8.49",
      deep_new_default: "discovery>=7.7; all discovery>=8.0 go immediately, cap 6",
      sources: "AUTO.RIA + 9 Telegram-каналов",
      schedule: "every 4 hours"
    }
  };

  const prompt = `
Ты — внутренний аналитик качества Car Gem Scout.
Раз в сутки ты смотришь на техническую статистику работы бота и пишешь владельцу КОРОТКИЙ практический отчёт на русском.

ЦЕЛЬ:
- понять, не пропускаем ли хорошие машины;
- не тратим ли API на слабые кандидаты;
- найти повторяющиеся ошибки/узкие места;
- предложить 1–4 конкретных улучшения;
- НЕ предлагать изменения ради изменений;
- НЕ менять код самостоятельно;
- если данных пока мало, прямо скажи это;
- отдельно следи за отношением discovery -> deep -> almost/gem, ошибками deep, очередями, Telegram/AUTO.RIA coverage и стоимостью.

ДАННЫЕ:
${JSON.stringify(payload)}
`;

  const result = await openaiJson({
    prompt,
    schema: analystSchema,
    name: "daily_scout_analyst",
    model: LUNA_MODEL,
    effort: "low",
    maxOutputTokens: 2200,
    useWebSearch: false,
  });

  state.last_daily_analyst_at = new Date().toISOString();
  state.last_daily_analyst = result;
  persistApiUsage(state, { markLastResearch: false });
  saveState(state);
  await sendText(chatId, analystMessage(result));
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function candidateKey(candidate) {
  const vin = String(candidate.vin || "").toUpperCase().trim();
  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return "VIN:" + vin;
  const url = normalizeUrl(candidate.auto_ria_url || candidate.telegram_url || candidate.source_url);
  return "URL:" + crypto.createHash("sha1").update(url || JSON.stringify(candidate)).digest("hex").slice(0, 16);
}

function validVin(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(String(vin || "").toUpperCase().trim());
}

function sourceUrl(item) {
  return normalizeUrl(item?.source_url || item?.auto_ria_url || item?.telegram_url || "");
}

function ensureSourceQueue(state) {
  if (!state.source_queue || typeof state.source_queue !== "object" || Array.isArray(state.source_queue)) {
    state.source_queue = {};
  }
  return state.source_queue;
}

function compactQueuedSource(item, nowIso, previous = {}) {
  return {
    ...previous,
    source: item.source || previous.source || "",
    source_url: item.source_url || previous.source_url || "",
    auto_ria_url: item.auto_ria_url || previous.auto_ria_url || "",
    telegram_url: item.telegram_url || previous.telegram_url || "",
    vin_hint: item.vin_hint || previous.vin_hint || "",
    price_hint_usd: Number(item.price_hint_usd || previous.price_hint_usd || 0),
    mileage_hint_km: Number(item.mileage_hint_km || previous.mileage_hint_km || 0),
    year_hint: Number(item.year_hint || previous.year_hint || 0),
    model_hint: item.model_hint || previous.model_hint || "",
    published_at_hint: item.published_at_hint || previous.published_at_hint || "",
    market_median_hint_usd: Number(item.market_median_hint_usd || previous.market_median_hint_usd || 0),
    price_anomaly_pct: Number(item.price_anomaly_pct || previous.price_anomaly_pct || 0),
    exploration: Boolean(item.exploration),
    raw_text: String(item.raw_text || previous.raw_text || "").slice(0, 1300),
    first_seen_at: previous.first_seen_at || nowIso,
    last_seen_at: nowIso,
  };
}

function updateSourceQueue(state, pool, nowIso) {
  const queue = ensureSourceQueue(state);
  const seen = new Set((state.source_seen_urls || []).map(normalizeUrl));

  for (const item of pool || []) {
    const url = sourceUrl(item);
    if (!url || seen.has(url)) continue;
    queue[url] = compactQueuedSource(item, nowIso, queue[url] || {});
  }

  const entries = Object.entries(queue)
    .sort((a, b) => String(b[1].last_seen_at || "").localeCompare(String(a[1].last_seen_at || "")))
    .slice(0, 1500);
  state.source_queue = Object.fromEntries(entries);
  return state.source_queue;
}

function sourcePriority(item, nowMs = Date.now()) {
  const first = Date.parse(item.first_seen_at || "") || nowMs;
  const ageHours = Math.max(0, (nowMs - first) / 3600000);
  const anomaly = Number(item.price_anomaly_pct || 0);
  const mileage = Number(item.mileage_hint_km || 0);

  const ageScore = Math.min(180, ageHours * 5);
  const anomalyScore = Math.min(70, Math.max(0, anomaly) * 5);
  const telegramBonus = item.source && item.source !== "AUTO.RIA" ? 30 : 0;
  const explorationBonus = item.exploration ? 10 : 0;
  const mileageScore =
    mileage > 0 && mileage <= 50000 ? 70 :
    mileage > 0 && mileage <= 70000 ? 50 :
    mileage > 0 && mileage <= 90000 ? 20 :
    mileage > 105000 ? -45 : 0;

  return ageScore + anomalyScore + telegramBonus + explorationBonus + mileageScore;
}

function selectSourceBatch(state, priceChangedItems = [], limit = 32) {
  const queue = ensureSourceQueue(state);
  const changed = (priceChangedItems || []).map((x) => ({
    ...x,
    price_change_recheck: true,
    queue_age_hours: 0,
  }));

  const changedUrls = new Set(changed.map(sourceUrl).filter(Boolean));
  const now = Date.now();
  const queued = Object.values(queue)
    .filter((x) => !changedUrls.has(sourceUrl(x)))
    .filter((x) => !x.not_before || Date.parse(x.not_before) <= now)
    .map((x) => ({
      ...x,
      queue_age_hours: Math.round(Math.max(0, (now - (Date.parse(x.first_seen_at || "") || now)) / 3600000) * 10) / 10,
    }));

  const picked = [];
  const pickedUrls = new Set();

  function add(items, max) {
    let n = 0;
    for (const item of items) {
      if (picked.length >= limit || n >= max) break;
      const url = sourceUrl(item);
      if (!url || pickedUrls.has(url)) continue;
      picked.push(item);
      pickedUrls.add(url);
      n += 1;
    }
  }

  add(changed.sort((a,b) => Number(b.source_price_drop_pct || 0) - Number(a.source_price_drop_pct || 0)), 6);
  add(
    queued.filter(x => Number(x.mileage_hint_km || 0) > 0 && Number(x.mileage_hint_km) <= 70000)
      .sort((a,b) => sourcePriority(b) - sourcePriority(a)),
    10
  );
  add(
    queued.filter(x => Number(x.price_anomaly_pct || 0) >= 8)
      .sort((a,b) => Number(b.price_anomaly_pct || 0) - Number(a.price_anomaly_pct || 0)),
    7
  );
  add(
    queued.filter(x => (x.source && x.source !== "AUTO.RIA") || x.exploration)
      .sort((a,b) => sourcePriority(b) - sourcePriority(a)),
    5
  );
  add(
    [...queued].sort((a,b) => Number(b.queue_age_hours || 0) - Number(a.queue_age_hours || 0)),
    6
  );
  add([...queued].sort((a,b) => sourcePriority(b) - sourcePriority(a)), limit);

  return picked.slice(0, limit);
}

function markSourceBatchProcessed(state, batch) {
  const queue = ensureSourceQueue(state);
  const urls = [];
  if (!state.source_price_watch || typeof state.source_price_watch !== "object" || Array.isArray(state.source_price_watch)) {
    state.source_price_watch = {};
  }

  for (const item of batch || []) {
    const url = sourceUrl(item);
    if (!url) continue;
    urls.push(url);
    delete queue[url];

    const price = Number(item.price_hint_usd || 0);
    if (price > 0) {
      state.source_price_watch[url] = {
        last_price_usd: price,
        updated_at: new Date().toISOString(),
      };
    }
  }

  const priceEntries = Object.entries(state.source_price_watch)
    .sort((x, y) => String(y[1].updated_at || "").localeCompare(String(x[1].updated_at || "")))
    .slice(0, 5000);
  state.source_price_watch = Object.fromEntries(priceEntries);

  commitObservedUrls(state, urls);
  state.last_source_queue_count = Object.keys(queue).length;
}

function scheduleSecondChance(state, batch, discoveryCandidates, nowIso) {
  const selectedUrls = new Set(
    (discoveryCandidates || [])
      .map((x) => normalizeUrl(x.auto_ria_url || x.telegram_url || x.source_url || ""))
      .filter(Boolean)
  );
  const queue = ensureSourceQueue(state);
  let scheduled = 0;

  for (const item of batch || []) {
    const url = sourceUrl(item);
    if (!url || selectedUrls.has(url)) continue;

    const attempts = Number(item.second_chance_attempts || 0);
    if (attempts >= 2) continue;

    const price = Number(item.price_hint_usd || 0);
    const mileage = Number(item.mileage_hint_km || 0);
    const anomaly = Number(item.price_anomaly_pct || 0);
    const telegram = item.source && item.source !== "AUTO.RIA";
    const interesting =
      anomaly >= 8 ||
      telegram ||
      (price > 0 && price <= 23500 && mileage > 0 && mileage <= 65000) ||
      (item.exploration && price > 0 && price <= 25000 && (!mileage || mileage <= 90000));

    if (!interesting) continue;

    const delayHours = attempts === 0 ? 48 : 96;
    const next = new Date(Date.parse(nowIso) + delayHours * 3600000).toISOString();
    queue[url] = {
      ...compactQueuedSource(item, nowIso, queue[url] || item),
      second_chance_attempts: attempts + 1,
      not_before: next,
      second_chance: true,
    };
    scheduled += 1;
  }

  state.last_second_chance_scheduled = scheduled;
  state.last_source_queue_count = Object.keys(queue).length;
  return scheduled;
}

function enrichDiscoveryCandidates(candidates, sourceBatch) {
  const byUrl = new Map(
    (sourceBatch || [])
      .map((x) => [sourceUrl(x), x])
      .filter(([url]) => Boolean(url))
  );

  return (candidates || []).map((candidate) => {
    const url = normalizeUrl(candidate.auto_ria_url || candidate.telegram_url || candidate.source_url || "");
    const meta = byUrl.get(url) || {};
    return {
      ...candidate,
      market_median_hint_usd: Number(meta.market_median_hint_usd || 0),
      price_anomaly_pct: Number(meta.price_anomaly_pct || 0),
      queue_age_hours: Number(meta.queue_age_hours || 0),
      exploration: Boolean(meta.exploration),
      source_first_seen_at: meta.first_seen_at || "",
    };
  });
}

function ensureDeepQueue(state) {
  if (!state.deep_queue || typeof state.deep_queue !== "object" || Array.isArray(state.deep_queue)) {
    state.deep_queue = {};
  }
  return state.deep_queue;
}

function deepEligible(item) {
  const score = Number(item.discovery_score || 0);
  const anomaly = Number(item.price_anomaly_pct || 0);
  const mileage = Number(item.mileage_km || 0);
  const previous = Number(item.previous_score || 0);

  if (item.needs_sol_audit) return true;
  if (item.target_price_trigger && previous >= 7.0) return true;
  if (item.price_drop_trigger && previous >= 7.0) return true;
  if (!item.never_analyzed) return false;

  if (score >= 7.7) return true;
  if (score >= 7.4 && anomaly >= 12 && (!mileage || mileage <= 90000)) return true;
  return false;
}

function enqueueDeepCandidates(state, candidates, nowIso) {
  const queue = ensureDeepQueue(state);

  for (const candidate of candidates || []) {
    if (!candidate?.candidate_key || !deepEligible(candidate)) continue;

    const previous = queue[candidate.candidate_key] || {};
    queue[candidate.candidate_key] = {
      ...previous,
      ...candidate,
      candidate_key: candidate.candidate_key,
      enqueued_at: previous.enqueued_at || nowIso,
      last_queued_at: nowIso,
      deep_attempts: Number(previous.deep_attempts || 0),
      deep_not_before: previous.deep_not_before || "",
    };
  }

  for (const [key, item] of Object.entries(queue)) {
    if (!deepEligible(item) && !item.needs_sol_audit) delete queue[key];
  }

  const entries = Object.entries(queue)
    .sort((a, b) => String(b[1].last_queued_at || "").localeCompare(String(a[1].last_queued_at || "")))
    .slice(0, 500);
  state.deep_queue = Object.fromEntries(entries);
  return state.deep_queue;
}

function deepWaitHours(item) {
  const at = Date.parse(item.enqueued_at || "");
  if (!at) return 0;
  return Math.max(0, (Date.now() - at) / 3600000);
}

function deepPriority(item) {
  const wait = deepWaitHours(item);
  return (
    (item.needs_sol_audit ? 2000 : 0) +
    (item.target_price_trigger ? 900 : 0) +
    (item.price_drop_trigger ? 700 : 0) +
    Number(item.previous_score || 0) * 80 +
    Number(item.discovery_score || 0) * 100 +
    Math.min(250, wait * 10) +
    Math.min(45, Math.max(0, Number(item.price_anomaly_pct || 0)) * 3)
  );
}

function selectDeepBatch(state) {
  const queue = ensureDeepQueue(state);
  const now = Date.now();

  for (const [key, item] of Object.entries(queue)) {
    if (!deepEligible(item) && !item.needs_sol_audit) delete queue[key];
  }

  const available = Object.values(queue)
    .filter((x) => !x.deep_not_before || Date.parse(x.deep_not_before) <= now)
    .sort((a, b) => deepPriority(b) - deepPriority(a));

  // Все реально сильные preliminary-кандидаты идут в deep сразу.
  // Жёсткий потолок — 6 машин за один проход, чтобы стоимость оставалась контролируемой.
  const strong = available.filter((x) =>
    x.needs_sol_audit ||
    x.target_price_trigger ||
    (x.price_drop_trigger && Number(x.previous_score || 0) >= 7.5) ||
    Number(x.discovery_score || 0) >= 8.0
  );

  const selected = [];
  const used = new Set();

  for (const item of strong) {
    if (selected.length >= 6) break;
    selected.push(item);
    used.add(item.candidate_key);
  }

  // Если сильных мало, добираем максимум до двух лучшими из очереди 7.7–7.99.
  if (selected.length < 2) {
    for (const item of available) {
      if (selected.length >= 2) break;
      if (used.has(item.candidate_key)) continue;
      selected.push(item);
      used.add(item.candidate_key);
    }
  }

  state.last_deep_limit = selected.length;
  state.last_deep_queue_count = Object.keys(queue).length;
  return selected;
}

function settleDeepQueue(state, selected, successfulKeys, failedKeys, nowIso) {
  const queue = ensureDeepQueue(state);
  const success = new Set(successfulKeys || []);
  const failed = new Set(failedKeys || []);

  for (const candidate of selected || []) {
    const key = candidate.candidate_key;
    if (!key) continue;
    if (success.has(key)) {
      delete queue[key];
      continue;
    }
    if (failed.has(key) && queue[key]) {
      const attempts = Number(queue[key].deep_attempts || 0) + 1;
      queue[key].deep_attempts = attempts;
      queue[key].deep_not_before = new Date(
        Date.parse(nowIso) + Math.min(24, 4 * attempts) * 3600000
      ).toISOString();
    }
  }

  state.last_deep_queue_count = Object.keys(queue).length;
}

function appendQualityStat(state, record) {
  if (!Array.isArray(state.quality_history)) state.quality_history = [];
  state.quality_history.push(record);
  state.quality_history = state.quality_history.slice(-120);
}

function sourceWarningSignature(warnings) {
  return crypto.createHash("sha1").update(JSON.stringify(warnings || [])).digest("hex").slice(0, 12);
}

function ensureVinCache(state) {
  if (!state.vin_cache || typeof state.vin_cache !== "object" || Array.isArray(state.vin_cache)) {
    state.vin_cache = {};
  }
  return state.vin_cache;
}

function getVinCache(state, candidate) {
  const vin = String(candidate?.vin || "").toUpperCase().trim();
  if (!validVin(vin)) return null;
  return ensureVinCache(state)[vin] || null;
}

function updateVinCache(state, analysis, nowIso) {
  const vin = String(analysis?.vin || "").toUpperCase().trim();
  if (!validVin(vin)) return;

  const hasUsefulHistory = [
    analysis.history_url,
    analysis.auction_lot_date,
    analysis.primary_secondary_damage,
    analysis.pre_repair_photos_summary,
  ].some((x) => x && x !== "нет данных");

  if (!hasUsefulHistory) return;

  ensureVinCache(state)[vin] = {
    vin,
    history_url: analysis.history_url || "",
    auction_lot_date: analysis.auction_lot_date || "нет данных",
    primary_secondary_damage: analysis.primary_secondary_damage || "нет данных",
    run_drive_starts: analysis.run_drive_starts || "нет данных",
    airbags: analysis.airbags || "нет данных",
    structure: analysis.structure || "нет данных",
    flood_water: analysis.flood_water || "нет данных",
    auction_mileage: analysis.auction_mileage || "нет данных",
    pre_repair_photos_summary: analysis.pre_repair_photos_summary || "нет данных",
    estimated_repair_cost_usd: Number(analysis.estimated_repair_cost_usd || 0),
    acv_usd: Number(analysis.acv_usd || 0),
    retail_value_usd: Number(analysis.retail_value_usd || 0),
    final_bid_usd: Number(analysis.final_bid_usd || 0),
    repair_acv_pct: Number(analysis.repair_acv_pct || 0),
    cached_at: nowIso,
  };
}

function ensureMarketWatch(state) {
  if (!state.market_watch || typeof state.market_watch !== "object" || Array.isArray(state.market_watch)) {
    state.market_watch = {};
  }
  return state.market_watch;
}

function compactWatchlist(state) {
  const watch = ensureMarketWatch(state);
  return Object.entries(watch)
    .sort((a, b) => String(b[1].last_seen_at || "").localeCompare(String(a[1].last_seen_at || "")))
    .slice(0, 80)
    .map(([key, x]) => ({
      key,
      model: x.model || "",
      vin: x.vin || "",
      url: x.auto_ria_url || x.telegram_url || x.source_url || "",
      last_price_usd: Number(x.last_price_usd || 0),
      target_buy_price_usd: Number(x.target_buy_price_usd || 0),
      alerted: Boolean(x.alerted),
      last_score: Number(x.last_score || 0),
    }));
}

function recordDiscoveredCandidate(state, candidate, nowIso) {
  const watch = ensureMarketWatch(state);
  const key = candidateKey(candidate);
  const prev = watch[key] || {};
  const oldPrice = Number(prev.last_price_usd || 0);
  const newPrice = Number(candidate.price_usd || 0);
  const dropUsd = oldPrice > 0 && newPrice > 0 && newPrice < oldPrice ? oldPrice - newPrice : 0;
  const dropPct = oldPrice > 0 && dropUsd > 0 ? (dropUsd / oldPrice) * 100 : 0;
  const hitTarget = Number(prev.target_buy_price_usd || 0) > 0 &&
    newPrice > 0 &&
    newPrice <= Number(prev.target_buy_price_usd);

  const item = {
    ...prev,
    key,
    model: candidate.model,
    year: candidate.year,
    vin: String(candidate.vin || "").toUpperCase(),
    source: candidate.source,
    source_url: candidate.source_url,
    auto_ria_url: candidate.auto_ria_url,
    telegram_url: candidate.telegram_url,
    mileage_km: candidate.mileage_km,
    engine: candidate.engine,
    transmission: candidate.transmission,
    drive: candidate.drive,
    seller_type: candidate.seller_type,
    listing_note: candidate.listing_note,
    first_seen_at: prev.first_seen_at || nowIso,
    last_seen_at: nowIso,
    last_price_usd: newPrice,
    lowest_price_usd: prev.lowest_price_usd
      ? Math.min(Number(prev.lowest_price_usd), newPrice || Number(prev.lowest_price_usd))
      : newPrice,
  };

  item.price_history = Array.isArray(prev.price_history) ? prev.price_history.slice(-19) : [];
  if (newPrice > 0 && (!item.price_history.length || item.price_history.at(-1)?.price_usd !== newPrice)) {
    item.price_history.push({ at: nowIso, price_usd: newPrice });
  }

  watch[key] = item;

  const neverAnalyzed = !prev.last_analyzed_at;
  const priceDropTrigger = dropUsd >= 1000 || dropPct >= 5;
  const targetTrigger = hitTarget && Number(prev.last_analyzed_price_usd || 0) !== newPrice;

  return {
    ...candidate,
    candidate_key: key,
    previous_price_usd: oldPrice,
    price_drop_usd: Math.round(dropUsd),
    price_drop_pct: Math.round(dropPct * 10) / 10,
    price_drop_trigger: priceDropTrigger,
    target_price_trigger: targetTrigger,
    never_analyzed: neverAnalyzed,
    previously_alerted: Boolean(prev.alerted),
    previous_score: Number(prev.last_score || 0),
    previous_target_buy_price_usd: Number(prev.target_buy_price_usd || 0),
    needs_sol_audit: Boolean(prev.needs_sol_audit),
  };
}

function money(n) {
  n = Number(n || 0);
  return n > 0 ? "$" + Math.round(n).toLocaleString("en-US") : "нет данных";
}

function compactTokens(n) {
  n = Number(n || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function ensurePreliminaryCandidates(state) {
  if (!state.preliminary_candidates_by_key || typeof state.preliminary_candidates_by_key !== "object" || Array.isArray(state.preliminary_candidates_by_key)) {
    state.preliminary_candidates_by_key = {};
  }
  return state.preliminary_candidates_by_key;
}

function preliminarySnapshot(candidate, nowIso, previous = {}) {
  const note = compactText(candidate.listing_note, 180);
  const anomaly = Number(candidate.price_anomaly_pct || 0);
  const reasons = [];

  if (anomaly >= 8) reasons.push(`цена примерно на ${anomaly.toFixed(1)}% ниже локальной медианы`);
  if (Number(candidate.mileage_km || 0) > 0 && Number(candidate.mileage_km) <= 70000) {
    reasons.push("хороший пробег для нашего фильтра");
  }
  if (note) reasons.push(note);

  return {
    key: candidate.candidate_key,
    model: candidate.model || "",
    year: Number(candidate.year || 0),
    discovery_score: Number(candidate.discovery_score || 0),
    price_usd: Number(candidate.price_usd || 0),
    mileage_km: Number(candidate.mileage_km || 0),
    source: candidate.source || "",
    url: candidate.auto_ria_url || candidate.telegram_url || candidate.source_url || "",
    reason: compactText(reasons[0] || "прошла первичный отбор Luna", 190),
    first_seen_at: previous.first_seen_at || nowIso,
    updated_at: nowIso,
  };
}

function updatePreliminaryCandidates(state, candidates, nowIso) {
  const store = ensurePreliminaryCandidates(state);

  for (const candidate of candidates || []) {
    const score = Number(candidate.discovery_score || 0);
    if (!candidate.candidate_key || score < 7.5 || score >= 8.5) continue;
    store[candidate.candidate_key] = preliminarySnapshot(
      candidate,
      nowIso,
      store[candidate.candidate_key] || {}
    );
  }

  const cutoff = Date.parse(nowIso) - 14 * 24 * 3600 * 1000;
  for (const [key, item] of Object.entries(store)) {
    const at = Date.parse(item.updated_at || item.first_seen_at || "");
    const watch = state.market_watch?.[key];
    if (!at || at < cutoff || watch?.last_analyzed_at) delete store[key];
  }
}

function almostSnapshot(a, score, candidate, nowIso) {
  return {
    key: candidate.candidate_key,
    model: a.model || candidate.model || "",
    year: Number(a.year || candidate.year || 0),
    trim: a.trim || "",
    score,
    confidence_pct: Number(a.confidence_pct || 0),
    price_usd: Number(a.price_usd || candidate.price_usd || 0),
    mileage_km: Number(a.mileage_km || candidate.mileage_km || 0),
    target_buy_price_usd: Number(a.target_buy_price_usd || 0),
    auto_ria_url: a.auto_ria_url || candidate.auto_ria_url || "",
    telegram_url: a.telegram_url || candidate.telegram_url || "",
    verdict: String(a.verdict || "").slice(0, 500),
    updated_at: nowIso,
  };
}

function ensureAlmostGems(state) {
  if (!state.almost_gems_by_key || typeof state.almost_gems_by_key !== "object" || Array.isArray(state.almost_gems_by_key)) {
    state.almost_gems_by_key = {};
  }
  return state.almost_gems_by_key;
}

function ensureInteresting(state) {
  if (!state.interesting_by_key || typeof state.interesting_by_key !== "object" || Array.isArray(state.interesting_by_key)) {
    state.interesting_by_key = {};
  }
  return state.interesting_by_key;
}

function interestingSnapshot(a, score, candidate, nowIso, previous = {}) {
  const clamp = (n) => Math.max(0, Math.min(10, Number(n || 0)));
  const history = clamp(a.history_score);
  const tech = clamp(a.technical_score);
  const restoredHistory = Math.max(history, 8);
  const restoredTech = Math.max(tech, 8);

  const potential = weightedScore({
    ...a,
    history_score: restoredHistory,
    technical_score: restoredTech,
  });

  const reasons = [];
  if (history < 8) {
    reasons.push(`история/ДТП: ${compactText(a.primary_secondary_damage || a.seller_risk || "история слабее желаемой", 150)}`);
  }
  if (tech < 8) {
    reasons.push(`технический риск: ${compactText(a.weak_points || a.major_expense_risk || "техническая часть слабее желаемой", 150)}`);
  }
  if (a.listing_inconsistencies && a.listing_inconsistencies !== "нет данных") {
    reasons.push(`объявление: ${compactText(a.listing_inconsistencies, 140)}`);
  }

  return {
    key: candidate.candidate_key,
    model: a.model || candidate.model || "",
    year: Number(a.year || candidate.year || 0),
    trim: a.trim || "",
    score: Number(score || 0),
    potential_score: potential,
    penalty_points: Math.max(0, Math.round((potential - score) * 100) / 100),
    confidence_pct: Number(a.confidence_pct || 0),
    price_usd: Number(a.price_usd || candidate.price_usd || 0),
    mileage_km: Number(a.mileage_km || candidate.mileage_km || 0),
    reasons: reasons.slice(0, 2),
    url: a.auto_ria_url || a.telegram_url || candidate.auto_ria_url || candidate.telegram_url || candidate.source_url || "",
    verdict: compactText(a.verdict, 220),
    found_at: previous.found_at || nowIso,
    updated_at: nowIso,
  };
}

function pruneInteresting(state, nowIso) {
  const items = ensureInteresting(state);
  const cutoff = Date.parse(nowIso) - 30 * 24 * 3600 * 1000;
  for (const [key, item] of Object.entries(items)) {
    const at = Date.parse(item.updated_at || item.found_at || "");
    if (!at || at < cutoff) delete items[key];
  }
}

function ensureTopGems(state) {
  if (!state.top_gems_by_key || typeof state.top_gems_by_key !== "object" || Array.isArray(state.top_gems_by_key)) {
    state.top_gems_by_key = {};
  }
  return state.top_gems_by_key;
}

function compactText(value, max = 180) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (!s || s === "нет данных") return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function topGemSnapshot(a, score, candidate, nowIso, previous = {}) {
  const pluses = (a.why_gem || [])
    .map((x) => compactText(x, 130))
    .filter(Boolean)
    .slice(0, 2);

  const minus = [
    compactText(a.major_expense_risk, 150),
    compactText(a.seller_risk, 150),
    compactText(a.weak_points, 150),
    compactText(a.listing_inconsistencies, 150),
  ].find(Boolean) || "Явных критичных минусов в итоговом анализе не найдено.";

  return {
    key: candidate.candidate_key,
    model: a.model || candidate.model || "",
    year: Number(a.year || candidate.year || 0),
    trim: a.trim || "",
    score: Number(score || 0),
    confidence_pct: Number(a.confidence_pct || 0),
    price_usd: Number(a.price_usd || candidate.price_usd || 0),
    mileage_km: Number(a.mileage_km || candidate.mileage_km || 0),
    pluses,
    minus,
    url: a.auto_ria_url || a.telegram_url || candidate.auto_ria_url || candidate.telegram_url || candidate.source_url || "",
    found_at: previous.found_at || nowIso,
    updated_at: nowIso,
  };
}

function pruneTopGems(state, nowIso) {
  const gems = ensureTopGems(state);
  const cutoff = Date.parse(nowIso) - 45 * 24 * 3600 * 1000;

  for (const [key, item] of Object.entries(gems)) {
    const at = Date.parse(item.found_at || item.updated_at || "");
    if (!at || at < cutoff) delete gems[key];
  }
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

function formatRunSummary({ state, direct, discoveredCount, selectedCount, solAudits, gemCount }) {
  const usage = state.last_api_usage || runUsage;
  const today = state.api_usage_today || {};
  const watchCount = Object.keys(state.market_watch || {}).length;
  const almostCount = Object.values(state.almost_gems_by_key || {})
    .filter((x) => Number(x.score || 0) >= 7.8 && Number(x.score || 0) < 8.5)
    .length;
  const tgLine = telegramCoverageText(direct?.stats || {});
  const deepQueue = Number(state.last_deep_queue_count || 0);

  return [
    "📡 Car Gem Scout — проверка завершена",
    "",
    `🎯 Потенциальных кандидатов после первого отбора: ${discoveredCount}`,
    `🔬 Luna успешно проверила: ${Math.max(0, selectedCount - Number(state.last_deep_failed_count || 0))}`,
    `⏳ Ещё ждут глубокой проверки Luna: ${deepQueue}`,
    Number(state.last_deep_failed_count || 0) ? `↻ На повтор после ошибки: ${state.last_deep_failed_count}` : null,
    solAudits ? `🧠 Самые сильные дополнительно перепроверены Sol: ${solAudits}` : null,
    `🟡 Почти гемов 7.8–8.4: ${almostCount}`,
    `🔥 ГЕМов >=8.5 найдено: ${gemCount}`,
    `👀 Машин под наблюдением за ценой: ${watchCount}`,
    "",
    `📲 ${tgLine}`,
    `💸 Этот проход: ~$ ${Number(usage.estimated_cost_usd || 0).toFixed(3)}`.replace("$ ", "$"),
    `📅 Сегодня: ~$ ${Number(today.estimated_cost_usd || 0).toFixed(3)}`.replace("$ ", "$"),
    "",
    gemCount
      ? "👇 Ниже отправлю найденные ГЕМЫ."
      : "ГЕМов нет — продолжаю следить за рынком.",
    "",
    "⌨️ /status · /candidates · /almost · /interesting · /top",
  ].filter(Boolean).join("\n");
}

function candidateUrls(a) {
  const rows = [];
  if (a.auto_ria_url) rows.push("AUTO.RIA: " + a.auto_ria_url);
  else rows.push("AUTO.RIA: нет");
  if (a.telegram_url) rows.push("Telegram: " + a.telegram_url);
  else rows.push("Telegram: нет");
  if (a.history_url) rows.push("История США / лот / фото: " + a.history_url);
  else rows.push("История США / лот / фото: нет данных");
  return rows.join("\n");
}

function formatGemAlert(a, score, priceMeta = {}) {
  const why = (a.why_gem || []).slice(0, 4).map((x) => "— " + x).join("\n") || "— Сильная совокупность цены, состояния и ликвидности.";
  const priceDrop = priceMeta.price_drop_trigger
    ? `\n📉 PRICE DROP: ${money(priceMeta.previous_price_usd)} → ${money(a.price_usd)} (-${money(priceMeta.price_drop_usd).replace("$","$")}, ${priceMeta.price_drop_pct}%)`
    : "";

  return `🔥 ГЕМ / СМОТРЕТЬ СРОЧНО — ${a.model} ${a.year} ${a.trim}${priceDrop}

💵 Цена: ${money(a.price_usd)}
🛣 Пробег: ${a.mileage_km > 0 ? a.mileage_km.toLocaleString("ru-RU") + " км" : "нет данных"}
⚙️ ${a.engine_transmission_drive}
🏁 0–100: ${a.zero_to_100}
⭐ Рейтинг покупки: ${score}/10
🎯 Уверенность: ${a.confidence_pct}%

📊 РАЗБИВКА РЕЙТИНГА
Цена / рынок: ${a.price_score}/10
История / состояние: ${a.history_score}/10
Техника / риск расходов: ${a.technical_score}/10
Ликвидность: ${a.liquidity_score}/10
Эмоции / динамика: ${a.emotion_score}/10
Комплектация: ${a.trim_score}/10

🔗 ГДЕ НАШЁЛ
${candidateUrls(a)}

💎 ПОЧЕМУ ЭТО ГЕМ
${why}

🇺🇸 ИСТОРИЯ США
VIN: ${a.vin || "нет данных"}
Аукцион / lot / дата: ${a.auction_lot_date}
Primary / Secondary Damage: ${a.primary_secondary_damage}
Run & Drive / Starts: ${a.run_drive_starts}
Airbags: ${a.airbags}
Силовая структура: ${a.structure}
Flood/Water: ${a.flood_water}
Пробег на аукционе: ${a.auction_mileage}
Фото до ремонта: ${a.pre_repair_photos_summary}
Estimated Repair Cost: ${money(a.estimated_repair_cost_usd)}
ACV: ${money(a.acv_usd)}
Retail Value: ${money(a.retail_value_usd)}
Final Bid: ${money(a.final_bid_usd)}
Repair Estimate / ACV: ${a.repair_acv_pct > 0 ? a.repair_acv_pct + "%" : "нет данных"}

🔧 ТЕХНИКА
Типичные слабые места: ${a.weak_points}
Что проверить: ${a.inspection_checklist}
Риск крупных расходов: ${a.major_expense_risk}
Риск по продавцу/объявлению: ${a.seller_risk}
Несостыковки: ${a.listing_inconsistencies}

💰 ДЕНЬГИ
Рынок аналогов: ${money(a.market_low_usd)}–${money(a.market_high_usd)}
Real Buy-In Cost первые ~6 мес.: ${money(a.real_buy_in_low_usd)}–${money(a.real_buy_in_high_usd)}
Цена, при которой точно интересно: ${money(a.target_buy_price_usd)}
Перепродажа ~1 год: ${money(a.resale_1y_low_usd)}–${money(a.resale_1y_high_usd)}
Перепродажа ~2 года: ${money(a.resale_2y_low_usd)}–${money(a.resale_2y_high_usd)}
Ожидаемая потеря: ${a.expected_loss_note}

🏁 ВЕРДИКТ
${a.verdict}`;
}

async function discoverCandidates(state, directItems = []) {
  const watchlist = compactWatchlist(state);

  if (directItems.length) {
    const compactItems = directItems.slice(0, 32).map((x) => ({
      source: x.source,
      source_url: x.source_url,
      auto_ria_url: x.auto_ria_url,
      telegram_url: x.telegram_url,
      vin_hint: x.vin_hint || "",
      price_hint_usd: Number(x.price_hint_usd || 0),
      mileage_hint_km: Number(x.mileage_hint_km || 0),
      published_at_hint: x.published_at_hint || "",
      model_hint: x.model_hint || "",
      year_hint: Number(x.year_hint || 0),
      market_median_hint_usd: Number(x.market_median_hint_usd || 0),
      price_anomaly_pct: Number(x.price_anomaly_pct || 0),
      queue_age_hours: Number(x.queue_age_hours || 0),
      exploration: Boolean(x.exploration),
      price_change_recheck: Boolean(x.price_change_recheck),
      raw_text: String(x.raw_text || "").slice(0, 1100),
    }));

    const prompt = `
Ты — дешёвый FILTER/RANKING этап Car Gem Scout.
РЫНОК УЖЕ СОБРАН ПРЯМЫМ КОДОМ с AUTO.RIA и публичных Telegram-лент. НЕ ИЩИ ничего в интернете и НЕ придумывай новые объявления.

ТВОЯ ЗАДАЧА:
Из сырых карточек ниже выбрать максимум 10 кандидатов для дорогого глубокого VIN-анализа.
Используй ТОЛЬКО данные из RAW ITEMS. source_url/auto_ria_url/telegram_url копируй ТОЧНО.

КРИТЕРИИ:
- бюджет обычно <= $25,000; до ~$26,500 только если вариант реально сильный/есть очевидный торг;
- пробег желательно <=70k км, до ~90k допустимо у сильной модели/цены;
- эффектный спортивный/премиальный автомобиль;
- динамика желательно около 6 сек 0–100 или быстрее;
- главный ориентир Infiniti Q60;
- подходят интересные BMW 3/4, Mercedes C/CLA/coupe, Lexus RC/IS, Audi A5/S5, Genesis G70 и аналогичные;
- электрички тоже рассматривай: Tesla Model 3/Y, Polestar 2, BMW i4, Hyundai Ioniq 5/6, Kia EV6, Mustang Mach-E;
- не тащи скучные массовые седаны;
- Kia Stinger только при аномально выгодной сделке;
- очевидные flood/fire/тяжёлый structural мусор не выбирай, если это прямо видно в тексте;
- для каждого поставь discovery_score 0–10;
- не добивай список ради количества: возвращай только реально сильных кандидатов, ориентир discovery_score от 7.2;
- market_median_hint_usd / price_anomaly_pct уже посчитал локальный код: если машина на 10–15%+ дешевле медианы похожих объявлений, это сильный плюс, но не игнорируй возможную причину низкой цены;
- queue_age_hours — сколько кандидат ждал обработки. Старый нормальный кандидат не должен проигрывать бесконечно новым;
- exploration=true означает, что машина найдена широким ротационным поиском по бренду, а не из фиксированного списка моделей.

Если какого-то поля нет — пустая строка или 0. НИЧЕГО не выдумывай.

RAW ITEMS:
${JSON.stringify(compactItems)}

PRICE WATCH:
${JSON.stringify(watchlist)}
`;

    return openaiJson({
      prompt,
      schema: discoverySchema,
      name: "car_candidate_discovery",
      model: LUNA_MODEL,
      effort: "low",
      maxOutputTokens: 3000,
      useWebSearch: false,
    });
  }

  // Fallback only: use web search if direct collectors returned nothing.
  const prompt = `
Ты — DISCOVERY-этап Car Gem Scout для покупки первой машины в Украине.

Прямые collectors в этом проходе не дали данных, поэтому сделай резервный web-search.
Проверь AUTO.RIA и публичные Telegram-источники: KIEVAVTO, IsAuto, Imperiya Auto, Grand The Auto, Автобазар Дніпро, Karavan Дніпро, Hapai Auto и Griznes Auto.

КРИТЕРИИ:
- бюджет до $25,000; до ~$26,500 только для очень сильного варианта;
- пробег желательно <=70k км, до ~90k допустимо;
- эффектный спортивный/премиальный автомобиль;
- ~6 сек 0–100 или быстрее желательно;
- ориентир Infiniti Q60; также BMW 3/4, Mercedes C/CLA/coupe, Lexus RC/IS, Audi и аналоги;
- EV тоже допустимы: Tesla Model 3/Y, Polestar 2, BMW i4, Ioniq 5/6, EV6, Mustang Mach-E;
- не предлагай скучные массовые седаны;
- максимум 10 кандидатов;
- прямые URL обязательны;
- не выдумывай VIN/цену/пробег/URL.

PRICE WATCH:
${JSON.stringify(watchlist)}
`;

  return openaiJson({
    prompt,
    schema: discoverySchema,
    name: "car_candidate_discovery_fallback",
    model: LUNA_MODEL,
    effort: "low",
    maxOutputTokens: 3200,
    useWebSearch: true,
    searchContextSize: "low",
    maxToolCalls: 2,
  });
}

async function lunaAnalyzeOne(candidate, vinCache = null) {
  const cacheInstruction = vinCache
    ? `
VIN-HISTORY CACHE:
${JSON.stringify(vinCache)}

История этого VIN уже была найдена раньше. НЕ трать web-search на повторный поиск Copart/IAAI/BidFax/Stat.vin, если нет явного противоречия. Используй кэш как подтверждённую базу и трать поиск на текущий рынок Украины и действительно новые риски.
`
    : `
VIN CACHE отсутствует. Если VIN есть, один раз найди доступную аукционную историю и ключевые данные.
`;

  const prompt = `
Ты — экономный, но тщательный DEEP ANALYSIS-этап Car Gem Scout.
Проверь конкретную машину. Используй web search только для вещей, реально влияющих на решение.

КАНДИДАТ:
${JSON.stringify(candidate)}
${cacheInstruction}

МОЙ ПРОФИЛЬ:
- первая машина в Украине;
- максимум около $25,000;
- пробег желательно 60–70k км;
- хочу эффектную спортивную/премиальную машину;
- 0–100 желательно ~6 сек или быстрее;
- важны надёжность, ликвидность и умеренная потеря цены;
- главный ориентир Infiniti Q60.

ОБЯЗАТЕЛЬНО:
- если VIN-history НЕ закэширована: попробуй найти Copart / IAAI / BidFax / Stat.vin или другой доступный архив;
- выясни damage, Run & Drive/Starts, airbags, structure, flood, auction mileage, Estimated Repair Cost, ACV, Retail Value, Final Bid, фото до ремонта;
- сравни цену с украинским рынком;
- оцени Real Buy-In первые ~6 месяцев;
- учти комплектацию;
- учитывай локальный price_anomaly_pct только как сигнал, а не как доказательство выгодности;
- если данных нет — не выдумывай;
- ОТВЕЧАЙ КРАТКО: строковые поля максимум 1–2 коротких предложения, списки только самые важные пункты. Не раздувай JSON.

HARD REJECT: flood/water, fire, тяжёлый structural/safety-cell/geometry, тяжёлый фронт с риском силового агрегата/охлаждения, тяжёлый множественный SRS, сомнительное восстановление.

SCORING 0–10:
price 25%, history 25%, technical 20%, liquidity 15%, emotion 10%, trim 5%.

КРИТИЧЕСКАЯ КАЛИБРОВКА:
- НЕИЗВЕСТНОСТЬ ≠ ПЛОХОЙ ФАКТ. "не найдено", "не указано", "не подтверждено", отсутствие фото/ACV/final bid сами по себе НЕ должны сильно снижать history_score или technical_score. Они снижают confidence_pct.
- history_score оценивает ПОДТВЕРЖДЁННУЮ историю: реальную тяжесть ДТП, flood/fire, SRS, structural, качество восстановления. Если данных мало — history_evidence="insufficient" и держи score около нейтрального диапазона, а не 2–4/10.
- technical_score оценивает ТЕКУЩИЙ технический риск мотора/коробки/турбин/охлаждения/подвески/электрики и подтверждённые последствия ремонта.
- НЕ штрафуй одно и то же ДТП дважды. Сам факт старого удара относится прежде всего к history_score. В technical_score он идёт только если есть отдельные признаки текущей технической проблемы/геометрии.
- hard_reject ставь только по подтверждённому или очень сильному факту, а не потому что информацию не удалось найти.
- confidence_pct — отдельная оценка полноты данных и НЕ является частью итогового балла.
- confirmed_red_flags: только реально подтверждённые негативные факты.
- unknowns: что осталось неизвестным/неподтверждённым.

Ориентиры шкалы из прошлых ручных разборов пользователя (калибровка, не обязательные оценки конкретных объявлений):
[{"name":"Strong Acura TLX-style deal","expected":[8.4,8.8]},{"name":"Good Audi A5-style deal","expected":[8,8.4]},{"name":"Good Mustang-style deal","expected":[7.8,8.2]},{"name":"Solid Audi S3-style deal","expected":[7.5,7.9]},{"name":"Solid Lexus IS350-style deal","expected":[7.4,7.8]}]

Интерпретация итогового score:
<7.0 — слабый вариант;
7.0–7.79 — нормальный, но недостаточно сильный;
7.8–8.19 — сильный вариант;
8.2–8.49 — почти GEM;
>=8.5 — редкий GEM.

target_buy_price_usd — цена, при которой машина стала бы действительно интересной.

candidate_key скопируй ТОЧНО: ${candidate.candidate_key}
`;

  const result = await openaiJson({
    prompt,
    schema: analysisSchema,
    name: "luna_car_deep_analysis",
    model: LUNA_MODEL,
    effort: "medium",
    maxOutputTokens: 6000,
    useWebSearch: true,
    searchContextSize: "medium",
    maxToolCalls: vinCache ? 1 : 2,
  });

  return (result.analyses || [])[0] || null;
}

async function solAuditOne(candidate, preliminary, vinCache = null) {
  const cacheInstruction = vinCache
    ? "VIN-history уже закэширована. Не ищи аукцион заново без явного противоречия с текущими данными."
    : "VIN-cache отсутствует: при необходимости проверь критичную историю VIN.";

  const prompt = `
Ты — FINAL AUDITOR Car Gem Scout. Luna уже сделала предварительный глубокий анализ машины.
Твоя задача — НЕ повторять весь ресерч без необходимости, а проверить самые критичные места и решить, можно ли реально отправлять пользователю алерт "ГЕМ".

КАНДИДАТ:
${JSON.stringify(candidate)}

ПРЕДВАРИТЕЛЬНЫЙ АНАЛИЗ LUNA:
${JSON.stringify(preliminary)}

${cacheInstruction}
${vinCache ? "КЭШ: " + JSON.stringify(vinCache) : ""}

ПРОВЕРЬ В ПЕРВУЮ ОЧЕРЕДЬ:
1) нет ли стоп-фактора в истории;
2) текущую цену против рынка Украины;
3) технический риск крупных расходов;
4) не завышены ли score/confidence.

Не трать поиск на очевидные уже подтверждённые мелочи. Если источник не найден — снижай confidence, не выдумывай.

КАЛИБРОВКА ФИНАЛЬНОГО АУДИТА:
- отсутствие данных снижает confidence, а не автоматически score;
- не штрафуй одно ДТП одновременно в history и technical без отдельного подтверждённого текущего последствия;
- hard_reject только по реальному стоп-фактору, не по отсутствию информации;
- сохрани history_evidence / technical_evidence / confirmed_red_flags / unknowns и поправь их, если Luna ошиблась.

Верни полный объект анализа той же структуры, исправив предварительный анализ там, где нужно.
candidate_key должен остаться ровно: ${candidate.candidate_key}
`;

  const result = await openaiJson({
    prompt,
    schema: analysisSchema,
    name: "sol_final_car_audit",
    model: SOL_MODEL,
    effort: "medium",
    maxOutputTokens: 4200,
    useWebSearch: true,
    searchContextSize: "high",
    maxToolCalls: 2,
  });

  return (result.analyses || [])[0] || null;
}

async function deepAnalyzeCandidates(candidates, state) {
  if (!candidates.length) return { analyses: [], failed: 0, failed_keys: [] };

  const analyses = [];
  const failedKeys = [];

  for (const candidate of candidates) {
    try {
      const cached = getVinCache(state, candidate);
      const result = await lunaAnalyzeOne(candidate, cached);
      if (result) analyses.push(result);
      else failedKeys.push(candidate.candidate_key);
    } catch (error) {
      failedKeys.push(candidate.candidate_key);
      console.error("Luna analysis failed for " + candidate.candidate_key + ": " + String(error?.message || error));
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  if (candidates.length > 0 && analyses.length === 0) {
    throw new Error("All selected Luna analyses failed (" + failedKeys.length + "/" + candidates.length + ")");
  }

  return { analyses, failed: failedKeys.length, failed_keys: failedKeys };
}

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const runStartedAt = new Date().toISOString();
const chatId = await getChatId();
const state = loadSeen();


if (ANALYST_ONLY) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  await runDailyAnalyst(state, chatId);
  process.exit(0);
}

if (TEST_ONLY) {
  state.last_test_at = runStartedAt;
  saveState(state);
  await sendText(chatId,
    "✅ Car Gem Scout подключён.\n\n" +
    "Режим: каждые 4 часа / 6 раз в сутки.\n" +
    "Проверяю AUTO.RIA + 9 Telegram-каналов и пишу сюда только когда нахожу реальный ГЕМ.\n\n" +
    "Команды: /status — статус; /candidates — preliminary 7.5–8.4 до deep; /almost — 7.8–8.4 после deep; /interesting — интересные варианты со штрафом; /top — лучшие ГЕМЫ за 30 дней."
  );
  process.exit(0);
}

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

try {
  const direct = await collectDirectSources(state);
  const nowIso = new Date().toISOString();

  state.last_collector_stats = direct.stats;
  state.last_collector_errors = (direct.errors || []).slice(0, 8);
  state.telegram_cursors = direct.telegram_cursors || state.telegram_cursors || {};
  if (direct.daily_sweep_performed) {
    state.last_daily_sweep_day = direct.daily_sweep_day;
    state.last_daily_sweep_at = nowIso;
  }

  const sourceWarnings = direct.source_health_warnings || [];
  if (sourceWarnings.length) {
    const sig = sourceWarningSignature(sourceWarnings);
    const lastAt = Date.parse(state.last_source_warning_at || "") || 0;
    if (state.last_source_warning_signature !== sig || Date.now() - lastAt > 12 * 3600000) {
      await sendText(
        chatId,
        "⚠️ Car Gem Scout: источник работает подозрительно\n\n" +
        sourceWarnings.map((x) => "• " + x).join("\n") +
        "\n\nЯ не считаю такой проход доказательством, что на рынке нет ГЕМов."
      );
      state.last_source_warning_signature = sig;
      state.last_source_warning_at = nowIso;
    }
  }

  updateSourceQueue(state, direct.pool || [], nowIso);
  const sourceBatch = selectSourceBatch(state, direct.price_changed_items || [], SOURCE_BATCH_LIMIT);
  state.last_source_queue_count = Object.keys(ensureSourceQueue(state)).length;
  state.last_price_anomaly_count = sourceBatch.filter((x) => Number(x.price_anomaly_pct || 0) >= 10).length;
  state.last_exploration_brands = direct.exploration_brands || [];
  state.last_collector_mode = sourceBatch.length ? "direct" : "web_fallback";

  // Persist the queue/high-water before any paid API call.
  saveState(state);

  const discovery = await discoverCandidates(state, sourceBatch);

  // Every source card was genuinely seen by the cheap Luna filter.
  markSourceBatchProcessed(state, sourceBatch);
  scheduleSecondChance(state, sourceBatch, discovery.candidates || [], nowIso);

  const discovered = enrichDiscoveryCandidates(discovery.candidates || [], sourceBatch)
    .filter((x) => x && (x.source_url || x.auto_ria_url || x.telegram_url))
    .map((x) => recordDiscoveredCandidate(state, x, nowIso));

  state.last_discovered_count = discovered.length;

  // Human-readable shortlist: promising preliminary candidates that have not had VIN/history deep research yet.
  updatePreliminaryCandidates(state, discovered, nowIso);

  // Every candidate that passed the cheap filter waits here until it actually gets deep-analyzed.
  enqueueDeepCandidates(state, discovered, nowIso);
  const deepQueueBefore = Object.keys(ensureDeepQueue(state)).length;
  const selected = selectDeepBatch(state);

  state.last_deep_analyzed_count = selected.length;
  saveState(state);

  const deep = await deepAnalyzeCandidates(selected, state);
  state.last_deep_failed_count = Number(deep.failed || 0);

  const successfulDeepKeys = (deep.analyses || []).map((a) => a.candidate_key);
  settleDeepQueue(state, selected, successfulDeepKeys, deep.failed_keys || [], nowIso);
  const preliminary = ensurePreliminaryCandidates(state);
  for (const key of successfulDeepKeys) delete preliminary[key];

  const lunaByKey = new Map((deep.analyses || []).map((a) => [a.candidate_key, a]));
  const watch = ensureMarketWatch(state);
  const almost = ensureAlmostGems(state);
  const interesting = ensureInteresting(state);
  const alerts = [];
  let solAudits = 0;
  let solAuditFailures = 0;
  let almostQualifiedThisRun = 0;
  let gemsQualifiedThisRun = 0;

  for (const candidate of selected) {
    const rawLuna = lunaByKey.get(candidate.candidate_key);
    if (!rawLuna) continue;

    const luna = calibrateAnalysis(rawLuna);
    const lunaScore = weightedScore(luna);
    const lunaConfidence = Number(luna.confidence_pct || 0);
    const lunaPrice = Number(luna.price_usd || candidate.price_usd || 0);

    const shouldAuditWithSol =
      !luna.hard_reject &&
      lunaScore >= 8.45 &&
      lunaConfidence >= 65 &&
      lunaPrice > 0 &&
      lunaPrice <= 26000;

    let finalAnalysis = luna;
    let solAuditOk = !shouldAuditWithSol;

    if (shouldAuditWithSol) {
      solAudits += 1;
      try {
        const audited = await solAuditOne(candidate, luna, getVinCache(state, candidate));
        if (audited) {
          finalAnalysis = calibrateAnalysis(audited);
          solAuditOk = true;
        } else {
          solAuditFailures += 1;
        }
      } catch (error) {
        solAuditFailures += 1;
        console.error("Sol audit failed for " + candidate.candidate_key + ": " + String(error?.message || error));
      }
    }

    const a = finalAnalysis;
    updateVinCache(state, a, nowIso);
    const score = weightedScore(a);
    const item = watch[candidate.candidate_key] || {};

    item.last_analyzed_at = nowIso;
    item.last_analyzed_price_usd = Number(a.price_usd || candidate.price_usd || 0);
    item.last_score = score;
    item.last_luna_score = lunaScore;
    item.last_confidence_pct = Number(a.confidence_pct || 0);
    item.target_buy_price_usd = Number(a.target_buy_price_usd || 0);
    item.real_buy_in_low_usd = Number(a.real_buy_in_low_usd || 0);
    item.real_buy_in_high_usd = Number(a.real_buy_in_high_usd || 0);
    item.hard_reject = Boolean(a.hard_reject);
    item.hard_reject_reason = a.hard_reject_reason || "";
    item.sol_audited_at = shouldAuditWithSol && solAuditOk ? nowIso : item.sol_audited_at || null;
    item.needs_sol_audit = shouldAuditWithSol && !solAuditOk;
    watch[candidate.candidate_key] = item;

    if (
      !a.hard_reject &&
      score >= 7.8 &&
      score < 8.5 &&
      Number(a.confidence_pct || 0) >= 60 &&
      Number(a.price_usd || candidate.price_usd || 0) <= 26000
    ) {
      almostQualifiedThisRun += 1;
      almost[candidate.candidate_key] = almostSnapshot(a, score, candidate, nowIso);
    } else {
      delete almost[candidate.candidate_key];
    }

    const interestingCandidate = interestingSnapshot(a, score, candidate, nowIso, interesting[candidate.candidate_key] || {});
    if (
      !a.hard_reject &&
      Number(a.price_usd || candidate.price_usd || 0) <= 26000 &&
      (
        (
          score >= 6.5 &&
          score < 7.8 &&
          interestingCandidate.potential_score >= 8.0 &&
          interestingCandidate.penalty_points >= 0.5
        ) ||
        (
          score >= 7.8 &&
          Number(a.confidence_pct || 0) < 60
        )
      )
    ) {
      interesting[candidate.candidate_key] = interestingCandidate;
    } else {
      delete interesting[candidate.candidate_key];
    }

    const qualifies =
      solAuditOk &&
      !a.hard_reject &&
      score >= 8.5 &&
      Number(a.confidence_pct || 0) >= 70 &&
      Number(a.price_usd || candidate.price_usd || 0) <= 26000;

    const mayRepeat = candidate.price_drop_trigger || candidate.target_price_trigger;

    if (qualifies) {
      gemsQualifiedThisRun += 1;
      const top = ensureTopGems(state);
      top[candidate.candidate_key] = topGemSnapshot(
        a,
        score,
        candidate,
        nowIso,
        top[candidate.candidate_key] || {}
      );
    }

    if (qualifies && (!item.alerted || mayRepeat)) {
      alerts.push({
        text: formatGemAlert(a, score, candidate),
        key: candidate.candidate_key,
        score,
        price_usd: Number(a.price_usd || candidate.price_usd || 0),
      });
    }
  }

  pruneTopGems(state, nowIso);
  pruneInteresting(state, nowIso);
  state.last_sol_audits = solAudits;
  state.last_sol_audit_failures = solAuditFailures;
  state.last_check_at = runStartedAt;
  state.completed_runs = Number(state.completed_runs || 0) + 1;
  state.last_error = null;
  persistApiUsage(state);

  appendQualityStat(state, {
    at: nowIso,
    source_pool_seen: Number(direct.pool?.length || 0),
    source_batch_to_luna: sourceBatch.length,
    discovery_selected: discovered.length,
    discovery_rejected: Math.max(0, sourceBatch.length - discovered.length),
    second_chance_scheduled: Number(state.last_second_chance_scheduled || 0),
    deep_queue_before: deepQueueBefore,
    deep_limit: Number(state.last_deep_limit || 0),
    deep_selected: selected.length,
    deep_success: Number((deep.analyses || []).length),
    deep_failed: Number(deep.failed || 0),
    deep_queue_after: Number(state.last_deep_queue_count || 0),
    almost: almostQualifiedThisRun,
    gems_qualified: gemsQualifiedThisRun,
    alerts_new: alerts.length,
    price_anomalies_in_batch: Number(state.last_price_anomaly_count || 0),
    daily_sweep: Boolean(direct.daily_sweep_performed),
    telegram_backfill_pending: Boolean(direct.stats?.telegram_backfill_pending),
    source_health_warnings: Number(direct.source_health_warnings?.length || 0),
    estimated_api_cost_usd: Number(runUsage.estimated_cost_usd || 0),
  });

  if (!alerts.length) {
    state.last_check_status = "no_gem";
    state.last_found_count = 0;
    state.last_sent_count = 0;
    saveState(state);
    await sendText(chatId, formatRunSummary({
      state,
      direct,
      discoveredCount: discovered.length,
      selectedCount: selected.length,
      solAudits,
      gemCount: 0,
    }));
    console.log(
      `Discovery: ${discovered.length}; Luna deep: ${selected.length}; Sol audits: ${solAudits}; no qualifying gem; estimated API cost: ${runUsage.estimated_cost_usd.toFixed(4)}.`
    );
    process.exit(0);
  }

  state.last_check_status = "found";
  state.last_found_count = alerts.length;
  state.last_sent_count = 0;
  saveState(state);

  await sendText(chatId, formatRunSummary({
    state,
    direct,
    discoveredCount: discovered.length,
    selectedCount: selected.length,
    solAudits,
    gemCount: alerts.length,
  }));

  if (alerts.length > 1) {
    await sendText(chatId, `🔥 За этот проход найдено ${alerts.length} ГЕМОВ. Отправляю каждый отдельным сообщением.`);
  }

  for (const alert of alerts.slice(0, 5)) {
    await sendText(chatId, alert.text);
    state.last_sent_count += 1;
    state.total_gems_sent = Number(state.total_gems_sent || 0) + 1;

    const item = watch[alert.key] || {};
    item.alerted = true;
    item.alerted_at = nowIso;
    item.alerted_price_usd = alert.price_usd;
    item.alerted_score = alert.score;
    watch[alert.key] = item;

    saveSeen(state, alert.text);
  }

  saveState(state);
  console.log(
    `${state.last_sent_count} gem(s) sent. Discovery: ${discovered.length}; Luna deep: ${selected.length}; Sol audits: ${solAudits}; estimated API cost: $${runUsage.estimated_cost_usd.toFixed(4)}.`
  );

} catch (error) {
  state.last_check_at = runStartedAt;
  state.last_check_status = "error";
  state.last_error = String(error?.message || error).slice(0, 500);
  state.completed_runs = Number(state.completed_runs || 0) + 1;
  persistApiUsage(state);
  saveState(state);
  try {
    await sendText(
      chatId,
      "⚠️ Car Gem Scout — проход завершился ошибкой\n\n" +
      state.last_error +
      "\n\n💸 API до ошибки: ~$" + Number(runUsage.estimated_cost_usd || 0).toFixed(3) +
      "\nСледующий плановый проход попробует снова."
    );
  } catch {}
  throw error;
}
