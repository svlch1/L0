import fs from "node:fs";
import crypto from "node:crypto";
import { collectDirectSources, commitObservedUrls } from "./sources.mjs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TEST_ONLY = process.env.TEST_ONLY === "true";

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
  return (data?.output || []).filter((x) => x?.type === "web_search_call").length;
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

function persistApiUsage(state) {
  state.last_api_usage = JSON.parse(JSON.stringify(runUsage));

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
    "Источники: AUTO.RIA + KIEVAVTO + IsAuto",
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

function normalizeUrl(url) {
  return String(url || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function candidateKey(candidate) {
  const vin = String(candidate.vin || "").toUpperCase().trim();
  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return "VIN:" + vin;
  const url = normalizeUrl(candidate.auto_ria_url || candidate.telegram_url || candidate.source_url);
  return "URL:" + crypto.createHash("sha1").update(url || JSON.stringify(candidate)).digest("hex").slice(0, 16);
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

function weightedScore(a) {
  const clamp = (n) => Math.max(0, Math.min(10, Number(n || 0)));
  return Math.round((
    clamp(a.price_score) * 0.25 +
    clamp(a.history_score) * 0.25 +
    clamp(a.technical_score) * 0.20 +
    clamp(a.liquidity_score) * 0.15 +
    clamp(a.emotion_score) * 0.10 +
    clamp(a.trim_score) * 0.05
  ) * 100) / 100;
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

function formatRunSummary({ state, direct, discoveredCount, selectedCount, solAudits, gemCount }) {
  const usage = state.last_api_usage || runUsage;
  const today = state.api_usage_today || {};
  const almostCount = Object.values(state.almost_gems_by_key || {})
    .filter((x) => Number(x.score || 0) >= 7.8 && Number(x.score || 0) < 8.5)
    .length;
  const watchCount = Object.keys(state.market_watch || {}).length;
  const autoCount = Number(direct?.stats?.auto_ria_candidates || 0);
  const tgCount = Number(direct?.stats?.telegram_candidates || 0);
  const sourceErrors = Number(direct?.stats?.source_errors || 0);

  return [
    "📡 Car Gem Scout — проход завершён",
    "",
    `📥 Прямой сбор: AUTO.RIA ${autoCount} / Telegram ${tgCount}`,
    `🧲 После discovery: ${discoveredCount}`,
    `🔬 Luna deep-analysis: ${selectedCount}`,
    `🧠 Sol final audit: ${solAudits}`,
    `🟡 Почти гемов 7.8–8.4: ${almostCount} (команда /almost)`,
    `👀 Под price-watch: ${watchCount}`,
    `🔥 ГЕМов >=8.5 в этом проходе: ${gemCount}`,
    sourceErrors ? `⚠️ Ошибок источников: ${sourceErrors}` : null,
    "",
    `💸 API проход: ~$ ${Number(usage.estimated_cost_usd || 0).toFixed(3)}`.replace("$ ", "$"),
    `🪙 Tokens: in ${compactTokens(usage.input_tokens)} / out ${compactTokens(usage.output_tokens)} / web ${usage.web_search_calls || 0}`,
    `📅 API сегодня (учтено ботом): ~$ ${Number(today.estimated_cost_usd || 0).toFixed(3)}`.replace("$ ", "$"),
    "",
    gemCount ? "👇 Ниже отправлю найденные ГЕМЫ отдельными сообщениями." : "ГЕМов нет — следующий проход по расписанию.",
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
- не тащи скучные массовые седаны;
- Kia Stinger только при аномально выгодной сделке;
- очевидные flood/fire/тяжёлый structural мусор не выбирай, если это прямо видно в тексте;
- для каждого поставь discovery_score 0–10.

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
Проверь AUTO.RIA, KIEVAVTO (https://t.me/kievavto2) и IsAuto (https://t.me/isAuto99).

КРИТЕРИИ:
- бюджет до $25,000; до ~$26,500 только для очень сильного варианта;
- пробег желательно <=70k км, до ~90k допустимо;
- эффектный спортивный/премиальный автомобиль;
- ~6 сек 0–100 или быстрее желательно;
- ориентир Infiniti Q60; также BMW 3/4, Mercedes C/CLA/coupe, Lexus RC/IS, Audi и аналоги;
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

async function lunaAnalyzeOne(candidate) {
  const prompt = `
Ты — экономный, но тщательный DEEP ANALYSIS-этап Car Gem Scout.
Проверь конкретную машину. Используй web search только для вещей, реально влияющих на решение: VIN/аукцион, украинский рынок и критичные технические риски.

КАНДИДАТ:
${JSON.stringify(candidate)}

МОЙ ПРОФИЛЬ:
- первая машина в Украине;
- максимум около $25,000;
- пробег желательно 60–70k км;
- хочу эффектную спортивную/премиальную машину;
- 0–100 желательно ~6 сек или быстрее;
- важны надёжность, ликвидность и умеренная потеря цены;
- главный ориентир Infiniti Q60.

ОБЯЗАТЕЛЬНО:
- по VIN попробуй найти Copart / IAAI / BidFax / Stat.vin или другой доступный архив;
- выясни damage, Run & Drive/Starts, airbags, structure, flood, auction mileage, Estimated Repair Cost, ACV, Retail Value, Final Bid, фото до ремонта;
- сравни цену с украинским рынком;
- оцени Real Buy-In первые ~6 месяцев;
- учти комплектацию;
- если данных нет — не выдумывай.

HARD REJECT: flood/water, fire, тяжёлый structural/safety-cell/geometry, тяжёлый фронт с риском силового агрегата/охлаждения, тяжёлый множественный SRS, сомнительное восстановление.

SCORING 0–10:
price 25%, history 25%, technical 20%, liquidity 15%, emotion 10%, trim 5%.
confidence_pct отражает полноту подтверждения.
target_buy_price_usd — цена, при которой машина стала бы действительно интересной.

candidate_key скопируй ТОЧНО: ${candidate.candidate_key}
`;

  const result = await openaiJson({
    prompt,
    schema: analysisSchema,
    name: "luna_car_deep_analysis",
    model: LUNA_MODEL,
    effort: "medium",
    maxOutputTokens: 4500,
    useWebSearch: true,
    searchContextSize: "medium",
    maxToolCalls: 3,
  });

  return (result.analyses || [])[0] || null;
}

async function solAuditOne(candidate, preliminary) {
  const prompt = `
Ты — FINAL AUDITOR Car Gem Scout. Luna уже сделала предварительный глубокий анализ машины.
Твоя задача — НЕ повторять весь ресерч без необходимости, а проверить самые критичные места и решить, можно ли реально отправлять пользователю алерт "ГЕМ".

КАНДИДАТ:
${JSON.stringify(candidate)}

ПРЕДВАРИТЕЛЬНЫЙ АНАЛИЗ LUNA:
${JSON.stringify(preliminary)}

ПРОВЕРЬ В ПЕРВУЮ ОЧЕРЕДЬ:
1) VIN/аукцион и реальную тяжесть повреждения;
2) flood/fire/structure/SRS и любые стоп-факторы;
3) текущую цену против рынка Украины;
4) технический риск крупных расходов;
5) не завышены ли score/confidence.

Не трать поиск на очевидные уже подтверждённые мелочи. Если источник не найден — снижай confidence, не выдумывай.
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
    maxToolCalls: 3,
  });

  return (result.analyses || [])[0] || null;
}

async function deepAnalyzeCandidates(candidates) {
  if (!candidates.length) return { analyses: [], failed: 0 };

  const analyses = [];
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const result = await lunaAnalyzeOne(candidate);
      if (result) analyses.push(result);
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error("Luna analysis failed for " + candidate.candidate_key + ": " + String(error?.message || error));
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  if (candidates.length > 0 && analyses.length === 0) {
    throw new Error("All selected Luna analyses failed (" + failed + "/" + candidates.length + ")");
  }

  return { analyses, failed };
}

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const runStartedAt = new Date().toISOString();
const chatId = await getChatId();
const state = loadSeen();


if (TEST_ONLY) {
  state.last_test_at = runStartedAt;
  saveState(state);
  await sendText(chatId,
    "✅ Car Gem Scout подключён.\n\n" +
    "Режим: каждые 4 часа / 6 раз в сутки.\n" +
    "Проверяю AUTO.RIA + KIEVAVTO + IsAuto и пишу сюда только когда нахожу реальный ГЕМ.\n\n" +
    "Команды: /start или /status — статус; /almost — машины с рейтингом 7.8–8.4."
  );
  process.exit(0);
}

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

try {
  const direct = await collectDirectSources(state);
  state.last_collector_stats = direct.stats;
  state.last_collector_errors = (direct.errors || []).slice(0, 8);
  state.last_collector_mode = direct.items.length ? "direct" : "web_fallback";

  const discovery = await discoverCandidates(state, direct.items);
  commitObservedUrls(state, direct.observed_urls);

  const nowIso = new Date().toISOString();
  const discovered = (discovery.candidates || [])
    .filter((x) => x && (x.source_url || x.auto_ria_url || x.telegram_url))
    .map((x) => recordDiscoveredCandidate(state, x, nowIso));

  state.last_discovered_count = discovered.length;

  const selected = discovered
    .filter((x) => {
      if (x.needs_sol_audit) return true;
      if (x.never_analyzed) return true;
      if (x.price_drop_trigger) return true;
      if (x.target_price_trigger) return true;
      return false;
    })
    .sort((a, b) => {
      const ap =
        (a.needs_sol_audit ? 1500 : 0) +
        (a.target_price_trigger ? 1000 : 0) +
        (a.price_drop_trigger ? 500 : 0) +
        (a.never_analyzed ? 100 : 0) +
        Number(a.discovery_score || 0);
      const bp =
        (b.needs_sol_audit ? 1500 : 0) +
        (b.target_price_trigger ? 1000 : 0) +
        (b.price_drop_trigger ? 500 : 0) +
        (b.never_analyzed ? 100 : 0) +
        Number(b.discovery_score || 0);
      return bp - ap;
    })
    .slice(0, 2);

  state.last_deep_analyzed_count = selected.length;
  saveState(state);

  const deep = await deepAnalyzeCandidates(selected);
  state.last_deep_failed_count = Number(deep.failed || 0);

  const lunaByKey = new Map((deep.analyses || []).map((a) => [a.candidate_key, a]));
  const watch = ensureMarketWatch(state);
  const almost = ensureAlmostGems(state);
  const alerts = [];
  let solAudits = 0;
  let solAuditFailures = 0;

  for (const candidate of selected) {
    const luna = lunaByKey.get(candidate.candidate_key);
    if (!luna) continue;

    const lunaScore = weightedScore(luna);
    const lunaConfidence = Number(luna.confidence_pct || 0);
    const lunaPrice = Number(luna.price_usd || candidate.price_usd || 0);

    const shouldAuditWithSol =
      !luna.hard_reject &&
      lunaScore >= 8.1 &&
      lunaConfidence >= 60 &&
      lunaPrice > 0 &&
      lunaPrice <= 26000;

    let finalAnalysis = luna;
    let solAuditOk = !shouldAuditWithSol;

    if (shouldAuditWithSol) {
      solAudits += 1;
      try {
        const audited = await solAuditOne(candidate, luna);
        if (audited) {
          finalAnalysis = audited;
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
      Number(a.price_usd || candidate.price_usd || 0) <= 26000
    ) {
      almost[candidate.candidate_key] = almostSnapshot(a, score, candidate, nowIso);
    } else {
      delete almost[candidate.candidate_key];
    }

    const qualifies =
      solAuditOk &&
      !a.hard_reject &&
      score >= 8.5 &&
      Number(a.confidence_pct || 0) >= 70 &&
      Number(a.price_usd || candidate.price_usd || 0) <= 26000;

    const mayRepeat = candidate.price_drop_trigger || candidate.target_price_trigger;
    if (qualifies && (!item.alerted || mayRepeat)) {
      alerts.push({
        text: formatGemAlert(a, score, candidate),
        key: candidate.candidate_key,
        score,
        price_usd: Number(a.price_usd || candidate.price_usd || 0),
      });
    }
  }

  state.last_sol_audits = solAudits;
  state.last_sol_audit_failures = solAuditFailures;
  state.last_check_at = runStartedAt;
  state.completed_runs = Number(state.completed_runs || 0) + 1;
  state.last_error = null;
  persistApiUsage(state);

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
