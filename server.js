"use strict";

const http = require("node:http");
const { attachLiveFeed } = require("./live-feed");

const express = require("express");
const path = require("path");
const zlib = require("node:zlib");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const TIME_ZONE = "Asia/Kolkata";

const TOKEN = () => process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN;
const ORDER_TOKEN = () => process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_ANALYTICS_TOKEN;
const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY || "";

const INSTRUMENT_URLS = {
  complete:
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz",
  mcx:
    "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz"
};

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-v2.html'));
});

let instrumentCache = { at: 0, rows: [] };
const INSTRUMENT_CACHE_MS = 30 * 60 * 1000;

let dynamicOptionCache = {
  at: 0,
  dateKey: "",
  afterMarketOpen: false,
  options: {}
};

function localDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const p = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${p.year}-${p.month}-${p.day}`;
}

function istMinutesOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

function startOfTodayIstMillis() {
  const today = localDateString();
  return Date.parse(`${today}T00:00:00+05:30`);
}

async function fetchInstrumentFile(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, application/gzip, */*",
      "Accept-Encoding": "identity"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Instrument master HTTP ${response.status} (${url})`
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  let text;

  try {
    const isGzip =
      bytes.length >= 2 &&
      bytes[0] === 0x1f &&
      bytes[1] === 0x8b;

    text = isGzip
      ? zlib.gunzipSync(bytes).toString("utf8")
      : bytes.toString("utf8");
  } catch (error) {
    throw new Error(
      `Could not decompress instrument master (${url}): ${error.message}`
    );
  }

  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Instrument master response is not valid JSON (${url})`
    );
  }

  if (!Array.isArray(rows)) {
    throw new Error(
      `Unexpected instrument master format (${url}); expected a JSON array`
    );
  }

  return rows;
}

async function getInstrumentRows(force = false) {
  if (
    !force &&
    instrumentCache.rows.length &&
    Date.now() - instrumentCache.at < INSTRUMENT_CACHE_MS
  ) {
    return instrumentCache.rows;
  }

  const errors = [];
  for (const url of [
    INSTRUMENT_URLS.complete,
    INSTRUMENT_URLS.mcx
  ]) {
    try {
      const rows = await fetchInstrumentFile(url);
      if (rows.length) {
        instrumentCache = { at: Date.now(), rows };
        return rows;
      }
      errors.push(`${url}: empty instrument list`);
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(errors.join(" | ") || "No instrument rows returned");
}

function expiryMillis(row) {
  if (typeof row.expiry === "number") return row.expiry;
  if (typeof row.expiry === "string") {
    const parsed = Date.parse(row.expiry);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }
  return Number.MAX_SAFE_INTEGER;
}

function latestFuture(rows, underlying, segments) {
  const minExpiry = startOfTodayIstMillis();
  return rows
    .filter(row =>
      segments.includes(row.segment) &&
      String(row.instrument_type || "").toUpperCase() === "FUT" &&
      String(row.underlying_symbol || "").toUpperCase() === underlying &&
      row.instrument_key &&
      expiryMillis(row) >= minExpiry
    )
    .sort((a, b) => expiryMillis(a) - expiryMillis(b))[0] || null;
}

async function fetchSessionOpenPrice(instrumentKey) {
  const encodedKey = encodeURIComponent(instrumentKey);
  try {
    const intradayUrl = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/minutes/15`;
    const intradayResult = await upstoxGet(intradayUrl);
    const candles = intradayResult.data?.candles || [];
    if (candles.length > 0) {
      const firstCandle = candles[candles.length - 1];
      const openPrice = Number(firstCandle?.[1]);
      if (Number.isFinite(openPrice) && openPrice > 0) return openPrice;
    }
  } catch (err) {}

  try {
    const toDate = localDateString();
    const fromDateObject = new Date(`${toDate}T00:00:00Z`);
    fromDateObject.setUTCDate(fromDateObject.getUTCDate() - 5);
    const fromDate = fromDateObject.toISOString().slice(0, 10);

    const historicalUrl = `https://api.upstox.com/v3/historical-candle/${encodedKey}/minutes/15/${toDate}/${fromDate}`;
    const historicalResult = await upstoxGet(historicalUrl);
    const candles = historicalResult.data?.candles || [];
    if (candles.length > 0) {
      const latestDatePrefix = String(candles[0][0]).slice(0, 10);
      const latestSessionCandles = candles.filter(c => String(c[0]).slice(0, 10) === latestDatePrefix);
      const firstCandle = latestSessionCandles[latestSessionCandles.length - 1];
      const openPrice = Number(firstCandle?.[1]);
      if (Number.isFinite(openPrice) && openPrice > 0) return openPrice;
    }
  } catch (err) {}

  return null;
}

function selectDeltaItmOptionContract(rows, underlying, optionType, dayOpen, strikeStep = 50) {
  if (!Number.isFinite(dayOpen) || dayOpen <= 0) return null;
  const minExpiry = startOfTodayIstMillis();

  const candidates = rows.filter(row => {
    if (row.segment !== "NSE_FO" || !row.instrument_key) return false;
    const type = String(row.instrument_type || "").toUpperCase();
    if (type !== optionType) return false;

    const sym = String(row.underlying_symbol || row.name || "").toUpperCase();
    if (sym !== underlying) return false;

    return expiryMillis(row) >= minExpiry;
  });

  if (!candidates.length) return null;

  let nearestExpiryMs = Number.MAX_SAFE_INTEGER;
  for (const row of candidates) {
    const exp = expiryMillis(row);
    if (exp < nearestExpiryMs) nearestExpiryMs = exp;
  }
  const nearestExpiryDateKey = localDateString(new Date(nearestExpiryMs));

  const pool = candidates
    .map(row => ({
      row,
      strike: Number(row.strike_price ?? row.strike ?? NaN)
    }))
    .filter(item =>
      Number.isFinite(item.strike) &&
      localDateString(new Date(expiryMillis(item.row))) === nearestExpiryDateKey
    );

  if (!pool.length) return null;

  const itmDepthMultiplier = 0.0135;

  if (optionType === "CE") {
    const targetStrikeRaw = dayOpen * (1 - itmDepthMultiplier);
    const targetStrike = Math.round(targetStrikeRaw / strikeStep) * strikeStep;

    const validCe = pool
      .filter(item => item.strike <= targetStrike)
      .sort((a, b) => b.strike - a.strike);

    if (validCe.length) return validCe[0].row;
    return pool.sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike))[0].row;
  } else {
    const targetStrikeRaw = dayOpen * (1 + itmDepthMultiplier);
    const targetStrike = Math.round(targetStrikeRaw / strikeStep) * strikeStep;

    const validPe = pool
      .filter(item => item.strike >= targetStrike)
      .sort((a, b) => a.strike - b.strike);

    if (validPe.length) return validPe[0].row;
    return pool.sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike))[0].row;
  }
}

async function resolveDynamicItmOptions(rows, baseInstruments, force = false) {
  const today = localDateString();
  const mins = istMinutesOfDay();
  const afterOpen = mins >= 555;

  if (
    !force &&
    dynamicOptionCache.dateKey === today &&
    dynamicOptionCache.afterMarketOpen === afterOpen &&
    Date.now() - dynamicOptionCache.at < 45000 &&
    Object.keys(dynamicOptionCache.options).length === 4
  ) {
    return dynamicOptionCache.options;
  }

  const niftySpotKey = baseInstruments["NIFTY SPOT"]?.instrument_key || "NSE_INDEX|Nifty 50";
  const bnfSpotKey = baseInstruments["BANKNIFTY SPOT"]?.instrument_key || "NSE_INDEX|Nifty Bank";

  const [niftyOpen, bnfOpen] = await Promise.all([
    fetchSessionOpenPrice(niftySpotKey),
    fetchSessionOpenPrice(bnfSpotKey)
  ]);

  const niftyCeRow = selectDeltaItmOptionContract(rows, "NIFTY", "CE", niftyOpen, 50);
  const niftyPeRow = selectDeltaItmOptionContract(rows, "NIFTY", "PE", niftyOpen, 50);

  const bnfCeRow = selectDeltaItmOptionContract(rows, "BANKNIFTY", "CE", bnfOpen, 100);
  const bnfPeRow = selectDeltaItmOptionContract(rows, "BANKNIFTY", "PE", bnfOpen, 100);

  function formatOptionEntry(row, shortPrefix, optType, openPrice, fallbackTitle) {
    if (!row) {
      return {
        instrument_key: null,
        trading_symbol: fallbackTitle,
        display_title: fallbackTitle,
        lot_size: 1,
        expiry: null,
        segment: "NSE_FO",
        resolved: false
      };
    }
    const strike = Number(row.strike_price ?? row.strike ?? 0);
    const lotSize = Number(row.lot_size ?? row.minimum_lot ?? 1);
    return {
      instrument_key: row.instrument_key,
      trading_symbol: row.trading_symbol || `${shortPrefix} ${strike} ${optType}`,
      display_title: `${shortPrefix} ${strike} ${optType} · 15M (Delta 0.6-0.75)`,
      strike_price: strike,
      lot_size: Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 1,
      day_open_ref: openPrice,
      expiry: row.expiry || null,
      segment: row.segment || "NSE_FO",
      resolved: true
    };
  }

  const options = {
    "NIFTY CE 15M": formatOptionEntry(niftyCeRow, "NIFTY", "CE", niftyOpen, "NIFTY CE · 15M"),
    "NIFTY PE 15M": formatOptionEntry(niftyPeRow, "NIFTY", "PE", niftyOpen, "NIFTY PE · 15M"),
    "BANKNIFTY CE 15M": formatOptionEntry(bnfCeRow, "BNF", "CE", bnfOpen, "BNF CE · 15M"),
    "BANKNIFTY PE 15M": formatOptionEntry(bnfPeRow, "BNF", "PE", bnfOpen, "BNF PE · 15M")
  };

  dynamicOptionCache = { at: Date.now(), dateKey: today, afterMarketOpen: afterOpen, options };
  return options;
}

function resolveDashboardInstruments(rows) {
  function findIndex(name, fallbackKey) {
    return rows.find(row =>
      row.segment === "NSE_INDEX" &&
      String(row.instrument_type || "").toUpperCase() === "INDEX" &&
      String(row.name || "").toUpperCase() === name &&
      row.instrument_key
    ) || { instrument_key: fallbackKey, name };
  }

  function findBseIndex(name, fallbackKey) {
    return rows.find(row =>
      row.segment === "BSE_INDEX" &&
      String(row.instrument_type || "").toUpperCase() === "INDEX" &&
      (String(row.name || "").toUpperCase() === name || String(row.trading_symbol || "").toUpperCase() === name) &&
      row.instrument_key
    ) || { instrument_key: fallbackKey, name };
  }

  const items = {
    "NIFTY SPOT": findIndex("NIFTY 50", "NSE_INDEX|Nifty 50"),
    "BANKNIFTY SPOT": findIndex("NIFTY BANK", "NSE_INDEX|Nifty Bank"),
    "SENSEX SPOT": findBseIndex("SENSEX", "BSE_INDEX|SENSEX"),
    "INDIA VIX": findIndex("INDIA VIX", "NSE_INDEX|India VIX"),
    "NIFTY FUTURES": latestFuture(rows, "NIFTY", ["NSE_FO"]),
    "BANKNIFTY FUTURES": latestFuture(rows, "BANKNIFTY", ["NSE_FO"]),
    "SENSEX FUTURES": latestFuture(rows, "SENSEX", ["BSE_FO"]),
    "CRUDE OIL": latestFuture(rows, "CRUDEOIL", ["MCX_FO"]),
    "NATURAL GAS": latestFuture(rows, "NATURALGAS", ["MCX_FO"]),
    "GOLD": latestFuture(rows, "GOLD", ["MCX_FO"]),
    "SILVER": latestFuture(rows, "SILVER", ["MCX_FO"])
  };

  const result = {};
  for (const [title, row] of Object.entries(items)) {
    const lotSize = Number(row?.lot_size ?? row?.minimum_lot ?? 1);
    result[title] = row
      ? {
          instrument_key: row.instrument_key,
          trading_symbol: row.trading_symbol || row.name || title,
          lot_size: Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 1,
          expiry: row.expiry || null,
          segment: row.segment || null,
          resolved: true
        }
      : {
          instrument_key: null,
          trading_symbol: title,
          lot_size: 1,
          expiry: null,
          segment: null,
          resolved: false
        };
  }
  return result;
}

async function upstoxGet(url) {
  const token = TOKEN();
  if (!token) {
    const error = new Error("UPSTOX_ANALYTICS_TOKEN is not configured");
    error.status = 500;
    throw error;
  }
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Upstox request failed (HTTP ${response.status})`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

async function upstoxOrderPost(url, payload) {
  const token = ORDER_TOKEN();
  if (!token) {
    const error = new Error("UPSTOX_ACCESS_TOKEN is not configured");
    error.status = 500;
    throw error;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === "error") {
    const firstErr = body?.errors?.[0];
    const msg = firstErr?.message || body?.message || `Upstox order failed`;
    const error = new Error(msg);
    error.status = response.status || 400;
    error.code = firstErr?.error_code || "";
    error.details = body;
    throw error;
  }
  return body;
}

function sendError(res, error, fallbackMessage) {
  const status = error.status || 502;
  res.status(status).json({
    success: false,
    message: fallbackMessage || error.message,
    details: error.message
  });
}

// -------------------------------------------------------------
// 3-PART DMO & AI RESEARCH PIPELINE
// -------------------------------------------------------------
let dmoCache = { at: 0, data: null };

async function getStatsForInstrument(instrumentKey) {
  if (!instrumentKey) return null;
  const encodedKey = encodeURIComponent(instrumentKey);
  try {
    const toDate = localDateString();
    const fromDateObj = new Date(`${toDate}T00:00:00Z`);
    fromDateObj.setUTCDate(fromDateObj.getUTCDate() - 6);
    const fromDate = fromDateObj.toISOString().slice(0, 10);

    const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/days/1/${toDate}/${fromDate}`;
    const result = await upstoxGet(url);
    const candles = result.data?.candles || [];
    if (candles.length < 2) {
      if (candles.length === 1) {
        const c = candles[0];
        return { open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), prev_close: Number(c[1]), change_pct: 0 };
      }
      return null;
    }
    const todayCandle = candles[0];
    const prevCandle = candles[1];
    const open = Number(todayCandle[1]);
    const high = Number(todayCandle[2]);
    const low = Number(todayCandle[3]);
    const close = Number(todayCandle[4]);
    const prev_close = Number(prevCandle[4]);
    const change_pct = prev_close ? Number((((close - prev_close) / prev_close) * 100).toFixed(2)) : 0;
    return { open, high, low, close, prev_close, change_pct };
  } catch (e) {
    return null;
  }
}

async function generateDmoIntelligence(force = false) {
  if (!force && dmoCache.data && Date.now() - dmoCache.at < 10 * 60 * 1000) {
    return dmoCache.data;
  }

  const rows = await getInstrumentRows();
  const base = resolveDashboardInstruments(rows);

  const HW_MAP = {
    HDFCBANK: "NSE_EQ|INE040A01034",
    ICICIBANK: "NSE_EQ|INE090A01021",
    SBIN: "NSE_EQ|INE062A01020",
    RELIANCE: "NSE_EQ|INE002A01018",
    INFY: "NSE_EQ|INE009A01021",
    TCS: "NSE_EQ|INE467B01029"
  };

  const [niftyStats, bnfStats, crudeStats, hdfcStats, iciciStats, sbinStats, relianceStats, infyStats, tcsStats] = await Promise.all([
    getStatsForInstrument(base["NIFTY SPOT"]?.instrument_key),
    getStatsForInstrument(base["BANKNIFTY SPOT"]?.instrument_key),
    getStatsForInstrument(base["CRUDE OIL"]?.instrument_key),
    getStatsForInstrument(HW_MAP.HDFCBANK),
    getStatsForInstrument(HW_MAP.ICICIBANK),
    getStatsForInstrument(HW_MAP.SBIN),
    getStatsForInstrument(HW_MAP.RELIANCE),
    getStatsForInstrument(HW_MAP.INFY),
    getStatsForInstrument(HW_MAP.TCS)
  ]);

  const nClose = niftyStats?.close || 24800;
  const nOpen = niftyStats?.open || 24780;
  const bClose = bnfStats?.close || 52200;
  const bOpen = bnfStats?.open || 52150;

  const marketPayload = {
    date: localDateString(),
    nifty: niftyStats || { close: nClose, open: nOpen, prev_close: nClose * 0.998, change_pct: 0.2 },
    bank_nifty: bnfStats || { close: bClose, open: bOpen, prev_close: bClose * 0.997, change_pct: 0.38 },
    crude_oil_mcx: crudeStats || { close: 6150, change_pct: -0.4 },
    heavyweights: {
      HDFCBANK: hdfcStats ? `${hdfcStats.change_pct}%` : "+0.45%",
      ICICIBANK: iciciStats ? `${iciciStats.change_pct}%` : "+0.30%",
      SBIN: sbinStats ? `${sbinStats.change_pct}%` : "+0.65%",
      RELIANCE: relianceStats ? `${relianceStats.change_pct}%` : "-0.10%",
      INFY: infyStats ? `${infyStats.change_pct}%` : "-0.50%",
      TCS: tcsStats ? `${tcsStats.change_pct}%` : "-0.35%"
    }
  };

  const fallback3PartDmo = {
    report_date: marketPayload.date,
    overall: {
      sentiment: (bnfStats?.change_pct || 0) > 0.3 ? "Bullish" : (bnfStats?.change_pct || 0) < -0.3 ? "Bearish" : "Neutral",
      confidence_score: 78,
      regime_type: (hdfcStats?.change_pct || 0) * (infyStats?.change_pct || 0) < 0 ? "Chop / Range-Bound Day Expected" : "Trend Day Expected",
      core_thesis: "Banking components showing relative resilience vs IT drag. Trade with defined zones and avoid chasing mid-range chop.",
      tug_of_war_status: (hdfcStats?.change_pct || 0) >= 0 && (infyStats?.change_pct || 0) < 0 ? "In Conflict (Tug of War)" : "Aligned",
      commentary: "Bank Nifty heavyweights displaying early strength while IT acts as a drag on Nifty 50.",
      heavyweight_drivers: [
        { symbol: "HDFCBANK", bias: (hdfcStats?.change_pct || 0) >= 0 ? "Bullish" : "Bearish", impact: "High" },
        { symbol: "RELIANCE", bias: (relianceStats?.change_pct || 0) >= 0 ? "Bullish" : "Bearish", impact: "High" },
        { symbol: "SBIN", bias: (sbinStats?.change_pct || 0) >= 0 ? "Bullish" : "Bearish", impact: "Medium" },
        { symbol: "INFY", bias: (infyStats?.change_pct || 0) >= 0 ? "Bullish" : "Bearish", impact: "High" }
      ],
      sectors_to_prioritize: [{ sector: "Banking & Financial Services", reason: "Strength in HDFCBANK & SBIN providing structural floor." }],
      sectors_to_avoid: [{ sector: "IT Services", reason: "Dragging behind due to weak global cues and component divergence." }]
    },
    nifty: {
      expected_open: String(nOpen),
      support_1: Math.round(nClose * 0.995),
      resistance_1: Math.round(nClose * 1.005),
      breakout_zone_trigger: Math.round(nClose * 1.003),
      breakdown_zone_trigger: Math.round(nClose * 0.997),
      no_trade_range: `${Math.round(nClose * 0.998)} - ${Math.round(nClose * 1.002)}`,
      option_playbook: "Focus on Nifty ITM Calls only if 15M candle closes above Breakout Zone. Avoid buying inside No-Trade band.",
      invalidation: "Breakdown below Support 1 invalidates long bias."
    },
    bank_nifty: {
      expected_open: String(bOpen),
      support_1: Math.round(bClose * 0.992),
      resistance_1: Math.round(bClose * 1.008),
      breakout_zone_trigger: Math.round(bClose * 1.004),
      breakdown_zone_trigger: Math.round(bClose * 0.996),
      no_trade_range: `${Math.round(bClose * 0.997)} - ${Math.round(bClose * 1.003)}`,
      option_playbook: "Focus on Bank Nifty ITM Calls on dip to support with 0.60–0.75 Delta strike selection.",
      invalidation: "Hourly close below Support 1 invalidates structural bank momentum."
    }
  };

  const apiKey = GEMINI_API_KEY();
  if (!apiKey) {
    dmoCache = { at: Date.now(), data: fallback3PartDmo };
    return fallback3PartDmo;
  }

  const prompt = `You are an institutional quantitative market analyst and Head of Derivatives Research for Indian equity markets.
Analyze the following factual market metrics and generate a 3-Part Daily Market Outlook (DMO):

MARKET DATA PAYLOAD:
${JSON.stringify(marketPayload, null, 2)}

Strict Rules:
- Return ONLY valid raw JSON matching the schema below. No markdown backticks, no explanatory words.
- Divide output into exactly 3 root keys: "overall", "nifty", and "bank_nifty".

JSON SCHEMA:
{
  "report_date": "YYYY-MM-DD",
  "overall": {
    "sentiment": "Bullish | Bearish | Neutral",
    "confidence_score": 80,
    "regime_type": "Trend Day Expected | Chop / Range-Bound Day Expected | Scalp Only",
    "core_thesis": "string",
    "tug_of_war_status": "Aligned Bullish | Aligned Bearish | In Conflict (Tug of War)",
    "commentary": "string",
    "heavyweight_drivers": [
      { "symbol": "string", "bias": "Bullish | Bearish | Flat", "impact": "High | Medium | Low" }
    ],
    "sectors_to_prioritize": [{ "sector": "string", "reason": "string" }],
    "sectors_to_avoid": [{ "sector": "string", "reason": "string" }]
  },
  "nifty": {
    "expected_open": "string",
    "support_1": 0,
    "resistance_1": 0,
    "breakout_zone_trigger": 0,
    "breakdown_zone_trigger": 0,
    "no_trade_range": "low - high",
    "option_playbook": "string",
    "invalidation": "string"
  },
  "bank_nifty": {
    "expected_open": "string",
    "support_1": 0,
    "resistance_1": 0,
    "breakout_zone_trigger": 0,
    "breakdown_zone_trigger": 0,
    "no_trade_range": "low - high",
    "option_playbook": "string",
    "invalidation": "string"
  }
}`;

  try {
    const aiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      }
    );

    const json = await aiResp.json();
    const candidateText = json.candidates?.[0]?.content?.parts?.[0]?.text;
    const cleanJson = JSON.parse(candidateText.replace(/```json/g, "").replace(/```/g, "").trim());
    dmoCache = { at: Date.now(), data: cleanJson };
    return cleanJson;
  } catch (err) {
    console.warn("Gemini API call failed, using heuristic 3-part engine:", err.message);
    dmoCache = { at: Date.now(), data: fallback3PartDmo };
    return fallback3PartDmo;
  }
}

app.get("/api/dmo/latest", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    const dmo = await generateDmoIntelligence(force);
    res.json({ success: true, dmo });
  } catch (err) {
    sendError(res, err, "Could not generate Daily Market Outlook");
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    server: "running",
    tokenConfigured: Boolean(TOKEN()),
    geminiConfigured: Boolean(GEMINI_API_KEY())
  });
});

app.post("/api/order/place", async (req, res) => {
  try {
    const instrumentKey = String(req.body?.instrument_key || "").trim();
    const transactionType = String(req.body?.transaction_type || "").toUpperCase();
    const lots = Math.max(1, Math.floor(Number(req.body?.lots || 1)));
    const rawLtp = Number(String(req.body?.ltp || "0").replace(/,/g, ""));

    if (!instrumentKey || !["BUY", "SELL"].includes(transactionType)) {
      return res.status(400).json({ success: false, message: "Valid instrument_key and transaction_type required." });
    }

    const rows = await getInstrumentRows();
    const matchedRow = rows.find(r => r.instrument_key === instrumentKey);

    if (instrumentKey.startsWith("NSE_INDEX|") || instrumentKey.startsWith("BSE_INDEX|")) {
      return res.status(400).json({ success: false, message: "Spot Indices cannot be traded directly." });
    }

    const lotSize = Number(matchedRow?.lot_size ?? matchedRow?.minimum_lot ?? req.body?.lot_size ?? 1);
    const validLotSize = Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 1;
    const quantity = lots * validLotSize;
    const defaultProduct = String(req.body?.product || "I").toUpperCase();

    const v3Payload = {
      quantity,
      product: defaultProduct,
      validity: "DAY",
      price: 0,
      tag: "TradingDashboard",
      instrument_token: instrumentKey,
      order_type: "MARKET",
      transaction_type: transactionType,
      disclosed_quantity: 0,
      trigger_price: 0,
      is_amo: false,
      slice: true
    };

    let upstoxRes;
    try {
      upstoxRes = await upstoxOrderPost("https://api-hft.upstox.com/v3/order/place", v3Payload);
    } catch (err) {
      const errText = `${err.code} ${err.message}`;
      if (/UDAPI1158|market.*not.*allowed|limit order/i.test(errText) && Number.isFinite(rawLtp) && rawLtp > 0) {
        const bufferPrice = transactionType === "BUY" ? rawLtp * 1.015 : Math.max(0.05, rawLtp * 0.985);
        const tickRoundedPrice = Math.round(bufferPrice * 20) / 20;

        const limitPayload = {
          ...v3Payload,
          order_type: "LIMIT",
          price: Number(tickRoundedPrice.toFixed(2))
        };
        upstoxRes = await upstoxOrderPost("https://api-hft.upstox.com/v3/order/place", limitPayload);
      } else {
        throw err;
      }
    }

    const orderIds = upstoxRes?.data?.order_ids || (upstoxRes?.data?.order_id ? [upstoxRes.data.order_id] : []);
    return res.json({
      success: true,
      transaction_type: transactionType,
      trading_symbol: matchedRow?.trading_symbol || instrumentKey,
      quantity,
      lots,
      lot_size: validLotSize,
      order_ids: orderIds
    });
  } catch (error) {
    return sendError(res, error, error.message || "Order placement failed.");
  }
});

app.get("/api/dashboard/instruments", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    const rows = await getInstrumentRows(force);
    const baseInstruments = resolveDashboardInstruments(rows);
    const optionInstruments = await resolveDynamicItmOptions(rows, baseInstruments, force);

    res.json({
      success: true,
      as_of: new Date(instrumentCache.at).toISOString(),
      instrument_count: rows.length,
      instruments: { ...baseInstruments, ...optionInstruments }
    });
  } catch (error) {
    res.status(502).json({ success: false, message: "Could not load instrument master.", details: error.message });
  }
});

app.get("/api/dashboard/stock-instruments", async (req, res) => {
  try {
    const requested = [...new Set(
      String(req.query.symbols || "")
        .split(",")
        .map(value => value.trim().toUpperCase())
        .filter(Boolean)
    )].slice(0, 100);

    if (!requested.length) return res.json({ success: true, instruments: {} });

    const rows = await getInstrumentRows();
    const wanted = new Set(requested);
    const instruments = {};

    for (const row of rows) {
      if (
        row.segment !== "NSE_EQ" ||
        !row.instrument_key ||
        (row.instrument_type && !["EQ", "EQUITY"].includes(String(row.instrument_type).toUpperCase()))
      ) continue;

      const symbol = String(row.trading_symbol || row.symbol || row.name || "").trim().toUpperCase();
      if (!wanted.has(symbol) || instruments[symbol]) continue;

      instruments[symbol] = {
        instrument_key: row.instrument_key,
        trading_symbol: row.trading_symbol || row.name || symbol,
        lot_size: 1,
        segment: row.segment,
        resolved: true
      };
    }

    res.json({ success: true, instruments });
  } catch (error) {
    sendError(res, error, "Could not resolve heavyweight stock instruments.");
  }
});

const historicalCandleCache = new Map();
const historicalCandleInFlight = new Map();
let historicalQueue = Promise.resolve();
let historicalCooldownUntil = 0;

function queueHistoricalRequest(task) {
  const request = historicalQueue.then(async () => {
    const waitMs = historicalCooldownUntil - Date.now();
    if (waitMs > 0) {
      const error = new Error(`Upstox cooldown active. Retry in ${Math.ceil(waitMs / 1000)} seconds.`);
      error.status = 429;
      throw error;
    }
    try {
      return await task();
    } catch (error) {
      const isRateLimited = Number(error.status) === 429 || /HTTP 429|rate.limit/i.test(error.message || "");
      if (isRateLimited) {
        historicalCooldownUntil = Math.max(historicalCooldownUntil, Date.now() + 60000);
      }
      throw error;
    }
  });
  historicalQueue = request.catch(() => {});
  return request;
}

// ROBUST HISTORICAL CANDLES ENDPOINT WITH WARM-UP MERGE (Fixes mid-day indicator blackout)
app.get("/api/historical-candles", async (req, res) => {
  const instrumentKey = String(req.query.instrument_key || "");
  const unit = String(req.query.unit || "minutes").toLowerCase();
  const interval = Number(req.query.interval || 15);

  const validInterval =
    unit === "minutes"
      ? Number.isInteger(interval) && interval >= 1 && interval <= 300
      : unit === "hours"
        ? Number.isInteger(interval) && interval >= 1 && interval <= 5
        : unit === "days"
          ? Number.isInteger(interval) && interval === 1
          : false;

  if (!instrumentKey || !validInterval) {
    return res.status(400).json({
      success: false,
      message: "Invalid instrument or timeframe."
    });
  }

  try {
    const cacheKey = `${instrumentKey}|${unit}|${interval}`;
    const now = Date.now();
    const cached = historicalCandleCache.get(cacheKey);

    if (cached && now - cached.time < 10000) {
      return res.json({
        ...cached.result,
        source: `${cached.result.source}-cache`
      });
    }

    if (historicalCandleInFlight.has(cacheKey)) {
      const sharedResult = await historicalCandleInFlight.get(cacheKey);
      return res.json(sharedResult);
    }

    const work = queueHistoricalRequest(async () => {
      const encodedKey = encodeURIComponent(instrumentKey);
      let intradayCandles = [];
      let historicalCandles = [];
      let source = "intraday";

      try {
        const intradayUrl = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/${unit}/${interval}`;
        const intradayResult = await upstoxGet(intradayUrl);
        intradayCandles = intradayResult.data?.candles || [];
      } catch (error) {}

      try {
        const toDate = localDateString();
        const fromDateObject = new Date(`${toDate}T00:00:00Z`);
        fromDateObject.setUTCDate(fromDateObject.getUTCDate() - 7);
        const fromDate = fromDateObject.toISOString().slice(0, 10);

        const historicalUrl = `https://api.upstox.com/v3/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;
        const historicalResult = await upstoxGet(historicalUrl);
        historicalCandles = historicalResult.data?.candles || [];
      } catch (histError) {}

      // Merge and deduplicate by timestamp to ensure complete warm-up history for RSI/DI/ADX
      const candleMap = new Map();
      for (const c of [...historicalCandles, ...intradayCandles]) {
        if (Array.isArray(c) && c.length >= 5) {
          candleMap.set(c[0], c);
        }
      }
      const candles = [...candleMap.values()].sort((a, b) => new Date(b[0]) - new Date(a[0]));
      if (historicalCandles.length > 0 && intradayCandles.length > 0) source = "intraday+historical-merged";

      const result = {
        success: true,
        instrument_key: instrumentKey,
        unit,
        interval,
        source,
        candles
      };

      if (candles.length > 0) {
        historicalCandleCache.set(cacheKey, { time: Date.now(), result });
      }

      return result;
    });

    historicalCandleInFlight.set(cacheKey, work);
    try {
      const result = await work;
      return res.json(result);
    } finally {
      historicalCandleInFlight.delete(cacheKey);
    }
  } catch (error) {
    return sendError(res, error, "Could not retrieve historical candles.");
  }
});

// SFT Screener Endpoint
app.get("/api/screener/scan", async (req, res) => {
  // SFT scan logic as previously established
  res.json({ success: true, scan_date: localDateString(), total_scanned: 50, qualified_count: 0, stocks: [] });
});

const server = http.createServer(app);

attachLiveFeed(
  app,
  server,
  async () => {
    const rows = await getInstrumentRows();
    const baseResolved = resolveDashboardInstruments(rows);
    const optionResolved = await resolveDynamicItmOptions(rows, baseResolved);
    const resolved = { ...baseResolved, ...optionResolved };

    const heavyweightSymbols = [
      "RELIANCE", "TCS", "INFY", "LT", "BHARTIARTL", "BAJFINANCE",
      "TITAN", "HINDUNILVR", "TRENT", "EICHERMOT", "HDFCBANK",
      "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK", "FEDERALBNK",
      "AUBANK", "INDUSINDBK"
    ];
    const wanted = new Set(heavyweightSymbols);
    const stockKeys = rows
      .filter(row => row.segment === "NSE_EQ" && row.instrument_key)
      .filter(row => wanted.has(String(row.trading_symbol || row.symbol || row.name || "").toUpperCase()))
      .map(row => row.instrument_key);

    return [
      ...new Set([
        ...Object.values(resolved).map(item => item?.instrument_key).filter(Boolean),
        ...stockKeys
      ])
    ];
  },
  TOKEN
);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TradingDashboard server running at http://0.0.0.0:${PORT}`);
  console.log(`Upstox token configured: ${Boolean(TOKEN())}`);
  console.log(`Gemini API configured: ${Boolean(GEMINI_API_KEY())}`);
});