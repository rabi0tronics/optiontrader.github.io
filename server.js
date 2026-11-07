"use strict";

const http = require("node:http");
const { attachLiveFeed } = require("./live-feed");

const express = require("express");
const path = require("path");
const zlib = require("node:zlib");
require("dotenv").config();

const app = express();
const PORT = 3000;
const TIME_ZONE = "Asia/Kolkata";

const TOKEN = () => process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN;
const ORDER_TOKEN = () => process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_ANALYTICS_TOKEN;

const INSTRUMENT_URLS = {
  complete:
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz",
  mcx:
    "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz"
};

app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

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
      `Instrument master response is not valid JSON (${url}; ` +
      `content-type: ${response.headers.get("content-type") || "unknown"}; ` +
      `first characters: ${text.slice(0, 80).replace(/\s+/g, " ")})`
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
        instrumentCache = {
          at: Date.now(),
          rows
        };

        return rows;
      }

      errors.push(`${url}: empty instrument list`);
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(
    errors.join(" | ") || "No instrument rows returned"
  );
}

function expiryMillis(row) {
  if (typeof row.expiry === "number") {
    return row.expiry;
  }

  if (typeof row.expiry === "string") {
    const parsed = Date.parse(row.expiry);

    return Number.isFinite(parsed)
      ? parsed
      : Number.MAX_SAFE_INTEGER;
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

  // 1. Try today's intraday 15m candles first
  try {
    const intradayUrl =
      `https://api.upstox.com/v3/historical-candle/intraday/` +
      `${encodedKey}/minutes/15`;
    const intradayResult = await upstoxGet(intradayUrl);
    const candles = intradayResult.data?.candles || [];

    if (candles.length > 0) {
      const firstCandle = candles[candles.length - 1];
      const openPrice = Number(firstCandle?.[1]);
      if (Number.isFinite(openPrice) && openPrice > 0) {
        return openPrice;
      }
    }
  } catch (err) {
    // Fallback to historical below
  }

  // 2. Fallback to latest session in 5-day historical 15m candles
  try {
    const toDate = localDateString();
    const fromDateObject = new Date(`${toDate}T00:00:00Z`);
    fromDateObject.setUTCDate(fromDateObject.getUTCDate() - 5);
    const fromDate = fromDateObject.toISOString().slice(0, 10);

    const historicalUrl =
      `https://api.upstox.com/v3/historical-candle/` +
      `${encodedKey}/minutes/15/${toDate}/${fromDate}`;
    const historicalResult = await upstoxGet(historicalUrl);
    const candles = historicalResult.data?.candles || [];

    if (candles.length > 0) {
      const latestDatePrefix = String(candles[0][0]).slice(0, 10);
      const latestSessionCandles = candles.filter(
        c => String(c[0]).slice(0, 10) === latestDatePrefix
      );
      const firstCandle =
        latestSessionCandles[latestSessionCandles.length - 1];
      const openPrice = Number(firstCandle?.[1]);
      if (Number.isFinite(openPrice) && openPrice > 0) {
        return openPrice;
      }
    }
  } catch (err) {
    console.warn(`Could not fetch session open for ${instrumentKey}:`, err.message);
  }

  return null;
}

function selectItmOptionContract(rows, underlying, optionType, dayOpen, minItmPoints) {
  if (!Number.isFinite(dayOpen) || dayOpen <= 0) return null;

  const minExpiry = startOfTodayIstMillis();

  const candidates = rows.filter(row => {
    if (row.segment !== "NSE_FO" || !row.instrument_key) return false;
    const type = String(row.instrument_type || "").toUpperCase();
    if (type !== optionType) return false;

    const sym = String(row.underlying_symbol || row.name || "").toUpperCase();
    if (sym !== underlying) return false;

    const exp = expiryMillis(row);
    return exp >= minExpiry;
  });

  if (!candidates.length) return null;

  let nearestExpiryMs = Number.MAX_SAFE_INTEGER;
  for (const row of candidates) {
    const exp = expiryMillis(row);
    if (exp < nearestExpiryMs) nearestExpiryMs = exp;
  }

  const nearestExpiryDateKey = localDateString(new Date(nearestExpiryMs));

  const currentExpiryRows = candidates
    .map(row => ({
      row,
      strike: Number(row.strike_price ?? row.strike ?? NaN)
    }))
    .filter(item =>
      Number.isFinite(item.strike) &&
      Math.round(item.strike) % 100 === 0 &&
      localDateString(new Date(expiryMillis(item.row))) === nearestExpiryDateKey
    );

  const pool = currentExpiryRows.length
    ? currentExpiryRows
    : candidates
        .map(row => ({
          row,
          strike: Number(row.strike_price ?? row.strike ?? NaN)
        }))
        .filter(
          item =>
            Number.isFinite(item.strike) &&
            localDateString(new Date(expiryMillis(item.row))) === nearestExpiryDateKey
        );

  if (!pool.length) return null;

  if (optionType === "CE") {
    const targetMaxStrike = Math.floor((dayOpen - minItmPoints) / 100) * 100;
    const validCe = pool
      .filter(item => item.strike <= targetMaxStrike)
      .sort((a, b) => b.strike - a.strike);

    if (validCe.length) return validCe[0].row;

    return pool.sort(
      (a, b) => Math.abs(a.strike - targetMaxStrike) - Math.abs(b.strike - targetMaxStrike)
    )[0].row;
  } else {
    const targetMinStrike = Math.ceil((dayOpen + minItmPoints) / 100) * 100;
    const validPe = pool
      .filter(item => item.strike >= targetMinStrike)
      .sort((a, b) => a.strike - b.strike);

    if (validPe.length) return validPe[0].row;

    return pool.sort(
      (a, b) => Math.abs(a.strike - targetMinStrike) - Math.abs(b.strike - targetMinStrike)
    )[0].row;
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

  const niftyCeRow = selectItmOptionContract(rows, "NIFTY", "CE", niftyOpen, 150);
  const niftyPeRow = selectItmOptionContract(rows, "NIFTY", "PE", niftyOpen, 150);

  const bnfCeRow = selectItmOptionContract(rows, "BANKNIFTY", "CE", bnfOpen, 250);
  const bnfPeRow = selectItmOptionContract(rows, "BANKNIFTY", "PE", bnfOpen, 250);

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
      display_title: `${shortPrefix} ${strike} ${optType} · 15M`,
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

  dynamicOptionCache = {
    at: Date.now(),
    dateKey: today,
    afterMarketOpen: afterOpen,
    options
  };

  console.log("[DYNAMIC ITM OPTIONS RESOLVED]", {
    niftyOpen,
    niftyCE: `${options["NIFTY CE 15M"].display_title} (Lot: ${options["NIFTY CE 15M"].lot_size})`,
    niftyPE: `${options["NIFTY PE 15M"].display_title} (Lot: ${options["NIFTY PE 15M"].lot_size})`,
    bnfOpen,
    bnfCE: `${options["BANKNIFTY CE 15M"].display_title} (Lot: ${options["BANKNIFTY CE 15M"].lot_size})`,
    bnfPE: `${options["BANKNIFTY PE 15M"].display_title} (Lot: ${options["BANKNIFTY PE 15M"].lot_size})`
  });

  return options;
}

function resolveDashboardInstruments(rows) {
  function findIndex(name, fallbackKey) {
    return rows.find(row =>
      row.segment === "NSE_INDEX" &&
      String(row.instrument_type || "").toUpperCase() === "INDEX" &&
      String(row.name || "").toUpperCase() === name &&
      row.instrument_key
    ) || {
      instrument_key: fallbackKey,
      name
    };
  }

  function findBseIndex(name, fallbackKey) {
    return rows.find(row =>
      row.segment === "BSE_INDEX" &&
      String(row.instrument_type || "").toUpperCase() === "INDEX" &&
      (
        String(row.name || "").toUpperCase() === name ||
        String(row.trading_symbol || "").toUpperCase() === name
      ) &&
      row.instrument_key
    ) || {
      instrument_key: fallbackKey,
      name
    };
  }

  const items = {
    "NIFTY SPOT": findIndex(
      "NIFTY 50",
      "NSE_INDEX|Nifty 50"
    ),

    "BANKNIFTY SPOT": findIndex(
      "NIFTY BANK",
      "NSE_INDEX|Nifty Bank"
    ),

    "SENSEX SPOT": findBseIndex(
      "SENSEX",
      "BSE_INDEX|SENSEX"
    ),

    "INDIA VIX": findIndex(
      "INDIA VIX",
      "NSE_INDEX|India VIX"
    ),

    "NIFTY FUTURES": latestFuture(
      rows, "NIFTY", ["NSE_FO"]
    ),

    "BANKNIFTY FUTURES": latestFuture(
      rows, "BANKNIFTY", ["NSE_FO"]
    ),

    "SENSEX FUTURES": latestFuture(
      rows, "SENSEX", ["BSE_FO"]
    ),

    "CRUDE OIL": latestFuture(
      rows, "CRUDEOIL", ["MCX_FO"]
    ),

    "NATURAL GAS": latestFuture(
      rows, "NATURALGAS", ["MCX_FO"]
    ),

    "GOLD": latestFuture(
      rows, "GOLD", ["MCX_FO"]
    ),

    "SILVER": latestFuture(
      rows, "SILVER", ["MCX_FO"]
    )
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
    const error = new Error(
      "UPSTOX_ANALYTICS_TOKEN is not configured in server/.env"
    );

    error.status = 500;
    throw error;
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      `Upstox request failed (HTTP ${response.status})`
    );

    error.status = response.status;
    error.details = body;
    throw error;
  }

  return body;
}

async function upstoxOrderPost(url, payload) {
  const token = ORDER_TOKEN();

  if (!token) {
    const error = new Error(
      "UPSTOX_ACCESS_TOKEN / UPSTOX_ANALYTICS_TOKEN is not configured in server/.env"
    );
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
    const msg =
      firstErr?.message ||
      body?.message ||
      `Upstox order failed (HTTP ${response.status})`;
    const error = new Error(msg);
    error.status = response.status || 400;
    error.code = firstErr?.error_code || firstErr?.errorCode || "";
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
    details: error.message,
    ...(error.details ? { upstox_response: error.details } : {})
  });
}

app.get("/api/status", (req, res) => {
  res.json({
    server: "running",
    tokenConfigured: Boolean(TOKEN()),
    marketData: "upstox-api-configured"
  });
});

// LIVE UPSTOX TERMINAL ORDER EXECUTION ENDPOINT
app.post("/api/order/place", async (req, res) => {
  try {
    const instrumentKey = String(req.body?.instrument_key || "").trim();
    const transactionType = String(req.body?.transaction_type || "").toUpperCase();
    const lots = Math.max(1, Math.floor(Number(req.body?.lots || 1)));
    const rawLtp = Number(String(req.body?.ltp || "0").replace(/,/g, ""));

    if (!instrumentKey || !["BUY", "SELL"].includes(transactionType)) {
      return res.status(400).json({
        success: false,
        message: "Valid instrument_key and transaction_type (BUY/SELL) are required."
      });
    }

    const rows = await getInstrumentRows();
    const matchedRow = rows.find(r => r.instrument_key === instrumentKey);

    // Prevent ordering directly on spot indices (NSE_INDEX / BSE_INDEX); map to Futures if clicked
    if (instrumentKey.startsWith("NSE_INDEX|") || instrumentKey.startsWith("BSE_INDEX|")) {
      return res.status(400).json({
        success: false,
        message: "Spot Indices cannot be traded directly. Use Option or Futures charts."
      });
    }

    const lotSize = Number(
      matchedRow?.lot_size ??
      matchedRow?.minimum_lot ??
      req.body?.lot_size ??
      1
    );
    const validLotSize = Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 1;
    const quantity = lots * validLotSize;

    // Product: "D" (Delivery/NRML for F&O/MCX carryforward) or "I" (Intraday MIS)
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

    console.log("[PLACING LIVE ORDER -> UPSTOX]", {
      symbol: matchedRow?.trading_symbol || instrumentKey,
      transactionType,
      lots,
      lotSize: validLotSize,
      quantity,
      product: defaultProduct
    });

    let upstoxRes;
    try {
      upstoxRes = await upstoxOrderPost(
        "https://api-hft.upstox.com/v3/order/place",
        v3Payload
      );
    } catch (err) {
      // If Upstox/Exchange disallows MARKET order on Options (UDAPI1158), auto-place marketable LIMIT order
      const errText = `${err.code} ${err.message}`;
      if (
        (/UDAPI1158|market.*not.*allowed|limit order/i.test(errText)) &&
        Number.isFinite(rawLtp) &&
        rawLtp > 0
      ) {
        const bufferPrice =
          transactionType === "BUY" ? rawLtp * 1.015 : Math.max(0.05, rawLtp * 0.985);
        const tickRoundedPrice = Math.round(bufferPrice * 20) / 20;

        const limitPayload = {
          ...v3Payload,
          order_type: "LIMIT",
          price: Number(tickRoundedPrice.toFixed(2))
        };

        console.log("[AUTO-RETRYING AS MARKETABLE LIMIT ORDER]", limitPayload);
        upstoxRes = await upstoxOrderPost(
          "https://api-hft.upstox.com/v3/order/place",
          limitPayload
        );
      } else {
        throw err;
      }
    }

    const orderIds =
      upstoxRes?.data?.order_ids ||
      (upstoxRes?.data?.order_id ? [upstoxRes.data.order_id] : []);

    console.log("[ORDER SUCCESS]", {
      symbol: matchedRow?.trading_symbol || instrumentKey,
      orderIds
    });

    return res.json({
      success: true,
      transaction_type: transactionType,
      trading_symbol: matchedRow?.trading_symbol || instrumentKey,
      quantity,
      lots,
      lot_size: validLotSize,
      order_ids: orderIds,
      upstox: upstoxRes
    });
  } catch (error) {
    console.error("[ORDER ERROR]", error.message, error.details || "");
    return sendError(res, error, error.message || "Order placement failed.");
  }
});

app.get("/api/upstox-test", async (req, res) => {
  try {
    const data = await upstoxGet(
      "https://api.upstox.com/v3/market-quote/quotes" +
      "?instrument_key=NSE_EQ%7CINE002A01018"
    );

    res.json({
      success: true,
      message: "Upstox accepted the request.",
      data
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/upstox-feed-auth-test", async (req, res) => {
  try {
    const data = await upstoxGet(
      "https://api.upstox.com/v3/feed/market-data-feed/authorize"
    );

    const authorized =
      data?.status === "success" &&
      typeof data?.data?.authorized_redirect_uri === "string" &&
      data.data.authorized_redirect_uri.startsWith("wss://");

    res.json({
      success: authorized,
      message: authorized
        ? "Upstox live-feed authorization succeeded."
        : "Authorization response format was unexpected."
    });
  } catch (error) {
    sendError(res, error);
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
      instruments: {
        ...baseInstruments,
        ...optionInstruments
      }
    });
  } catch (error) {
    console.error(
      "Instrument master error:",
      error.message
    );

    res.status(502).json({
      success: false,
      message: "Could not load the Upstox instrument master.",
      details: error.message
    });
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

    if (!requested.length) {
      return res.json({ success: true, instruments: {} });
    }

    const rows = await getInstrumentRows();
    const wanted = new Set(requested);
    const instruments = {};

    for (const row of rows) {
      if (
        row.segment !== "NSE_EQ" ||
        !row.instrument_key ||
        (row.instrument_type &&
          !["EQ", "EQUITY"].includes(String(row.instrument_type).toUpperCase()))
      ) continue;

      const symbol = String(row.trading_symbol || row.symbol || row.name || "")
        .trim()
        .toUpperCase();
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
      const error = new Error(
        `Upstox cooldown active. Retry in ${Math.ceil(waitMs / 1000)} seconds.`
      );

      error.status = 429;
      throw error;
    }

    try {
      return await task();
    } catch (error) {
      const isRateLimited =
        Number(error.status) === 429 ||
        Number(error.statusCode) === 429 ||
        /HTTP 429|rate.limit|error 1015/i.test(error.message || "");

      if (isRateLimited) {
        const retrySeconds = Math.max(
          60,
          Number(error.retry_after || error.retryAfter || 60)
        );

        historicalCooldownUntil = Math.max(
          historicalCooldownUntil,
          Date.now() + retrySeconds * 1000
        );
      }

      throw error;
    }
  });

  historicalQueue = request.catch(() => {});
  return request;
}

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

  const fixedKeys = new Set([
    "NSE_INDEX|Nifty 50",
    "NSE_INDEX|Nifty Bank",
    "BSE_INDEX|SENSEX",
    "NSE_INDEX|India VIX"
  ]);

  try {
    const rows = await getInstrumentRows();

    const knownKey =
      fixedKeys.has(instrumentKey) ||
      rows.some(row => row.instrument_key === instrumentKey);

    if (!knownKey) {
      return res.status(400).json({
        success: false,
        message: "Unknown instrument key."
      });
    }

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
      const sharedResult =
        await historicalCandleInFlight.get(cacheKey);

      return res.json(sharedResult);
    }

    const work = queueHistoricalRequest(async () => {
      const encodedKey = encodeURIComponent(instrumentKey);

      let candles = [];
      let source = "intraday";

      if (unit === "hours" && interval === 1) {
        const toDate = localDateString();

        const fromDateObject = new Date(`${toDate}T00:00:00Z`);
        fromDateObject.setUTCDate(
          fromDateObject.getUTCDate() - 89
        );

        const fromDate = fromDateObject
          .toISOString()
          .slice(0, 10);

        const historicalUrl =
          `https://api.upstox.com/v3/historical-candle/` +
          `${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

        const historicalResult = await upstoxGet(historicalUrl);
        candles = historicalResult.data?.candles || [];
        source = "historical-hourly";

        try {
          const intradayUrl =
            `https://api.upstox.com/v3/historical-candle/intraday/` +
            `${encodedKey}/${unit}/${interval}`;
          const intradayResult = await upstoxGet(intradayUrl);
          const intradayCandles = intradayResult.data?.candles || [];
          if (intradayCandles.length) {
            candles = [...intradayCandles, ...candles];
          }
        } catch (intradayErr) {
          // Ignore intraday error if market closed
        }
      } else {
        const intradayUrl =
          `https://api.upstox.com/v3/historical-candle/intraday/` +
          `${encodedKey}/${unit}/${interval}`;

        try {
          const intradayResult = await upstoxGet(intradayUrl);
          candles = intradayResult.data?.candles || [];
        } catch (error) {
          if (
            Number(error.status) === 429 ||
            Number(error.statusCode) === 429 ||
            /HTTP 429|rate.limit|error 1015/i.test(error.message || "")
          ) {
            throw error;
          }

          console.warn(
            `Intraday candles unavailable for ${instrumentKey}:`,
            error.message
          );
        }

        if (candles.length < 40) {
          const toDate = localDateString();

          const fromDateObject = new Date(`${toDate}T00:00:00Z`);
          fromDateObject.setUTCDate(
            fromDateObject.getUTCDate() - 5
          );

          const fromDate = fromDateObject
            .toISOString()
            .slice(0, 10);

          try {
            const historicalUrl =
              `https://api.upstox.com/v3/historical-candle/` +
              `${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

            const historicalResult = await upstoxGet(historicalUrl);
            const histCandles = historicalResult.data?.candles || [];

            if (histCandles.length) {
              const hadIntraday = candles.length > 0;
              candles = [...candles, ...histCandles];
              source = hadIntraday ? "intraday+historical" : "historical-fallback";
            }
          } catch (histError) {
            if (!candles.length) throw histError;
          }
        }
      }

      const result = {
        success: true,
        instrument_key: instrumentKey,
        unit,
        interval,
        source,
        candles
      };

      if (candles.length > 0) {
        historicalCandleCache.set(cacheKey, {
          time: Date.now(),
          result
        });
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
    const isRateLimited =
      Number(error.status) === 429 ||
      Number(error.statusCode) === 429 ||
      /HTTP 429|rate.limit|error 1015/i.test(error.message || "");

    console.error("Historical candles error:", error.message);

    if (isRateLimited) {
      const remainingSeconds = Math.max(
        1,
        Math.ceil((historicalCooldownUntil - Date.now()) / 1000)
      );

      res.set("Retry-After", String(remainingSeconds));

      return res.status(429).json({
        success: false,
        message: "Upstox historical data is temporarily rate-limited.",
        details: error.message,
        retry_after: remainingSeconds
      });
    }

    return sendError(
      res,
      error,
      "Could not retrieve historical candles."
    );
  }
});

app.get("/api/dashboard/quotes", async (req, res) => {
  try {
    const rows = await getInstrumentRows();
    const baseInstruments = resolveDashboardInstruments(rows);
    const optionInstruments = await resolveDynamicItmOptions(rows, baseInstruments);
    const instruments = { ...baseInstruments, ...optionInstruments };

    const requested = String(
      req.query.symbols || ""
    ).split(",").filter(Boolean);

    const keys = [
      ...new Set(
        requested
          .map(title => instruments[title]?.instrument_key)
          .filter(Boolean)
      )
    ];

    if (!keys.length) {
      return res.json({
        success: true,
        quotes: {},
        instruments
      });
    }

    const url =
      "https://api.upstox.com/v3/market-quote/quotes?instrument_key=" +
      encodeURIComponent(keys.join(","));

    const data = await upstoxGet(url);
    const rawQuotes = data.data || {};
    const quotes = {};

    for (const title of requested) {
      const instrument = instruments[title];
      const key = instrument?.instrument_key;

      if (!key) continue;

      const match = Object.values(rawQuotes).find(quote =>
        quote &&
        (
          quote.instrument_token === key ||
          quote.instrument_key === key
        )
      ) || rawQuotes[key.replace("|", ":")];

      if (match) {
        quotes[title] = {
          last_price: Number(match.last_price),
          net_change: Number(
            match.net_change ?? match.change ?? 0
          ),
          instrument_key: key,
          trading_symbol: instrument.trading_symbol
        };
      }
    }

    res.json({
      success: true,
      quotes,
      instruments
    });
  } catch (error) {
    sendError(res, error, "Could not retrieve dashboard quotes.");
  }
});

app.get("/api/candles", async (req, res) => {
  try {
    const marketMap = {
      NIFTY: "NIFTY SPOT",
      BANKNIFTY: "BANKNIFTY SPOT",
      SENSEX: "SENSEX SPOT"
    };

    const market = String(
      req.query.market || "NIFTY"
    ).toUpperCase();

    if (!marketMap[market]) {
      return res.status(400).json({
        success: false,
        message: "Unsupported market."
      });
    }

    const interval = Number(req.query.interval || 5);

    if (
      !Number.isInteger(interval) ||
      interval < 1 ||
      interval > 300
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid minute interval."
      });
    }

    const rows = await getInstrumentRows();
    const instruments = resolveDashboardInstruments(rows);
    const instrumentKey =
      instruments[marketMap[market]]?.instrument_key;

    if (!instrumentKey) {
      return res.status(404).json({
        success: false,
        message: "Instrument could not be resolved."
      });
    }

    const result = await upstoxGet(
      "https://api.upstox.com/v3/historical-candle/intraday/" +
      encodeURIComponent(instrumentKey) +
      "/minutes/" + interval
    );

    res.json({
      success: true,
      market,
      intervalMinutes: interval,
      data: result
    });
  } catch (error) {
    sendError(res, error, "Could not retrieve historical candles.");
  }
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `TradingDashboard server running at http://127.0.0.1:${PORT}`
  );

  console.log(
    `Upstox token configured: ${Boolean(TOKEN())}`
  );
});