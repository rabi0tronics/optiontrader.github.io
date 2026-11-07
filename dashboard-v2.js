"use strict";

(() => {
  const TZ = "Asia/Kolkata";
  const API = "/api";

  const COLORS = {
    bg: "#ffffff",
    text: "#111827",
    grid: "#e5e7eb",
    border: "#d1d5db",
    green: "#16a34a",
    red: "#dc2626",
    amber: "#b45309"
  };

  const VWAP_COLOR = "#D4A900";

  const EMA_BAND = {
    period: 33,
    hourlyTimeframe: "60",
    adaptiveTimeframe: "chart",
    showHourly: true,
    showHourlyFill: true,
    showAdaptive: true,
    showAdaptiveFill: true,
    hourlyUpperColor: "rgba(0,188,212,0.60)",
    hourlyLowerColor: "rgba(255,87,34,0.60)",
    hourlyFillColor: "rgba(120,144,156,0.08)",
    adaptiveFillColor: "rgba(155,39,176,0.15)",
    hourlyLineWidth: 1,
    adaptiveLineWidth: 1
  };

  const SPOT_CHARTS = {
    "NIFTY SPOT 1H": { base: "NIFTY SPOT", fixedTimeframe: "60", historical: true },
    "BANKNIFTY SPOT 1H": { base: "BANKNIFTY SPOT", fixedTimeframe: "60", historical: true },
    "NIFTY SPOT 15M": { base: "NIFTY SPOT", fixedTimeframe: "15" },
    "BANKNIFTY SPOT 15M": { base: "BANKNIFTY SPOT", fixedTimeframe: "15" },
    "NIFTY FUTURES 15M": { base: "NIFTY FUTURES", fixedTimeframe: "15" },
    "BANKNIFTY FUTURES 15M": { base: "BANKNIFTY FUTURES", fixedTimeframe: "15" },
    "NIFTY SPOT 5M": { base: "NIFTY SPOT", fixedTimeframe: "5" },
    "BANKNIFTY SPOT 5M": { base: "BANKNIFTY SPOT", fixedTimeframe: "5" }
  };

  const TRADABLE_SPOT_OR_COMM = new Set([
    "NIFTY SPOT 5M",
    "BANKNIFTY SPOT 5M",
    "CRUDE OIL",
    "NATURAL GAS",
    "GOLD",
    "SILVER"
  ]);

  const MACRO_CHARTS = new Set([
    "NIFTY SPOT 1H",
    "BANKNIFTY SPOT 1H"
  ]);

  const STOCK_KEYS = {
    RELIANCE: "NSE_EQ|INE002A01018",
    HDFCBANK: "NSE_EQ|INE040A01034",
    ICICIBANK: "NSE_EQ|INE090A01021",
    BHARTIARTL: "NSE_EQ|INE121J01017",
    INFY: "NSE_EQ|INE009A01021",
    TCS: "NSE_EQ|INE467B01029",
    LT: "NSE_EQ|INE018A01030",
    SBIN: "NSE_EQ|INE062A01020",
    AXISBANK: "NSE_EQ|INE238A01034",
    KOTAKBANK: "NSE_EQ|INE237A01036",
    FEDERALBNK: "NSE_EQ|INE171A01029",
    AUBANK: "NSE_EQ|INE949L01017",
    INDUSINDBK: "NSE_EQ|INE095A01012",
    BAJFINANCE: "NSE_EQ|INE296A01032",
    TITAN: "NSE_EQ|INE280A01028",
    HINDUNILVR: "NSE_EQ|INE030A01027",
    TRENT: "NSE_EQ|INE849A01020",
    EICHERMOT: "NSE_EQ|INE066A01021"
  };

  const panels = [...document.querySelectorAll(".panel[data-symbol]")];
  const titleOf = panel => panel?.dataset.symbol || "";
  const TITLES = panels.map(titleOf);

  const charts = new Map();
  const statusEl = document.getElementById("connectionStatus");

  let instruments = {};
  let timeframe = "15";
  let loading = false;
  let loadRequested = false;
  let refreshTimer = null;
  let syncingCrosshair = false;
  let liveSocket = null;
  let liveReconnectTimer = null;
  let liveReconnectDelay = 2000;
  let lastDayOpenRefreshDate = "";

  const historicalCache = new Map();
  const HISTORICAL_CACHE_MS = 10000;

  function ensureSpotOrderButtonsInjected() {
    if (!document.getElementById("tv-spot-order-styles")) {
      const style = document.createElement("style");
      style.id = "tv-spot-order-styles";
      style.textContent = `
        .tv-spot-btn-group {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          margin-right: 4px;
        }
        .tv-spot-order-btn {
          height: 18px;
          padding: 0 5px;
          border-radius: 3px;
          font-family: "Roboto Mono", Inter, sans-serif;
          font-size: 8.5px;
          font-weight: 700;
          line-height: 16px;
          border: 1px solid transparent;
          cursor: pointer;
          user-select: none;
          transition: all 0.1s ease;
        }
        .tv-spot-order-btn:disabled {
          opacity: 0.55;
          cursor: wait;
        }
        .tv-buy-ce {
          background: rgba(0, 135, 90, 0.15);
          color: #00875a;
          border-color: rgba(0, 135, 90, 0.4);
        }
        .tv-buy-ce:hover:not(:disabled) {
          background: #00875a;
          color: #ffffff;
        }
        .tv-buy-pe {
          background: rgba(217, 45, 32, 0.15);
          color: #d92d20;
          border-color: rgba(217, 45, 32, 0.4);
        }
        .tv-buy-pe:hover:not(:disabled) {
          background: #d92d20;
          color: #ffffff;
        }
        .tv-lots-wrap {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          background: #e2e8f0;
          padding: 1px 3px;
          border-radius: 3px;
          font-size: 8.5px;
          color: #475569;
          font-weight: 600;
        }
        .tv-lots-input {
          width: 28px;
          height: 16px;
          padding: 0 2px;
          border: 1px solid #cbd5e1;
          border-radius: 2px;
          background: #ffffff;
          color: #111827;
          font-family: "Roboto Mono", monospace;
          font-size: 9px;
          font-weight: 700;
          text-align: center;
        }
      `;
      document.head.appendChild(style);
    }

    let inputIdx = 0;
    for (const panel of panels) {
      const sym = titleOf(panel);
      const isSpotOrComm = TRADABLE_SPOT_OR_COMM.has(sym);
      const isHeavyweight = Boolean(panel.dataset.stockSymbol);
      if (!isSpotOrComm && !isHeavyweight) continue;

      const actionsEl = panel.querySelector(".panel-actions");
      if (!actionsEl) continue;

      if (!actionsEl.querySelector(".tv-spot-btn-group")) {
        inputIdx++;
        const uniqueId = `lot_input_${inputIdx}`;
        const group = document.createElement("div");
        group.className = "tv-spot-btn-group";

        group.innerHTML = `
          <div class="tv-lots-wrap">
            <label for="${uniqueId}" style="font-size:8px;">Lot</label>
            <input id="${uniqueId}" name="${uniqueId}" class="tv-lots-input" type="number" min="1" max="500" value="1" title="Number of Lots">
          </div>
          <button class="tv-spot-order-btn tv-buy-ce" type="button" data-option-type="CE" title="Buy ITM Call Option">BUY CE</button>
          <button class="tv-spot-order-btn tv-buy-pe" type="button" data-option-type="PE" title="Buy ITM Put Option">BUY PE</button>
        `;

        actionsEl.insertBefore(group, actionsEl.firstChild);
      }
    }
  }

  ensureSpotOrderButtonsInjected();

  function setStatus(text, color = COLORS.text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = color;
  }

  function getPanel(title) {
    return panels.find(panel => titleOf(panel) === title);
  }

  function isPanelVisible(panel) {
    return Boolean(
      panel &&
      !panel.classList.contains("hidden") &&
      panel.getClientRects().length
    );
  }

  function visibleChartTitles() {
    return TITLES.filter(title => isPanelVisible(getPanel(title)));
  }

  function chartTimeframeFor(title, selectedTimeframe) {
    if (MACRO_CHARTS.has(title)) return "60";
    const config = SPOT_CHARTS[title];
    if (config?.fixedTimeframe) return config.fixedTimeframe;
    return String(selectedTimeframe);
  }

  function requestIsCurrent(title, requestedTimeframe) {
    return String(requestedTimeframe) === chartTimeframeFor(title, timeframe);
  }

  function getInstrument(title) {
    const stock = getPanel(title)?.dataset.stockSymbol;
    if (stock) {
      const mapped = instruments[title] || instruments[stock] || instruments[`${stock} SPOT`];
      if (mapped?.instrument_key) return mapped;
      if (STOCK_KEYS[stock]) {
        return {
          instrument_key: STOCK_KEYS[stock],
          trading_symbol: stock,
          symbol: stock,
          lot_size: 1
        };
      }
    }

    const config = SPOT_CHARTS[title];
    if (config) {
      return instruments[config.base] || instruments[title] || null;
    }

    return instruments[title] || null;
  }

  function getVwapSourceTitle(title) {
    const normalized = String(title).toUpperCase();
    if (normalized.includes("BANK") && normalized.includes("NIFTY")) return "BANKNIFTY FUTURES";
    if (normalized.includes("SENSEX")) return "SENSEX FUTURES";
    if (normalized.includes("NIFTY")) return "NIFTY FUTURES";
    return title;
  }

  function isIndexSpotChart(title) {
    const upper = String(title).toUpperCase();
    return upper.includes("SPOT") && (upper.includes("NIFTY") || upper.includes("SENSEX"));
  }

  function mergeSpotPriceWithFuturesVolume(spotCandles, futuresCandles) {
    const volByTime = new Map(
      (futuresCandles || []).map(c => [c.time, Number(c.volume) || 0])
    );
    return spotCandles.map(c => ({
      ...c,
      volume: volByTime.get(c.time) || 0
    }));
  }

  function dateKey(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);

    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function istParts(date, options) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...options }).formatToParts(date);
  }

  function timeLabel(time) {
    if (typeof time === "number") {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).format(new Date(time * 1000));
    }

    if (time && typeof time === "object" && Number.isInteger(time.year)) {
      const date = new Date(Date.UTC(time.year, time.month - 1, time.day, 12));
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        day: "2-digit",
        month: "short",
        year: "numeric"
      }).format(date);
    }
    return "";
  }

  function normalize(raw) {
    const byTime = new Map();
    const items = Array.isArray(raw) ? [...raw].reverse() : [];
    for (const candle of items) {
      if (!Array.isArray(candle) || candle.length < 5) continue;
      const rawTime = candle[0];
      let ms;
      if (typeof rawTime === "number") {
        ms = rawTime < 1e12 ? rawTime * 1000 : rawTime;
      } else {
        const value = String(rawTime).trim();
        const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
        const hasDateAndTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value);
        const normalizedValue = !hasTimezone && hasDateAndTime ? value.replace(" ", "T") + "+05:30" : value;
        ms = Date.parse(normalizedValue);
      }
      if (!Number.isFinite(ms)) continue;

      const rawVolume = Number(candle[5]);
      const row = {
        time: Math.floor(ms / 1000),
        open: Number(candle[1]),
        high: Number(candle[2]),
        low: Number(candle[3]),
        close: Number(candle[4]),
        volume: Number.isFinite(rawVolume) && rawVolume >= 0 ? rawVolume : 0
      };

      if (
        [row.open, row.high, row.low, row.close].every(Number.isFinite) &&
        row.high >= row.low && row.high >= row.open && row.high >= row.close &&
        row.low <= row.open && row.low <= row.close
      ) {
        byTime.set(row.time, row);
      }
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  function calculateSessionVwap(candles, requestedTimeframe) {
    if (String(requestedTimeframe) === "1D" || !candles.length) return [];
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const latestDate = dateKey(new Date(sorted[sorted.length - 1].time * 1000));
    const sessionCandles = sorted.filter(c => dateKey(new Date(c.time * 1000)) === latestDate);

    let cumulativePV = 0;
    let cumulativeVolume = 0;
    const result = [];

    for (const candle of sessionCandles) {
      const volume = Number(candle.volume);
      if (!Number.isFinite(volume) || volume <= 0) continue;
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativePV += typicalPrice * volume;
      cumulativeVolume += volume;
      result.push({ time: candle.time, value: cumulativePV / cumulativeVolume });
    }
    return result;
  }

  function calculateEmaValues(candles, period = 33) {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const alpha = 2 / (period + 1);
    let emaHigh = null;
    let emaLow = null;
    const result = [];

    for (const candle of sorted) {
      emaHigh = emaHigh === null ? candle.high : candle.high * alpha + emaHigh * (1 - alpha);
      emaLow = emaLow === null ? candle.low : candle.low * alpha + emaLow * (1 - alpha);
      result.push({ time: candle.time, high: emaHigh, low: emaLow });
    }
    return result;
  }

  function latestSessionOnly(candles) {
    if (!candles.length) return [];
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const latestDate = dateKey(new Date(sorted[sorted.length - 1].time * 1000));
    return sorted.filter(c => dateKey(new Date(c.time * 1000)) === latestDate);
  }

  function mapHourlyEmaToChart(chartCandles, hourlyEma) {
    const sortedEma = [...hourlyEma].sort((a, b) => a.time - b.time);
    const result = [];
    let index = 0;
    let current = null;

    for (const candle of chartCandles) {
      while (index < sortedEma.length && sortedEma[index].time + 3600 <= candle.time) {
        current = sortedEma[index];
        index++;
      }
      if (current && dateKey(new Date(current.time * 1000)) === dateKey(new Date(candle.time * 1000))) {
        result.push({ time: candle.time, upper: current.high, lower: current.low });
      }
    }
    return result;
  }

  function createBandCanvas(area) {
    const canvas = document.createElement("canvas");
    canvas.className = "ema-band-fill";
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;";
    area.appendChild(canvas);
    return canvas;
  }

  function drawBandPolygon(ctx, chart, points, upperKey, lowerKey, fill) {
    if (!points || points.length < 2) return;
    const timeScale = chart.timeScale();
    const entry = [...charts.values()].find(item => item.chart === chart);
    const priceSeries = entry?.series;
    if (!priceSeries) return;

    const upperCoords = [];
    const lowerCoords = [];

    for (const point of points) {
      const x = timeScale.timeToCoordinate(point.time);
      const yUpper = priceSeries.priceToCoordinate(point[upperKey]);
      const yLower = priceSeries.priceToCoordinate(point[lowerKey]);
      if (x == null || yUpper == null || yLower == null || ![x, yUpper, yLower].every(Number.isFinite)) continue;
      upperCoords.push({ x, y: yUpper });
      lowerCoords.push({ x, y: yLower });
    }

    if (upperCoords.length < 2 || lowerCoords.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(upperCoords[0].x, upperCoords[0].y);
    for (let i = 1; i < upperCoords.length; i++) ctx.lineTo(upperCoords[i].x, upperCoords[i].y);
    for (let i = lowerCoords.length - 1; i >= 0; i--) ctx.lineTo(lowerCoords[i].x, lowerCoords[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function renderEmaBandFill(entry) {
    if (!entry?.emaBandCanvas || !entry.chart || !entry.area) return;
    const canvas = entry.emaBandCanvas;
    const area = entry.area;
    const chart = entry.chart;

    if (!entry.emaBandRedrawAttached) {
      entry.emaBandRedrawAttached = true;
      let redrawFrame = 0;
      const scheduleRedraw = () => {
        if (redrawFrame) return;
        redrawFrame = requestAnimationFrame(() => {
          redrawFrame = 0;
          renderEmaBandFill(entry);
        });
      };
      entry.emaScheduleRedraw = scheduleRedraw;
      chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleRedraw);
      chart.timeScale().subscribeVisibleTimeRangeChange(scheduleRedraw);
      area.addEventListener("pointermove", scheduleRedraw, { passive: true });
      area.addEventListener("wheel", scheduleRedraw, { passive: true });
      window.addEventListener("resize", scheduleRedraw);
    }

    const width = area.clientWidth;
    const height = area.clientHeight;
    if (!width || !height) return;

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (EMA_BAND.showHourly && EMA_BAND.showHourlyFill) {
      drawBandPolygon(ctx, chart, entry.hourlyBandPoints, "upper", "lower", EMA_BAND.hourlyFillColor);
    }
    if (EMA_BAND.showAdaptive && EMA_BAND.showAdaptiveFill) {
      drawBandPolygon(ctx, chart, entry.adaptiveBandPoints, "upper", "lower", EMA_BAND.adaptiveFillColor);
    }
  }

  function rsi(data, period = 14) {
    if (data.length <= period) return NaN;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = data[i].close - data[i - 1].close;
      if (change >= 0) gains += change; else losses -= change;
    }
    gains /= period; losses /= period;
    for (let i = period + 1; i < data.length; i++) {
      const change = data[i].close - data[i - 1].close;
      gains = (gains * (period - 1) + Math.max(change, 0)) / period;
      losses = (losses * (period - 1) + Math.max(-change, 0)) / period;
    }
    return losses === 0 ? 100 : 100 - (100 / (1 + gains / losses));
  }

  function di(data, period = 14) {
    if (data.length <= period) return { plus: NaN, minus: NaN };
    const values = [];
    for (let i = 1; i < data.length; i++) {
      const curr = data[i], prev = data[i - 1];
      const up = curr.high - prev.high;
      const down = prev.low - curr.low;
      values.push({
        tr: Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)),
        plus: up > down && up > 0 ? up : 0,
        minus: down > up && down > 0 ? down : 0
      });
    }
    let tr = 0, plus = 0, minus = 0;
    for (let i = 0; i < period; i++) {
      tr += values[i].tr; plus += values[i].plus; minus += values[i].minus;
    }
    for (let i = period; i < values.length; i++) {
      tr = tr - tr / period + values[i].tr;
      plus = plus - plus / period + values[i].plus;
      minus = minus - minus / period + values[i].minus;
    }
    return tr > 0 ? { plus: (plus / tr) * 100, minus: (minus / tr) * 100 } : { plus: 0, minus: 0 };
  }

  function sentiment(rv, plus, minus) {
    if (![rv, plus, minus].every(Number.isFinite)) return "—";
    if (rv > 55 && plus > 25 && plus > minus) return "BULLISH";
    if (rv < 45 && minus > 25 && minus > plus) return "BEARISH";
    return "NEUTRAL";
  }

  function updateFooter(panel, rv, plus, minus, label) {
    const spans = panel.querySelectorAll(".chart-foot span");
    if (spans[0]) spans[0].textContent = `RSI ${Number.isFinite(rv) ? rv.toFixed(1) : "—"}`;
    if (spans[1]) spans[1].textContent = `DI+ ${Number.isFinite(plus) ? plus.toFixed(1) : "—"} / DI− ${Number.isFinite(minus) ? minus.toFixed(1) : "—"}`;
    if (spans[2]) spans[2].textContent = `Sentiment ${label}`;
  }

  function formatPrice(value) {
    return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const SQR_LEVEL_CONFIG = [
    { key: "open", color: "#001aff", width: 2 },
    { key: "bat", color: "#32a300", width: 4 },
    { key: "sat", color: "#be0000", width: 4 },
    { key: "urev", color: "#006ee6", width: 2 },
    { key: "lrev", color: "#006ee6", width: 2 }
  ];

  function calculateSqrLevels(dayOpen) {
    if (!Number.isFinite(dayOpen) || dayOpen <= 0) return null;
    const root = Math.sqrt(dayOpen);
    return {
      open: dayOpen,
      bat: (root + 0.236) * (root + 0.164),
      urev: (root + 1) * (root + 0.500),
      sat: (root - 0.236) * (root - 0.164),
      lrev: (root - 1) * (root - 0.500)
    };
  }

  function removeSqrOverlay(entry) {
    if (entry?.sqrOverlay) { entry.sqrOverlay.remove(); entry.sqrOverlay = null; }
  }

  function attachSqrLevels(entry, allCandles, requestedTimeframe) {
    if (String(requestedTimeframe) === "1D" || !allCandles.length) return;
    const latestSession = latestDateInCandles(allCandles);
    if (!latestSession) return;

    const sessionCandles = allCandles.filter(c => dateKey(new Date(c.time * 1000)) === latestSession).sort((a, b) => a.time - b.time);
    if (!sessionCandles.length) return;

    const first = sessionCandles[0];
    const last = sessionCandles[sessionCandles.length - 1];
    const levels = calculateSqrLevels(first.open);
    if (!levels) return;

    entry.sqrStartTime = first.time;
    entry.sqrLevels = levels;
    entry.sqrLineSeries = {};

    for (const config of SQR_LEVEL_CONFIG) {
      const lineSeries = entry.chart.addSeries(LightweightCharts.LineSeries, {
        color: config.color,
        lineWidth: config.width,
        lineStyle: LightweightCharts.LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        pointMarkersVisible: false,
        autoscaleInfoProvider: () => null
      });

      lineSeries.setData(first.time !== last.time ? [
        { time: first.time, value: levels[config.key] },
        { time: last.time, value: levels[config.key] }
      ] : [{ time: first.time, value: levels[config.key] }]);

      entry.sqrLineSeries[config.key] = lineSeries;
    }
    entry.sqrLastLineTime = last.time;
  }

  function updateSqrLevels(entry) {
    if (!entry?.sqrLevels || !entry.sqrLineSeries) return;
    const times = [...entry.candleByTime.keys()];
    const lastTime = times.length ? Math.max(...times) : NaN;

    if (Number.isFinite(lastTime) && lastTime !== entry.sqrLastLineTime) {
      for (const config of SQR_LEVEL_CONFIG) {
        const lineSeries = entry.sqrLineSeries[config.key];
        if (lineSeries) {
          lineSeries.setData([
            { time: entry.sqrStartTime, value: entry.sqrLevels[config.key] },
            { time: lastTime, value: entry.sqrLevels[config.key] }
          ]);
        }
      }
      entry.sqrLastLineTime = lastTime;
    }
  }

  function destroyChart(panel) {
    const entry = charts.get(panel);
    if (!entry) return;
    removeSqrOverlay(entry);
    if (entry.emaScheduleRedraw) {
      window.removeEventListener("resize", entry.emaScheduleRedraw);
      entry.chart.timeScale().unsubscribeVisibleLogicalRangeChange(entry.emaScheduleRedraw);
    }
    entry.observer?.disconnect();
    entry.chart?.remove();
    charts.delete(panel);
  }

  function makeChart(area) {
    return LightweightCharts.createChart(area, {
      width: area.clientWidth,
      height: area.clientHeight,
      layout: { background: { type: "solid", color: COLORS.bg }, textColor: COLORS.text, fontFamily: "Inter, Arial, sans-serif", fontSize: 10, attributionLogo: false },
      localization: { timeFormatter: time => timeLabel(time) },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 8, minBarSpacing: 2, tickMarkFormatter: time => timeLabel(time) },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    });
  }

  function timeframeParams(tf) {
    if (tf === "30") return { unit: "minutes", interval: 30 };
    if (tf === "60") return { unit: "hours", interval: 1 };
    if (tf === "240") return { unit: "hours", interval: 4 };
    if (tf === "1D") return { unit: "days", interval: 1 };
    return { unit: "minutes", interval: Number(tf) || 15 };
  }

  function latestDateInCandles(candles) {
    if (!candles.length) return null;
    return dateKey(new Date(candles[candles.length - 1].time * 1000));
  }

  function filterCandlesForChart(title, candles, requestedTimeframe) {
    if (!candles.length) return [];
    if (MACRO_CHARTS.has(title)) return candles;
    if (requestedTimeframe === "1D") return candles;

    const latestDate = latestDateInCandles(candles);
    return latestDate
      ? candles.filter(
          candle => dateKey(new Date(candle.time * 1000)) === latestDate
        )
      : candles;
  }

  async function fetchHistoricalCandles(instrument, requestedTimeframe) {
    if (!instrument?.instrument_key) throw new Error("Missing instrument key.");
    const { unit, interval } = timeframeParams(requestedTimeframe);
    const params = new URLSearchParams({ instrument_key: instrument.instrument_key, unit, interval: String(interval) });
    const cacheKey = `${instrument.instrument_key}|${unit}|${interval}`;

    const cached = historicalCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < HISTORICAL_CACHE_MS) return cached.candles;

    const response = await fetch(`${API}/historical-candles?${params.toString()}`, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.success || !Array.isArray(result.candles)) {
      throw new Error(result.message || `Historical candles HTTP ${response.status}`);
    }

    const candles = normalize(result.candles);
    historicalCache.set(cacheKey, { timestamp: Date.now(), candles });
    return candles;
  }

  function addCrosshairSync(panel, entry) {
    entry.chart.subscribeCrosshairMove(param => {
      if (syncingCrosshair) return;
      syncingCrosshair = true;
      try {
        for (const [otherPanel, otherEntry] of charts) {
          if (otherPanel === panel || /INDIA VIX/i.test(otherEntry.title)) continue;
          if (!param?.time || !param.point) { otherEntry.chart.clearCrosshairPosition(); continue; }
          const candle = otherEntry.candleByTime.get(param.time);
          if (candle) { otherEntry.chart.setCrosshairPosition(candle.close, param.time, otherEntry.series); }
          else { otherEntry.chart.clearCrosshairPosition(); }
        }
      } catch (e) {
        console.warn("Crosshair sync error:", e.message);
      } finally {
        syncingCrosshair = false;
      }
    });
  }

  function liveCandleTime(timestampMs, entry) {
    const seconds = Math.floor(timestampMs / 1000);
    const today = dateKey(new Date(seconds * 1000));
    const candles = [...entry.candleByTime.values()].sort((a, b) => a.time - b.time);
    const sameDay = candles.filter(c => dateKey(new Date(c.time * 1000)) === today);

    if (entry.timeframe === "1D") return sameDay[0]?.time ?? istSessionStart(seconds, true);

    const commodity = /CRUDE OIL|NATURAL GAS|GOLD|SILVER|US OIL/i.test(entry.title);
    const start = istSessionStart(seconds, false, commodity ? 9 : 9.25);
    const end = istSessionStart(seconds, false, commodity ? 23.9167 : 15.5);

    const tfNum = String(entry.timeframe);
    const minutes = {
      "5": 5,
      "15": 15,
      "30": 30,
      "60": 60,
      "240": 240
    }[tfNum] || 15;

    if (seconds < start || seconds > end) {
      return null;
    }

    const bucketSeconds = minutes * 60;
    let calculatedTime = start + Math.floor((seconds - start) / bucketSeconds) * bucketSeconds;

    if (!commodity && calculatedTime >= end) {
      calculatedTime = end - bucketSeconds;
    }

    return calculatedTime;
  }

  function istSessionStart(timestampSeconds, daily, startHour = 9.25) {
    const parts = istParts(new Date(timestampSeconds * 1000), { year: "numeric", month: "2-digit", day: "2-digit" });
    const get = type => Number(parts.find(part => part.type === type)?.value);
    const year = get("year"), month = get("month"), day = get("day");
    const hour = daily ? 0 : Math.floor(startHour);
    const minute = daily ? 0 : Math.round((startHour - hour) * 60);
    return Date.UTC(year, month - 1, day, hour - 5, minute - 30) / 1000;
  }

  function buildBandPoints(chartCandles, hourlyCandles) {
    const chartToday = latestSessionOnly(chartCandles);
    if (!chartToday.length) return { hourly: [], adaptive: [] };

    const hourlyEma = calculateEmaValues(hourlyCandles, EMA_BAND.period);
    const hourlyPoints = EMA_BAND.showHourly ? mapHourlyEmaToChart(chartToday, hourlyEma) : [];
    const adaptiveEma = calculateEmaValues(chartCandles, EMA_BAND.period);
    const adaptiveMap = new Map(adaptiveEma.map(item => [item.time, item]));

    const adaptivePoints = EMA_BAND.showAdaptive ? chartToday.map(candle => {
      const source = adaptiveMap.get(candle.time);
      if (!source) return null;
      return { time: candle.time, upper: source.high, lower: source.low };
    }).filter(Boolean) : [];

    return { hourly: hourlyPoints, adaptive: adaptivePoints };
  }

  function addEmaBandSeries(entry) {
    entry.emaBandCanvas = createBandCanvas(entry.area);
    if (EMA_BAND.showHourly) {
      entry.hourlyUpperSeries = entry.chart.addSeries(LightweightCharts.LineSeries, { color: EMA_BAND.hourlyUpperColor, lineWidth: EMA_BAND.hourlyLineWidth, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: false, autoscaleInfoProvider: () => null });
      entry.hourlyLowerSeries = entry.chart.addSeries(LightweightCharts.LineSeries, { color: EMA_BAND.hourlyLowerColor, lineWidth: EMA_BAND.hourlyLineWidth, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: false, autoscaleInfoProvider: () => null });
    }
  }

  function applyEmaBandData(entry, chartCandles, hourlyCandles) {
    const points = buildBandPoints(chartCandles, hourlyCandles);
    entry.hourlyBandPoints = points.hourly;
    entry.adaptiveBandPoints = points.adaptive;

    if (entry.hourlyUpperSeries) {
      entry.hourlyUpperSeries.setData(points.hourly.map(p => ({ time: p.time, value: p.upper })));
      entry.hourlyLowerSeries.setData(points.hourly.map(p => ({ time: p.time, value: p.lower })));
    }
    renderEmaBandFill(entry);
  }

  function drawVwap(entry) {
    if (!entry?.vwapSeries) return;
    const candles = [...entry.vwapCandleByTime.values()].sort((a, b) => a.time - b.time);
    const data = calculateSessionVwap(candles, entry.timeframe);
    entry.vwapSeries.setData(data);
  }

  function applyVolumeWeightedBarColors(entry, displayCandles, allCandlesWithVolume) {
    if (!entry || !Array.isArray(displayCandles) || !displayCandles.length) return;
    const sourceCandles = Array.isArray(allCandlesWithVolume) && allCandlesWithVolume.length ? allCandlesWithVolume : displayCandles;
    const length = 20;
    const weightedDenominator = length * (length + 1) / 2;
    const volumeValues = sourceCandles.map(c => Number(c.volume) || 0);
    const colorByTime = new Map();

    for (let i = 0; i < sourceCandles.length; i++) {
      if (i < length - 1) continue;
      let weightedSum = 0;
      for (let j = 0; j < length; j++) weightedSum += volumeValues[i - length + 1 + j] * (j + 1);
      const wma = weightedSum / weightedDenominator;
      const candle = sourceCandles[i], volume = volumeValues[i];
      const bullish = candle.close > candle.open, bearish = candle.open > candle.close;
      const signalColor = wma > 0 && volume > wma ? (bullish ? "#000dff" : bearish ? "#7e0c0c" : null) : null;
      if (signalColor) colorByTime.set(candle.time, signalColor);
    }

    const coloredCandles = displayCandles.map(candle => {
      const next = { ...candle };
      delete next.color; delete next.borderColor; delete next.wickColor;
      const signalColor = colorByTime.get(candle.time);
      if (signalColor) { next.color = signalColor; next.borderColor = signalColor; next.wickColor = signalColor; }
      return next;
    });

    entry.volumeColorByTime = colorByTime;
    entry.series.setData(coloredCandles);
    for (const c of coloredCandles) entry.candleByTime.set(c.time, { ...c });
  }

  async function loadInstrument(title, requestedTimeframe) {
    if (!requestIsCurrent(title, requestedTimeframe)) return;
    const panel = getPanel(title);
    if (!panel) return;

    ensureSpotOrderButtonsInjected();

    if (title.startsWith("SLOT") || title.includes("PLACEHOLDER") || title.includes("NEWS") || title.startsWith("COMMODITY SLOT")) {
      const area = panel.querySelector(".chart-area");
      if (area) {
        area.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:10px;">Placeholder Ready for Custom Addition</div>`;
      }
      return;
    }

    const instrument = getInstrument(title);
    if (!instrument?.instrument_key) {
      showPanelMessage(panel, `No active contract found for ${title}.`);
      return;
    }

    const titleEl = panel.querySelector(".panel-title");
    if (titleEl && instrument.display_title) {
      titleEl.textContent = instrument.display_title;
      titleEl.title = `${instrument.trading_symbol || instrument.display_title} | Lot Size: ${instrument.lot_size || 1}`;
    }

    const lotsInput = panel.querySelector(".tv-lots-input");
    if (lotsInput && instrument.lot_size) {
      lotsInput.title = `Lots (1 Lot = ${instrument.lot_size} Qty)`;
    }

    try {
      const allCandlesRaw = await fetchHistoricalCandles(instrument, requestedTimeframe);
      if (!requestIsCurrent(title, requestedTimeframe)) return;

      const pairedSpot = isIndexSpotChart(title);
      const vwapSourceTitle = getVwapSourceTitle(title);
      const vwapInstrument = pairedSpot ? instruments[vwapSourceTitle] : instrument;
      let futuresCandlesRaw = [];

      if (pairedSpot && vwapInstrument?.instrument_key) {
        try {
          futuresCandlesRaw = await fetchHistoricalCandles(vwapInstrument, requestedTimeframe);
        } catch (e) { console.warn("Futures volume source error:", e.message); }
      }

      if (!requestIsCurrent(title, requestedTimeframe)) return;

      const allCandles = pairedSpot ? mergeSpotPriceWithFuturesVolume(allCandlesRaw, futuresCandlesRaw) : allCandlesRaw;
      const candles = filterCandlesForChart(title, allCandles, requestedTimeframe);
      if (!candles.length) throw new Error("No candles returned.");

      let hourlyCandles = [];
      if (requestedTimeframe !== "1D") {
        try {
          hourlyCandles = await fetchHistoricalCandles(instrument, EMA_BAND.hourlyTimeframe);
        } catch (e) { console.warn("Hourly EMA error:", e.message); }
      }

      if (!requestIsCurrent(title, requestedTimeframe)) return;

      destroyChart(panel);
      const area = panel.querySelector(".chart-area");
      if (!area) return;
      area.replaceChildren();
      area.style.position = "relative";

      const chart = makeChart(area);
      const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: COLORS.green, downColor: COLORS.red, borderUpColor: COLORS.green, borderDownColor: COLORS.red, wickUpColor: COLORS.green, wickDownColor: COLORS.red, priceLineVisible: true, lastValueVisible: true
      });

      series.setData(candles);

      const vwapCandleByTime = new Map(candles.map(c => [c.time, { ...c }]));
      const vwapData = calculateSessionVwap(candles, requestedTimeframe);
      let vwapSeries = null;

      if (vwapData.length) {
        vwapSeries = chart.addSeries(LightweightCharts.LineSeries, {
          color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: false, autoscaleInfoProvider: () => null
        });
        vwapSeries.setData(vwapData);
      }

      const candleByTime = new Map(candles.map(c => [c.time, { ...c }]));

      const countdownEl = document.createElement("div");
      countdownEl.className = "candle-countdown";
      countdownEl.style.cssText = "position:absolute;right:4px;z-index:6;pointer-events:none;font:600 9px 'Roboto Mono',monospace;color:#ffffff;background:#000000;padding:1px 4px;border-radius:3px;visibility:hidden;";
      area.appendChild(countdownEl);

      const entry = {
        title, panel, instrumentKey: instrument.instrument_key, timeframe: String(requestedTimeframe),
        chart, series, vwapSeries, vwapSourceTitle: pairedSpot ? vwapSourceTitle : title,
        vwapSourceInstrumentKey: vwapInstrument?.instrument_key || "", vwapCandleByTime,
        area, candleByTime, countdownEl, observer: null, sqrOverlay: null, sqrLineSeries: null, sqrLevels: null,
        emaBandCanvas: null, emaScheduleRedraw: null, hourlyBandPoints: [], adaptiveBandPoints: []
      };

      charts.set(panel, entry);
      applyVolumeWeightedBarColors(entry, candles, allCandles);

      chart.timeScale().applyOptions({ rightOffset: 2, barSpacing: 5, minBarSpacing: 1 });

      if (MACRO_CHARTS.has(title) && candles.length > 0) {
        const lastTime = candles[candles.length - 1].time;
        chart.timeScale().setVisibleRange({
          from: lastTime - (5 * 24 * 3600),
          to: lastTime + (2 * 3600)
        });
      } else {
        chart.timeScale().fitContent();
      }

      addEmaBandSeries(entry);
      applyEmaBandData(entry, allCandles, hourlyCandles);
      addCrosshairSync(panel, entry);

      entry.observer = new ResizeObserver(() => {
        if (!area.clientWidth || !area.clientHeight) return;
        chart.applyOptions({ width: area.clientWidth, height: area.clientHeight });

        if (MACRO_CHARTS.has(title) && candles.length > 0) {
          const lastTime = candles[candles.length - 1].time;
          chart.timeScale().setVisibleRange({
            from: lastTime - (5 * 24 * 3600),
            to: lastTime + (2 * 3600)
          });
        } else {
          chart.timeScale().fitContent();
        }

        renderEmaBandFill(entry);
      });
      entry.observer.observe(area);

      const last = candles[candles.length - 1];
      const priceEl = panel.querySelector(".price");
      if (priceEl) priceEl.textContent = formatPrice(last.close);

      const rv = rsi(allCandles);
      const directions = di(allCandles);
      updateFooter(panel, rv, directions.plus, directions.minus, sentiment(rv, directions.plus, directions.minus));

      attachSqrLevels(entry, allCandles, requestedTimeframe);
    } catch (error) {
      if (!requestIsCurrent(title, requestedTimeframe)) return;
      showPanelMessage(panel, `${title}: ${error.message}`, COLORS.amber);
      const priceEl = panel.querySelector(".price");
      if (priceEl) priceEl.textContent = "—";
      updateFooter(panel, NaN, NaN, NaN, "UNAVAILABLE");
      console.warn(`${title} chart error:`, error);
    }
  }

  function showPanelMessage(panel, text, color = COLORS.text) {
    destroyChart(panel);
    const area = panel.querySelector(".chart-area");
    if (!area) return;
    area.replaceChildren();
    const msg = document.createElement("div");
    msg.textContent = text;
    msg.style.cssText = `height:100%;display:flex;align-items:center;justify-content:center;padding:10px;text-align:center;font-size:10px;color:${color};`;
    area.appendChild(msg);
  }

  function resizeCharts() {
    requestAnimationFrame(() => {
      for (const [panel, entry] of charts) {
        if (panel.classList.contains("hidden")) continue;
        const area = panel.querySelector(".chart-area");
        if (area?.clientWidth && area?.clientHeight) {
          entry.chart.applyOptions({ width: area.clientWidth, height: area.clientHeight });
          
          if (MACRO_CHARTS.has(entry.title) && entry.candleByTime.size > 0) {
            const times = [...entry.candleByTime.keys()];
            const lastTime = Math.max(...times);
            entry.chart.timeScale().setVisibleRange({
              from: lastTime - (5 * 24 * 3600),
              to: lastTime + (2 * 3600)
            });
          } else {
            entry.chart.timeScale().fitContent();
          }

          renderEmaBandFill(entry);
        }
      }
    });
  }

  function handleLiveTick(message) {
    const key = String(
      message.instrument_key ||
      message.instrumentKey ||
      message.key ||
      ""
    );

    const price = Number(
      message.last_price ??
      message.lastPrice ??
      message.ltp ??
      message.price
    );

    if (!key || !Number.isFinite(price)) return;

    const tradeQuantity = Number(
      message.last_trade_quantity ??
      message.lastTradeQuantity ??
      message.ltq ??
      0
    );

    let ms = Number(
      message.exchange_timestamp ??
      message.last_trade_time ??
      message.timestamp ??
      Date.now()
    );

    if (!Number.isFinite(ms) || ms <= 0) ms = Date.now();
    if (ms < 1e12) ms *= 1000;

    for (const [panel, entry] of charts) {
      try {
        const isPairedSpot = entry.instrumentKey !== entry.vwapSourceInstrumentKey;

        if (entry.instrumentKey === key) {
          const priceEl = panel.querySelector(".price");
          if (priceEl) priceEl.textContent = formatPrice(price);

          let time = liveCandleTime(ms, entry);
          if (!Number.isFinite(time)) continue;

          const times = [...entry.candleByTime.keys()];
          const lastTime = times.length ? Math.max(...times) : null;
          if (lastTime !== null && time < lastTime) {
            continue;
          }

          const old = entry.candleByTime.get(time);

          const candle = old
            ? {
                time,
                open: old.open,
                high: Math.max(old.high, price),
                low: Math.min(old.low, price),
                close: price,
                volume: (Number(old.volume) || 0) + Math.max(0, Number(tradeQuantity) || 0)
              }
            : {
                time,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: Math.max(0, Number(tradeQuantity) || 0)
              };

          const volumeColor = entry.volumeColorByTime?.get(candle.time);
          const displayCandle = { ...candle };
          delete displayCandle.color;
          delete displayCandle.borderColor;
          delete displayCandle.wickColor;
          if (volumeColor) {
            displayCandle.color = volumeColor;
            displayCandle.borderColor = volumeColor;
            displayCandle.wickColor = volumeColor;
          }

          entry.series.update(displayCandle);
          entry.candleByTime.set(time, displayCandle);
          updateSqrLevels(entry);

          if (isPairedSpot) {
            const existingVwapCandle = entry.vwapCandleByTime.get(time);
            entry.vwapCandleByTime.set(time, {
              time,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: existingVwapCandle ? existingVwapCandle.volume : 0
            });
            if (entry.vwapSeries) drawVwap(entry);
          }
        }

        if (
          entry.vwapSourceInstrumentKey &&
          entry.vwapSourceInstrumentKey === key
        ) {
          if (isPairedSpot) {
            let time = liveCandleTime(ms, {
              title: entry.title,
              timeframe: entry.timeframe,
              candleByTime: entry.vwapCandleByTime
            });

            const times = [...entry.vwapCandleByTime.keys()];
            const lastTime = times.length ? Math.max(...times) : null;
            if (lastTime !== null && time !== null && time < lastTime) {
              continue;
            }

            if (Number.isFinite(time)) {
              const spotCandle = entry.candleByTime.get(time);
              const existing = entry.vwapCandleByTime.get(time);
              const basePrice = spotCandle ? spotCandle.close : (existing ? existing.close : price);

              entry.vwapCandleByTime.set(time, {
                time,
                open: spotCandle ? spotCandle.open : (existing ? existing.open : price),
                high: spotCandle ? spotCandle.high : (existing ? Math.max(existing.high, price) : price),
                low: spotCandle ? spotCandle.low : (existing ? Math.min(existing.low, price) : price),
                close: basePrice,
                volume: (Number(existing?.volume) || 0) + Math.max(0, Number(tradeQuantity) || 0)
              });
              if (entry.vwapSeries) drawVwap(entry);
            }
          } else {
            let time = liveCandleTime(ms, {
              title: entry.vwapSourceTitle,
              timeframe: entry.timeframe,
              candleByTime: entry.vwapCandleByTime
            });

            const times = [...entry.vwapCandleByTime.keys()];
            const lastTime = times.length ? Math.max(...times) : null;
            if (lastTime !== null && time !== null && time < lastTime) {
              continue;
            }

            if (Number.isFinite(time)) {
              const old = entry.vwapCandleByTime.get(time);
              const candle = old
                ? {
                    time,
                    open: old.open,
                    high: Math.max(old.high, price),
                    low: Math.min(old.low, price),
                    close: price,
                    volume: (Number(old.volume) || 0) + Math.max(0, Number(tradeQuantity) || 0)
                  }
                : {
                    time,
                    open: price, high: price, low: price, close: price,
                    volume: Math.max(0, Number(tradeQuantity) || 0)
                  };

              entry.vwapCandleByTime.set(time, candle);
              if (entry.vwapSeries) drawVwap(entry);
            }
          }
        }

        if (entry.emaBandCanvas) renderEmaBandFill(entry);
      } catch (error) {
        console.warn(
          `Live candle/VWAP update failed for ${entry.title}:`,
          error
        );
      }
    }
  }

  function updateCandleCountdowns() {
    const now = Math.floor(Date.now() / 1000);

    const intervals = {
      "5": 300,
      "15": 900,
      "30": 1800,
      "60": 3600,
      "240": 14400
    };

    const nowDate = new Date(now * 1000);
    const todayStr = dateKey(nowDate);
    const parts = istParts(nowDate, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });

    const get = type => parts.find(part => part.type === type)?.value;
    const mins = Number(get("hour")) * 60 + Number(get("minute"));
    const secs = Number(get("second"));

    const isTradingDay = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(
      get("weekday")
    );

    if (isTradingDay && mins === 555 && secs >= 5 && lastDayOpenRefreshDate !== todayStr) {
      lastDayOpenRefreshDate = todayStr;
      historicalCache.clear();
      loadDashboard(true);
    }

    const equityOpen = isTradingDay && mins >= 555 && mins < 930;
    const commodityOpen = isTradingDay && mins >= 540 && mins < 1435;

    for (const [panel, entry] of charts) {
      const element = entry.countdownEl;
      if (!element) continue;

      const isCommodity = /CRUDE OIL|NATURAL GAS|GOLD|SILVER|US OIL/i.test(entry.title);
      const isOpen = isCommodity ? commodityOpen : equityOpen;

      if (!isOpen) {
        element.style.visibility = "hidden";
        continue;
      }

      const seconds = intervals[String(entry.timeframe)];
      const times = [...entry.candleByTime.keys()];
      const lastTime = times.length ? Math.max(...times) : null;

      if (!seconds || lastTime === null) {
        element.style.visibility = "hidden";
        continue;
      }

      const remaining =
        seconds - (Math.max(0, now - lastTime) % seconds);

      element.textContent =
        `${String(Math.floor(remaining / 60)).padStart(2, "0")}:` +
        `${String(remaining % 60).padStart(2, "0")}`;

      const candle = entry.candleByTime.get(lastTime);
      const y = candle
        ? entry.series.priceToCoordinate(candle.close)
        : null;

      if (y === null || !Number.isFinite(y)) {
        element.style.visibility = "hidden";
        continue;
      }

      element.style.top = `${Math.round(y + 8)}px`;
      element.style.visibility = "visible";
    }
  }

  const countdownTimer = setInterval(updateCandleCountdowns, 1000);

  // Unified Direct Trading Handler
  document.addEventListener("click", async event => {
    const btn = event.target.closest(".tv-spot-order-btn");
    if (!btn || btn.disabled) return;

    const panel = btn.closest(".panel");
    if (!panel) return;

    const symbolKey = titleOf(panel);
    const optionType = btn.dataset.optionType;
    const lotsInput = panel.querySelector(".tv-lots-input");
    const lots = Math.max(1, Math.floor(Number(lotsInput?.value || 1)));

    let targetKey = null;
    let targetLabel = "";

    const stockSymbol = panel.dataset.stockSymbol || (symbolKey.includes("HW ") ? symbolKey.replace("HW ", "") : null);

    if (stockSymbol) {
      const mappedTitle = `${stockSymbol} ${optionType}`;
      const optInst = instruments[mappedTitle] || instruments[symbolKey];
      targetKey = optInst?.instrument_key;
      targetLabel = optInst?.trading_symbol || mappedTitle;
    } else {
      const isNifty = symbolKey.includes("NIFTY");
      const mappedTitle = isNifty ? `NIFTY ${optionType} 15M` : `BANKNIFTY ${optionType} 15M`;
      const optInst = instruments[mappedTitle];
      if (!optInst?.instrument_key) {
        setStatus(`Order error: Dynamic ${mappedTitle} contract not resolved yet.`, COLORS.red);
        return;
      }
      targetKey = optInst.instrument_key;
      targetLabel = optInst.trading_symbol || mappedTitle;
    }

    if (!targetKey) {
      setStatus(`Order error: Could not resolve contract for ${symbolKey}`, COLORS.red);
      return;
    }

    const instMeta = instruments[targetLabel] || instruments[symbolKey] || {};
    const lotSize = instMeta.lot_size || 1;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = `...`;
    setStatus(`Sending BUY (${lots}L) ${targetLabel} to Upstox…`, COLORS.amber);

    try {
      const response = await fetch(`${API}/order/place`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument_key: targetKey,
          transaction_type: "BUY",
          lots,
          lot_size: lotSize,
          product: "I"
        })
      });

      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || "Upstox rejected the order");

      const orderId = result.order_ids?.[0] || "OK";
      btn.textContent = `✓`;
      setStatus(`BUY FILLED: ${result.trading_symbol} (Qty: ${result.quantity}) · ID: ${orderId}`, COLORS.green);
    } catch (err) {
      btn.textContent = "ERR";
      setStatus(`Order Rejected (${targetLabel}): ${err.message}`, COLORS.red);
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = originalText;
      }, 1200);
    }
  });

  async function loadDashboard(forceRefresh = false) {
    loadRequested = true;
    if (loading) return;
    loading = true;

    try {
      while (loadRequested) {
        loadRequested = false;
        const requestedTimeframe = timeframe;

        if (!window.LightweightCharts) return;
        ensureSpotOrderButtonsInjected();
        setStatus("Loading charts…", COLORS.amber);

        const query = forceRefresh ? "?refresh=1" : "";
        const res = await fetch(`${API}/dashboard/instruments${query}`, { cache: "no-store" });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.message || "Instrument load failed");

        instruments = result.instruments || {};
        const heavyweightSymbols = [...new Set(panels.map(p => p.dataset.stockSymbol).filter(Boolean))];
        if (heavyweightSymbols.length) {
          try {
            const stockRes = await fetch(`${API}/dashboard/stock-instruments?symbols=${encodeURIComponent(heavyweightSymbols.join(","))}`, { cache: "no-store" });
            const stockResult = await stockRes.json();
            if (stockRes.ok && stockResult.success) Object.assign(instruments, stockResult.instruments || {});
          } catch (e) { console.warn("Stock instrument error:", e.message); }
        }

        if (requestedTimeframe !== timeframe || loadRequested) { loadRequested = true; continue; }

        const activeTitles = visibleChartTitles();
        await Promise.all(activeTitles.map(title => loadInstrument(title, chartTimeframeFor(title, requestedTimeframe))));

        if (requestedTimeframe !== timeframe || loadRequested) { loadRequested = true; continue; }
        resizeCharts();
        setStatus("Charts loaded · live active", COLORS.green);
      }
    } catch (e) {
      setStatus(`Dashboard error: ${e.message}`, COLORS.red);
      console.error(e);
    } finally {
      loading = false;
      if (loadRequested) loadDashboard();
    }
  }

  document.addEventListener("dashboard-timeframe", event => {
    timeframe = String(event.detail?.timeframe || "15");
    historicalCache.clear();
    loadDashboard();
  });

  window.addEventListener("dashboard-market", () => {
    requestAnimationFrame(resizeCharts);
    setTimeout(resizeCharts, 100);
    historicalCache.clear();
    loadDashboard();
  });

  window.addEventListener("resize", resizeCharts);

  if (window.LightweightCharts) loadDashboard();
  connectLiveFeed();

  refreshTimer = setInterval(() => {
    if (!document.hidden) { historicalCache.clear(); loadDashboard(); }
  }, 300000);

  window.addEventListener("beforeunload", () => {
    clearInterval(countdownTimer);
    clearInterval(refreshTimer);
    liveSocket?.close();
    for (const panel of [...charts.keys()]) destroyChart(panel);
    charts.clear();
    historicalCache.clear();
  });
})();