"use strict";

/* Kalshi Command Center - vanilla JS, no build step.
   Fetches data/feed.json, data/results.json, data/snapshots.json every
   60 seconds and re-renders in place. Single-page app with hash routing
   (#home, #nfl, #nascar, #f1, #golf) so back/forward and bookmarks work.
   Plain hyphens only, no em/en dashes, anywhere in this file including
   comments and strings. */

var SPORTS = ["NFL", "NASCAR", "F1", "Golf"];
var ROUTES = ["home", "nfl", "nascar", "f1", "golf"];
var ROUTE_TO_SPORT = {};
SPORTS.forEach(function (s) { ROUTE_TO_SPORT[s.toLowerCase()] = s; });

var STRATEGY_BULLETS = {
  NFL: [
    "Each NFL game becomes six small markets: which team wins, and by how much (1-6, 7-14, or 15+ points), plus a Tie market we normally leave alone before kickoff.",
    "We take the NO side on the bucket-by-bucket outcomes, betting they will NOT happen, at a price a little better than what the sportsbooks imply once you strip out their built-in edge.",
    "Kalshi only holds money against the single worst bucket, not all six added together, because exactly one bucket can win.",
    "If we collect more in premium across all six buckets than the $1 we will owe the eventual winner, we profit no matter which bucket hits.",
    "If one bucket gets too heavy, the first response is to stop selling more of that bucket and instead sell the lighter buckets at fair value or a touch below, so the risk spreads back out.",
    "Once the game is live, we quote both sides of the board for size, leaning toward whichever bucket just became the new favorite as long as the game is not already decided.",
    "Buying back a heavy bucket (paying to undo a sale) is a last resort, used in-game only when a bucket is badly over-leveraged and losing.",
    "In the closing minutes we only nudge the book toward breakeven if the likely outcomes would otherwise lose money; if the current plan already wins, we leave it alone.",
    "Results so far: TNF Falcons at Packers +$25.49, MNF Giants at Rams +$13.11, SNF Colts at Chiefs +$485.00, TNF Lions at Bills +$40.75.",
  ],
  NASCAR: [
    "Every driver in the race is its own yes/no market: does this driver win the race. Roughly three dozen markets, one race.",
    "We take the NO side on as many drivers as we can, priced a little better than what Vegas implies once blended with Kalshi's own market.",
    "Only one driver can win, so Kalshi only holds our money against the single worst driver we are exposed to, not the sum of every driver.",
    "Early in race week it is fine to be lopsided (heavy on a few popular favorites); we tighten the sizing in the final 30 to 45 minutes before green flag and again once the race is under way.",
    "If a driver gets too heavy, the first move is to stop selling more of that driver and sell the less popular drivers instead, at fair value or a touch below.",
    "Buying back a heavy driver is a last resort, only in-race, only when that driver is genuinely pulling away and we are losing on it.",
    "The margin we ask above fair value is chosen on purpose (how far back in the order queue we would be, how badly a driver needs selling, how much time is left), not just the smallest possible margin.",
    "Hollywood Casino 400 at Kansas: green flag Sunday.",
  ],
  F1: [
    "Same idea as NASCAR: every driver on the grid is its own yes/no market, and only one wins the Grand Prix.",
    "We sell NO on as many drivers as we can at a price a little better than the market implies, and Kalshi only holds money against the single worst driver.",
    "If a driver gets too heavy, we stop selling that driver and sell the lighter ones instead, rather than reaching straight for a buyback.",
    "Buybacks (paying to undo a sale) are a last resort, in-race only, when a driver is badly over-leveraged and pulling away.",
    "In the final laps we only repair the book toward breakeven if the likely finish would otherwise lose money; a winning book is left alone.",
    "Azerbaijan Grand Prix (Baku), 9/26: settled +$10.61. A pricing bug briefly pushed the worst case to about -$196 mid-race by over-buying one driver; it was caught, turned off, and repaired back to about -$70 before final settlement.",
    "Small calendar: next races are Singapore and Austin.",
  ],
  Golf: [
    "The market is who leads the tournament's overall points race, not who wins outright, so it can end in a genuine tie between co-leaders.",
    "We sell NO on as many players as we can at a price a little better than fair, same one-winner collateral rule as NASCAR and F1.",
    "The difference from the other sports: if two or more players tie for the lead, the $1 payout is split between them instead of going to a single winner, and our math accounts for that split.",
    "Trading pauses overnight (7pm to 7am Central) since nothing changes on the leaderboard while nobody is playing.",
    "If a player's lead gets too heavy, we stop selling that player and sell the others instead, at fair value or a touch below.",
    "Buybacks are a last resort, in-play only, when a leader is badly over-leveraged and pulling away.",
    "In the final round we only repair toward breakeven if the likely outcomes would otherwise lose money; a winning book is left alone.",
    "Presidents Cup Overall Points Leader is live through the final round.",
  ],
};

var state = {
  feed: null,
  results: [],
  snapshots: [],
  calendar: [],
  charts: {},
  tooltipTimers: {},
};

/* -- formatting helpers -- */

function fmtMoney(n, decimals) {
  decimals = decimals || 0;
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  n = Number(n);
  var sign = n > 0 ? "+" : (n < 0 ? "-" : "");
  var abs = Math.abs(n);
  var numStr = abs.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return sign + "$" + numStr;
}

function fmtPlainDollars(n) {
  /* Allocations are a budget, not a profit or loss, so no +/- sign - just
     "$1,563", matching how Blake reads a cash allocation. */
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  return "$" + Math.round(Math.abs(Number(n))).toLocaleString("en-US");
}

function fmtCollectedDollars(n) {
  /* Like fmtPlainDollars (no leading +, "$509" not "+$509" - these read as
     a running collection total, not a gain/loss), but keeps a minus sign
     in the rare case a figure goes negative, since that is still
     meaningful here (unlike a budget allocation, which is never negative). */
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  n = Number(n);
  var sign = n < 0 ? "-" : "";
  return sign + "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
}

function moneyClass(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "zero";
  n = Number(n);
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "zero";
}

function fmtCents(p) {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return "-";
  return Math.round(Number(p) * 100) + "c";
}

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  return Math.round(Number(n)).toLocaleString("en-US");
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function sumBy(arr, key) {
  return (arr || []).reduce(function (s, x) { return s + (Number(x[key]) || 0); }, 0);
}

function timeAgoText(iso) {
  if (!iso) return "unknown";
  var ms = Date.now() - new Date(iso).getTime();
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s ago";
  var m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  var h = Math.round(m / 60);
  if (h < 48) return h + "h ago";
  var d = Math.round(h / 24);
  return d + "d ago";
}

function centralTimeLabel(iso) {
  /* "12:41am" for a fill from today (Central time), "Sun 12:41am" for
     any other day - using Intl's own America/Chicago timezone data so
     CDT/CST daylight-saving transitions are handled automatically,
     never a hardcoded UTC offset. */
  if (!iso) return "unknown time";
  var d = new Date(iso);
  var fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    weekday: "short",
  });
  var parts = {};
  fmt.formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
  var timeStr = (parts.hour || "") + ":" + (parts.minute || "") + String(parts.dayPeriod || "").toLowerCase();
  var dateFmt = { timeZone: "America/Chicago", year: "numeric", month: "numeric", day: "numeric" };
  var fillDateStr = new Intl.DateTimeFormat("en-US", dateFmt).format(d);
  var nowDateStr = new Intl.DateTimeFormat("en-US", dateFmt).format(new Date());
  if (fillDateStr === nowDateStr) return timeStr;
  return (parts.weekday || "") + " " + timeStr;
}

function centralDateParts(iso) {
  var d = new Date(iso);
  var parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
  return parts;
}

function centralDateKey(iso) {
  var p = centralDateParts(iso);
  return (p.year || "9999") + "-" + (p.month || "99") + "-" + (p.day || "99");
}

function centralDayLabel(iso) {
  var d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" }).format(d);
}

function centralTimeOnly(iso) {
  var d = new Date(iso);
  var parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true })
    .formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
  return (parts.hour || "") + ":" + (parts.minute || "") + String(parts.dayPeriod || "").toLowerCase();
}

function startTimeText(b) {
  if (b.in_play) {
    if (!b.start_time) return "in play";
    return "in play since " + new Date(b.start_time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  if (!b.start_time) return "start time unknown";
  var startMs = new Date(b.start_time).getTime();
  var diffMs = startMs - Date.now();
  if (diffMs <= 0) return "starting soon";
  var totalMin = Math.round(diffMs / 60000);
  var h = Math.floor(totalMin / 60);
  var m = totalMin % 60;
  return "starts in " + (h > 0 ? h + "h " : "") + m + "m";
}

function heartbeatAgeAtGeneration(b) {
  /* Deliberately NOT measured against the browser's clock: GitHub Pages
     itself can take 1 to 3 minutes to publish a push, so by the time the
     page loads, generated_at is already a few minutes old in browser
     time even on a perfectly healthy book. b.heartbeat_age_s is the
     publisher's own server-side measurement (heartbeat ts vs its own
     generated_at, same run, same clock), so it is not affected by
     Pages' publish delay or by browser/server clock skew. */
  return b.heartbeat_age_s;
}

function hbDotClass(b) {
  if (b.heartbeat_ok === false) return "bad";
  var age = heartbeatAgeAtGeneration(b);
  if (age === null || age === undefined) return "warn";
  if (age > 600) return "bad";
  if (age > 120) return "warn";
  return "ok";
}

function shortEventLabel(key) {
  /* "SNF-W1-SEP20" -> "SNF-W1", "TNF-W3" -> "TNF-W3" (no date suffix to
     strip), "F1-BAKU" -> "F1-BAKU". Used for the on-chart point labels
     (short by necessity - team abbreviations aren't part of the data
     model, only the fleet's own event key and title are). */
  if (!key) return "";
  return String(key).replace(/-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{1,2}.*$/i, "");
}

/* -- small DOM builders -- */

function td(text) {
  var d = document.createElement("td");
  d.textContent = text;
  return d;
}

function moneySpan(n, decimals) {
  var span = document.createElement("span");
  span.className = moneyClass(n);
  span.textContent = fmtMoney(n, decimals);
  return span;
}

function tile(label, valueNode, subText) {
  var div = document.createElement("div");
  div.className = "tile";
  var l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  var v = document.createElement("div");
  v.className = "value";
  if (typeof valueNode === "string") {
    v.textContent = valueNode;
  } else {
    v.appendChild(valueNode);
  }
  div.appendChild(l);
  div.appendChild(v);
  if (subText) {
    var s = document.createElement("div");
    s.className = "sub";
    s.textContent = subText;
    div.appendChild(s);
  }
  return div;
}

function statEl(label, value) {
  var span = document.createElement("span");
  span.className = "stat";
  span.textContent = label + ": ";
  var b = document.createElement("b");
  b.textContent = value;
  span.appendChild(b);
  return span;
}

function statMoneyEl(label, value) {
  var span = document.createElement("span");
  span.className = "stat";
  span.textContent = label + ": ";
  var b = document.createElement("b");
  b.className = moneyClass(value);
  b.textContent = fmtMoney(value);
  span.appendChild(b);
  return span;
}

/* -- data fetch -- */

function fetchJSON(path) {
  return fetch(path + "?t=" + Date.now(), { cache: "no-store" }).then(function (res) {
    if (!res.ok) throw new Error(path + " returned " + res.status);
    return res.json();
  });
}

function refresh() {
  return Promise.all([
    fetchJSON("data/feed.json"),
    fetchJSON("data/results.json").catch(function () { return []; }),
    fetchJSON("data/snapshots.json").catch(function () { return []; }),
    fetchJSON("data/calendar.json").catch(function () { return { rows: [] }; }),
  ]).then(function (parts) {
    state.feed = parts[0];
    state.results = Array.isArray(parts[1]) ? parts[1] : [];
    state.snapshots = Array.isArray(parts[2]) ? parts[2] : [];
    state.calendar = Array.isArray(parts[3] && parts[3].rows) ? parts[3].rows : [];
    renderAll();
  }).catch(function (err) {
    renderError(err);
  });
}

/* -- routing -- */

function currentRoute() {
  var h = (location.hash || "").replace("#", "").toLowerCase();
  return ROUTES.indexOf(h) >= 0 ? h : "home";
}

function applyRoute(route) {
  ROUTES.forEach(function (r) {
    var page = document.getElementById("page-" + r);
    if (page) page.hidden = (r !== route);
    var tabEl = document.querySelector('.tab[data-route="' + r + '"]');
    if (tabEl) {
      if (r === route) {
        tabEl.classList.add("active");
        tabEl.setAttribute("aria-current", "page");
      } else {
        tabEl.classList.remove("active");
        tabEl.removeAttribute("aria-current");
      }
    }
  });
}

function renderForRoute(route) {
  if (!state.feed) return;
  if (route === "home") {
    renderHomeTiles();
    renderPurseChart();
    renderCalendar(document.getElementById("calendar-list"));
    renderLiveBooks(document.getElementById("live-books-list"), null);
  } else {
    renderSportPage(ROUTE_TO_SPORT[route]);
  }
}

window.addEventListener("hashchange", function () {
  var route = currentRoute();
  applyRoute(route);
  renderForRoute(route);
});

/* -- stale / header -- */

var STALE_GENERATED_AT_SECONDS = 8 * 60; // GitHub Pages can take 1 to 3 minutes to publish a push,
                                          // so generated_at is routinely a few minutes old in the
                                          // browser even when everything is healthy.

function computeStale() {
  /* 2026-09-29, Blake: the global red badge is about the FEED'S OWN
     freshness only now - a golf book's loop legitimately takes 75 to
     150 seconds with a 150-market field, which used to trip this on a
     perfectly healthy run. Per-book staleness (its own loop-aware
     threshold, from the publisher) shows as an amber note on that
     book's own card instead - see heartbeatStaleNote(). */
  if (!state.feed) return true;
  var genAgeS = (Date.now() - new Date(state.feed.generated_at).getTime()) / 1000;
  return genAgeS > STALE_GENERATED_AT_SECONDS;
}

function heartbeatStaleNote(b) {
  var age = heartbeatAgeAtGeneration(b);
  var threshold = b.heartbeat_stale_threshold_s;
  if (age === null || age === undefined || threshold === null || threshold === undefined) return null;
  if (age <= threshold) return null;
  var mins = Math.max(1, Math.round(age / 60));
  return "heartbeat " + mins + "m old";
}

function updateHeaderTimestamps() {
  var el = document.getElementById("updated-ago");
  var badge = document.getElementById("stale-badge");
  if (!state.feed) {
    el.textContent = "no data yet";
    badge.hidden = true;
    return;
  }
  el.textContent = "updated " + timeAgoText(state.feed.generated_at);
  badge.hidden = !computeStale();
}

function renderHomeTiles() {
  var f = state.feed;
  var tiles = document.getElementById("stat-tiles");
  tiles.innerHTML = "";
  tiles.appendChild(tile("Cash free", moneySpan(f.cash_free)));
  tiles.appendChild(tile("Locked in open books", moneySpan(f.locked_collateral)));
  var totalRealized = f.results_summary ? f.results_summary.total_realized : null;
  tiles.appendChild(tile("Profit since 9/15", moneySpan(totalRealized)));

  var books = f.books || [];
  var worstSum = sumBy(books, "worst_now");
  var bestSum = sumBy(books, "best_now");
  var rangeNode = document.createElement("span");
  if (books.length) {
    rangeNode.appendChild(moneySpan(worstSum));
    rangeNode.appendChild(document.createTextNode(" .. "));
    rangeNode.appendChild(moneySpan(bestSum));
  } else {
    rangeNode.textContent = "no live books";
  }
  var sub = "";
  if (books.length) {
    var implied = sumBy(books, "market_implied_outcome_now");
    var trend = sumBy(books, "market_implied_trend_15m");
    var hasTrend = books.some(function (b) { return b.market_implied_trend_15m !== null && b.market_implied_trend_15m !== undefined; });
    sub = "Market-implied " + fmtMoney(implied) + (hasTrend ? " (15m " + fmtMoney(trend) + ")" : "") + " across " + books.length + " book" + (books.length === 1 ? "" : "s");
  }
  tiles.appendChild(tile("Open books right now", rangeNode, sub));

  var allocNote = document.getElementById("allocation-note");
  if (allocNote) {
    allocNote.hidden = !f.allocation_target;
  }
}

/* -- chart tooltip dismissal (touch devices stick the tooltip open with
   no built-in mouseout, since a tap has no hover-away event) -- */

function isTouchDevice() {
  return ("ontouchstart" in window) || (navigator.maxTouchPoints > 0) || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
}

function clearChartTooltip(chart) {
  if (!chart) return;
  try {
    chart.setActiveElements([]);
    if (chart.tooltip) chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.update();
  } catch (e) {
    /* chart may be mid-destroy between renders; nothing to clear then */
  }
}

function clearAllChartTooltips() {
  Object.keys(state.charts).forEach(function (id) {
    clearChartTooltip(state.charts[id]);
  });
}

function armTooltipAutoHide(canvasId) {
  if (!isTouchDevice()) return;
  if (state.tooltipTimers[canvasId]) clearTimeout(state.tooltipTimers[canvasId]);
  state.tooltipTimers[canvasId] = setTimeout(function () {
    clearChartTooltip(state.charts[canvasId]);
  }, 4000);
}

function attachTooltipDismissal(canvasId, canvas) {
  if (canvas._tooltipDismissalAttached) return;
  var handler = function (evt) {
    var chart = state.charts[canvasId];
    if (!chart) return;
    var points = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, false);
    if (!points || !points.length) {
      /* touchend/pointerup landed outside any point - dismiss right away */
      clearChartTooltip(chart);
    } else {
      armTooltipAutoHide(canvasId);
    }
  };
  canvas.addEventListener("touchend", handler, { passive: true });
  canvas.addEventListener("pointerup", handler);
  canvas._tooltipDismissalAttached = true;
}

function initGlobalTooltipDismissal() {
  var handler = function (evt) {
    if (evt.target && evt.target.tagName === "CANVAS") return; // that canvas handles its own dismissal
    clearAllChartTooltips();
  };
  document.addEventListener("touchend", handler, { passive: true });
  document.addEventListener("pointerup", handler);
}

/* -- point labels drawn directly on the chart (so the tooltip is never
   needed just to identify a point); staggered above/below alternately -- */

var pointLabelsPlugin = {
  id: "pointLabels",
  afterDatasetsDraw: function (chart, args, opts) {
    if (!opts || !opts.enabled || typeof opts.labelForIndex !== "function") return;
    var meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data.length) return;
    var ds = chart.data.datasets[0];
    var ctx = chart.ctx;
    ctx.save();
    ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = "#c9d1d9";
    meta.data.forEach(function (element, i) {
      var raw = ds.data[i];
      var label = opts.labelForIndex(raw, i);
      if (!label) return;
      var pos = element.tooltipPosition ? element.tooltipPosition() : { x: element.x, y: element.y };
      var above = (i % 2 === 0);
      var x = Math.min(Math.max(pos.x, chart.chartArea.left + 2), chart.chartArea.right - 2);
      var y = above ? Math.max(pos.y - 10, chart.chartArea.top + 8) : Math.min(pos.y + 12, chart.chartArea.bottom - 4);
      ctx.fillText(label, x, y);
    });
    ctx.restore();
  },
};
if (typeof Chart !== "undefined") {
  Chart.register(pointLabelsPlugin);
}

/* -- charts -- */

function destroyChart(id) {
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }
  if (state.tooltipTimers[id]) {
    clearTimeout(state.tooltipTimers[id]);
    delete state.tooltipTimers[id];
  }
}

function chartOptions(tooltipLabelFn, xMin, xMax) {
  var xScale = {
    type: "linear",
    ticks: { color: "#8b949e", callback: function (v) { return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } },
    grid: { color: "#30363d" },
  };
  if (xMin !== undefined && xMin !== null) xScale.min = xMin;
  if (xMax !== undefined && xMax !== null) xScale.max = xMax;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    layout: { padding: { top: 14, bottom: 14 } },
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        position: "nearest",
        caretSize: 4,
        boxPadding: 4,
        callbacks: {
          title: function (items) {
            return items.length ? new Date(items[0].parsed.x).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
          },
          label: tooltipLabelFn,
        },
      },
    },
    scales: {
      x: xScale,
      y: {
        ticks: { color: "#8b949e", callback: function (v) { return "$" + Number(v).toLocaleString("en-US"); } },
        grid: { color: "#30363d" },
      },
    },
  };
}

function createLineChart(canvasId, datasets, tooltipLabelFn, xMin, xMax, labelForIndex) {
  if (typeof Chart === "undefined") return null;
  var canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  destroyChart(canvasId);
  var opts = chartOptions(tooltipLabelFn, xMin, xMax);
  opts.plugins.pointLabels = { enabled: !!labelForIndex, labelForIndex: labelForIndex };
  var chart = new Chart(canvas, { type: "line", data: { datasets: datasets }, options: opts });
  state.charts[canvasId] = chart;
  attachTooltipDismissal(canvasId, canvas);
  return chart;
}

function eventPointLabel(raw) {
  if (!raw || raw.synthetic || raw.key === undefined || raw.key === null) return null;
  return shortEventLabel(raw.key) + " " + fmtMoney(raw.realized);
}

function buildPurseSeries() {
  var results = state.results.filter(function (r) { return r.settled_time; });
  results = results.slice().sort(function (a, b) { return new Date(a.settled_time) - new Date(b.settled_time); });
  var cum = 0;
  var solidPoints = results.map(function (r) {
    cum += (r.realized_pnl || 0);
    return { x: new Date(r.settled_time).getTime(), y: round2(cum), title: r.title, realized: r.realized_pnl, key: r.key };
  });
  var dashedPoints = [];
  if (state.snapshots && state.snapshots.length) {
    state.snapshots.forEach(function (snap) {
      var t = new Date(snap.ts).getTime();
      var realizedToDate = 0;
      results.forEach(function (r) {
        if (new Date(r.settled_time).getTime() <= t) realizedToDate += (r.realized_pnl || 0);
      });
      dashedPoints.push({ x: t, y: round2(realizedToDate + (snap.open_market_implied || 0)) });
    });
  }
  return { solidPoints: solidPoints, dashedPoints: dashedPoints };
}

function renderPurseChart() {
  var series = buildPurseSeries();
  var datasets = [{
    label: "Realized profit",
    data: series.solidPoints,
    borderColor: "#3fb950",
    backgroundColor: "rgba(63,185,80,0.08)",
    cubicInterpolationMode: "monotone",
    tension: 0.4,
    pointRadius: 3,
    pointBackgroundColor: "#3fb950",
    fill: true,
  }];
  if (series.dashedPoints.length) {
    datasets.push({
      label: "Realized + market-implied",
      data: series.dashedPoints,
      borderColor: "#8b949e",
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
      cubicInterpolationMode: "monotone",
      tension: 0.4,
    });
  }
  createLineChart("purse-chart", datasets, function (ctx) {
    var raw = ctx.raw || {};
    if (raw.title) {
      return [raw.title + ": " + fmtMoney(raw.realized), "Running total: " + fmtMoney(ctx.parsed.y)];
    }
    return ["Total: " + fmtMoney(ctx.parsed.y)];
  }, undefined, undefined, eventPointLabel);
}

function renderSportChart(canvasId, points, highlightIdx, xMin, xMax) {
  var pointColors = points.map(function (p, i) {
    if (p.synthetic) return "rgba(0,0,0,0)";
    return i === highlightIdx ? "#d29922" : ((p.realized || 0) >= 0 ? "#3fb950" : "#f85149");
  });
  var pointRadii = points.map(function (p, i) {
    if (p.synthetic) return 0;
    return i === highlightIdx ? 6 : 3;
  });
  var datasets = [{
    data: points,
    cubicInterpolationMode: "monotone",
    tension: 0.4,
    borderColor: "#58a6ff",
    backgroundColor: "rgba(88,166,255,0.08)",
    pointBackgroundColor: pointColors,
    pointRadius: pointRadii,
    fill: true,
  }];
  createLineChart(canvasId, datasets, function (ctx) {
    var raw = ctx.raw || {};
    if (raw.synthetic) return ["Before the first settled event"];
    return [(raw.title || "") + ": " + fmtMoney(raw.realized), "Running total: " + fmtMoney(ctx.parsed.y)];
  }, xMin, xMax, eventPointLabel);
}

/* -- sport page (chart, stats, strategy, its live books, its settled events) -- */

function computeSportWindow() {
  /* One shared time window for all four sport charts, so they line up:
     earliest settled_time across every sport, minus a day, to today plus
     a day. Without an explicit min/max, a chart with a single data point
     lets Chart.js's linear scale invent its own arbitrary padding around
     that one x value (this was the bug: F1's one point showed an axis
     running Nov 14 to Mar 17). */
  var allSettledMs = state.results
    .map(function (r) { return r.settled_time ? new Date(r.settled_time).getTime() : null; })
    .filter(function (t) { return t !== null && !Number.isNaN(t); });
  var DAY_MS = 24 * 60 * 60 * 1000;
  var start = allSettledMs.length ? (Math.min.apply(null, allSettledMs) - DAY_MS) : (Date.now() - DAY_MS);
  var end = Date.now() + DAY_MS;
  return { start: start, end: end };
}

function renderSportPage(sport) {
  var container = document.getElementById("sport-page-" + sport);
  if (!container) return;
  container.innerHTML = "";

  var h2 = document.createElement("h2");
  h2.textContent = sport;
  container.appendChild(h2);

  var results = state.results.filter(function (r) { return r.sport === sport; });

  if (!results.length) {
    var p = document.createElement("p");
    p.className = "no-results";
    p.textContent = "No settled events yet.";
    container.appendChild(p);
  } else {
    var win = computeSportWindow();
    var sorted = results.slice().sort(function (a, b) { return new Date(a.settled_time || 0) - new Date(b.settled_time || 0); });
    var cum = 0;
    var points = sorted.map(function (r) {
      cum += (r.realized_pnl || 0);
      return { x: r.settled_time ? new Date(r.settled_time).getTime() : Date.now(), y: round2(cum), title: r.title, realized: r.realized_pnl, key: r.key };
    });
    var maxIdx = 0;
    points.forEach(function (pt, i) {
      if ((pt.realized || -Infinity) > (points[maxIdx].realized || -Infinity)) maxIdx = i;
    });

    /* A sport with exactly one settled event has nothing to draw a line
       between - anchor it with a synthetic $0 point at the shared
       window's start so the step line still draws from $0 up (or down)
       to the real point, instead of a single floating dot. */
    if (points.length === 1) {
      points.unshift({ x: win.start, y: 0, title: null, realized: null, synthetic: true });
      maxIdx += 1;
    }

    var chartBox = document.createElement("div");
    chartBox.className = "chart-box";
    var canvas = document.createElement("canvas");
    var canvasId = "chart-sport-" + sport.replace(/[^A-Za-z0-9]/g, "");
    canvas.id = canvasId;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", sport + " cumulative realized profit, one point per settled event");
    chartBox.appendChild(canvas);

    var chartWrap = document.createElement("div");
    chartWrap.className = "section-block";
    chartWrap.appendChild(chartBox);
    var caption = document.createElement("p");
    caption.className = "chart-caption";
    caption.textContent = "Tap a point for details; tap elsewhere to dismiss.";
    chartWrap.appendChild(caption);

    var total = sorted.reduce(function (s, r) { return s + (r.realized_pnl || 0); }, 0);
    var best = Math.max.apply(null, sorted.map(function (r) { return r.realized_pnl || 0; }));
    var worst = Math.min.apply(null, sorted.map(function (r) { return r.realized_pnl || 0; }));
    var statRow = document.createElement("div");
    statRow.className = "stat-row";
    statRow.appendChild(statEl("Events", String(sorted.length)));
    statRow.appendChild(statMoneyEl("Total", total));
    statRow.appendChild(statMoneyEl("Best", best));
    statRow.appendChild(statMoneyEl("Worst", worst));
    chartWrap.appendChild(statRow);

    /* Append to the document BEFORE creating the chart - a canvas still
       detached from the document has zero layout size, which is exactly
       why the NFL and F1 charts once rendered as blank boxes. */
    container.appendChild(chartWrap);
    renderSportChart(canvasId, points, maxIdx, win.start, win.end);
  }

  var details = document.createElement("details");
  details.className = "strategy";
  var summary = document.createElement("summary");
  summary.textContent = "How the " + sport + " strategy works";
  details.appendChild(summary);
  var ul = document.createElement("ul");
  (STRATEGY_BULLETS[sport] || []).forEach(function (bullet) {
    var li = document.createElement("li");
    li.textContent = bullet;
    ul.appendChild(li);
  });
  details.appendChild(ul);
  var detailsWrap = document.createElement("div");
  detailsWrap.className = "section-block";
  detailsWrap.appendChild(details);
  container.appendChild(detailsWrap);

  var liveWrap = document.createElement("div");
  liveWrap.className = "section-block";
  var liveHeading = document.createElement("h2");
  liveHeading.textContent = "Live books";
  liveWrap.appendChild(liveHeading);
  var liveList = document.createElement("div");
  liveWrap.appendChild(liveList);
  container.appendChild(liveWrap);
  renderLiveBooks(liveList, sport);

  var settledWrap = document.createElement("div");
  settledWrap.className = "section-block";
  var settledHeading = document.createElement("h2");
  settledHeading.textContent = "Settled events";
  settledWrap.appendChild(settledHeading);
  var tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  var table = document.createElement("table");
  var thead = document.createElement("thead");
  var headRow = document.createElement("tr");
  ["Date", "Event", "Result", "Contracts sold", "Premium", "Collected"].forEach(function (h) {
    var th = document.createElement("th");
    th.setAttribute("scope", "col");
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  var tbody = document.createElement("tbody");
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  settledWrap.appendChild(tableWrap);
  container.appendChild(settledWrap);
  renderSettledTable(tbody, sport);
}

/* -- live books -- */

function buildOutcomeTable(b) {
  var wrap = document.createElement("div");
  wrap.className = "table-scroll";
  var table = document.createElement("table");
  var thead = document.createElement("thead");
  var headRow = document.createElement("tr");
  ["Outcome", "Held", "Resting", "Price", "If this wins"].forEach(function (h) {
    var th = document.createElement("th");
    th.setAttribute("scope", "col");
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  var outcomes = b.outcomes || [];
  var visible = outcomes.filter(function (o) { return (o.held || 0) > 0 || (o.resting || 0) > 0; });
  var zero = outcomes.filter(function (o) { return !((o.held || 0) > 0) && !((o.resting || 0) > 0); });

  var tbody = document.createElement("tbody");
  visible.forEach(function (o) { tbody.appendChild(outcomeRow(o, false)); });
  table.appendChild(tbody);

  if (zero.length) {
    var extraBody = document.createElement("tbody");
    extraBody.hidden = true;
    zero.forEach(function (o) { extraBody.appendChild(outcomeRow(o, true)); });
    table.appendChild(extraBody);
    wrap.appendChild(table);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "show-more-btn";
    btn.textContent = "Show " + zero.length + " more";
    var expanded = false;
    btn.addEventListener("click", function () {
      expanded = !expanded;
      extraBody.hidden = !expanded;
      btn.textContent = expanded ? "Show fewer" : ("Show " + zero.length + " more");
    });
    wrap.appendChild(btn);
  } else {
    wrap.appendChild(table);
  }
  return wrap;
}

function outcomeRow(o, dim) {
  var tr = document.createElement("tr");
  if (dim) tr.className = "zero-row";
  tr.appendChild(td(o.label));
  tr.appendChild(td(fmtNum(o.held)));
  tr.appendChild(td(fmtNum(o.resting)));
  tr.appendChild(td(o.market_yes_price !== null && o.market_yes_price !== undefined ? fmtCents(o.market_yes_price) : "-"));
  var winTd = document.createElement("td");
  winTd.appendChild(moneySpan(o.outcome_now));
  tr.appendChild(winTd);
  return tr;
}

function fmtMarginCents(cents, fairDollars) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return "-";
  cents = Number(cents);
  var sign = cents >= 0 ? "+" : "-";
  var text = sign + Math.abs(cents).toFixed(1) + "c";
  if (fairDollars !== null && fairDollars !== undefined && Number(fairDollars) > 0) {
    var pct = (cents / 100) / Number(fairDollars) * 100;
    var pctSign = pct >= 0 ? "+" : "-";
    text += " (" + pctSign + Math.abs(pct).toFixed(0) + "%)";
  }
  return text;
}

function buildFillsTable(fills) {
  var wrap = document.createElement("div");
  wrap.className = "table-scroll";
  var table = document.createElement("table");
  var thead = document.createElement("thead");
  var headRow = document.createElement("tr");
  ["Time", "Outcome", "Side", "Count", "Price", "Fair", "Margin"].forEach(function (h) {
    var th = document.createElement("th");
    th.setAttribute("scope", "col");
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  var tbody = document.createElement("tbody");
  if (!fills.length) {
    var tr0 = document.createElement("tr");
    var cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "state-msg";
    cell.textContent = "No fills recorded yet.";
    tr0.appendChild(cell);
    tbody.appendChild(tr0);
  } else {
    // Newest first - already the order the publisher sends them in.
    fills.forEach(function (f) {
      var tr = document.createElement("tr");
      tr.appendChild(td(centralTimeLabel(f.ts) + " (" + timeAgoText(f.ts) + ")"));
      tr.appendChild(td(f.label));
      var sideTd = document.createElement("td");
      var sideSpan = document.createElement("span");
      sideSpan.className = f.side === "sell" ? "side-sell" : "side-buyback";
      sideSpan.textContent = f.side === "sell" ? "sold" : "bought back";
      sideTd.appendChild(sideSpan);
      tr.appendChild(sideTd);
      tr.appendChild(td(fmtNum(f.count)));
      tr.appendChild(td(fmtCents(f.price)));
      tr.appendChild(td(f.fair !== null && f.fair !== undefined ? fmtCents(f.fair) : "-"));
      var marginTd = document.createElement("td");
      var marginSpan = document.createElement("span");
      marginSpan.className = moneyClass(f.margin_cents);
      marginSpan.textContent = fmtMarginCents(f.margin_cents, f.fair);
      marginTd.appendChild(marginSpan);
      tr.appendChild(marginTd);
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildFillsSummaryLine(summary) {
  var p = document.createElement("p");
  p.className = "fills-summary-line";
  if (!summary || !summary.n) {
    p.textContent = "No recorded fills with a margin yet.";
    return p;
  }
  p.appendChild(document.createTextNode("last " + summary.n + " fill" + (summary.n === 1 ? "" : "s") + ": avg margin "));
  var avgSpan = document.createElement("span");
  avgSpan.className = moneyClass(summary.avg_margin_cents);
  avgSpan.textContent = (summary.avg_margin_cents >= 0 ? "+" : "") + Number(summary.avg_margin_cents).toFixed(1) + "c";
  p.appendChild(avgSpan);
  p.appendChild(document.createTextNode(", total "));
  var totalSpan = document.createElement("span");
  totalSpan.className = moneyClass(summary.total_margin_dollars);
  totalSpan.textContent = fmtMoney(summary.total_margin_dollars, 2);
  p.appendChild(totalSpan);
  return p;
}

function buildFillsSection(b) {
  var details = document.createElement("details");
  details.className = "fills-toggle";
  var fills = b.recent_fills || [];
  var summary = document.createElement("summary");
  summary.textContent = "Recent fills (" + fills.length + ")";
  details.appendChild(summary);
  details.appendChild(buildFillsTable(fills));
  details.appendChild(buildFillsSummaryLine(b.fills_summary));
  return details;
}

function buildCollectedBlock(b) {
  /* "Principal collected" (Blake, 2026-09-27): premium, fees, net, the
     margin banked over fair, and cumulative sold/bought-back counts.
     Folds in what used to be the footer's separate Premium/Fees stats,
     so those are no longer duplicated down in the footer row. */
  var wrap = document.createElement("div");
  wrap.className = "collected-block";

  var main = document.createElement("div");
  main.className = "collected-main " + moneyClass(b.net_collected_dollars);
  main.textContent = "Collected " + fmtCollectedDollars(b.premium_collected_dollars) + " premium, "
    + fmtCollectedDollars(b.fees_dollars) + " fees, " + fmtCollectedDollars(b.net_collected_dollars) + " net";
  wrap.appendChild(main);

  var margin = document.createElement("div");
  margin.className = "collected-margin";
  if (b.banked_margin_dollars !== null && b.banked_margin_dollars !== undefined) {
    margin.appendChild(document.createTextNode("Margin over fair: "));
    var span = document.createElement("span");
    span.className = moneyClass(b.banked_margin_dollars);
    span.textContent = fmtCollectedDollars(b.banked_margin_dollars);
    margin.appendChild(span);
    margin.appendChild(document.createTextNode(" banked"));
  } else {
    margin.textContent = "Margin over fair: pending";
    margin.classList.add("pending");
  }
  wrap.appendChild(margin);

  var contracts = document.createElement("div");
  contracts.className = "collected-contracts";
  contracts.textContent = fmtNum(b.contracts_sold_total) + " sold, " + fmtNum(b.contracts_bought_back_total) + " bought back";
  wrap.appendChild(contracts);

  return wrap;
}

/* 2026-09-28 (Blake, activity watchdog + floor mode, finishing the
   deferred command-center pieces): b.activity/b.floor_mode are a
   straight passthrough of the bot's own heartbeat.json blocks (house21/
   activity.py's watchdog; house21/ingame.py's floor-mode functions) --
   this reads them, never re-derives them. Either can be missing
   (null/undefined) on a heartbeat from before this build, or one that
   has not looped yet -- rendered as no block at all, never a false
   "all clear." */
function buildActivityBlock(b) {
  var wrap = document.createElement("div");
  wrap.className = "activity-block";

  var fm = b.floor_mode;
  if (fm && fm.active) {
    var floorLine = document.createElement("div");
    floorLine.className = "floor-mode-banner";
    var floorText = "Floor mode: guaranteed ";
    if (fm.floor_now !== null && fm.floor_now !== undefined) {
      floorLine.appendChild(document.createTextNode(floorText));
      floorLine.appendChild(moneySpan(fm.floor_now));
    } else {
      floorLine.textContent = floorText + "-";
    }
    wrap.appendChild(floorLine);
  }

  var a = b.activity;
  if (!a) {
    return wrap.childNodes.length ? wrap : null;
  }

  var statsLine = document.createElement("div");
  statsLine.className = "activity-stats";
  var posted = (a.posts_last_10m !== null && a.posts_last_10m !== undefined) ? fmtNum(a.posts_last_10m) : "-";
  var filled = (a.fills_last_30m !== null && a.fills_last_30m !== undefined) ? fmtNum(a.fills_last_30m) : "-";
  var traded = (a.market_volume_last_30m !== null && a.market_volume_last_30m !== undefined) ? fmtNum(a.market_volume_last_30m) : "-";
  statsLine.textContent = "Last 10 min: " + posted + " posted. Last 30 min: " + filled + " filled, " + traded + " traded on the market.";
  wrap.appendChild(statsLine);

  if (a.inactive) {
    var causeLine = document.createElement("div");
    causeLine.className = "activity-cause";
    var causeText = "Inactive -- cause: " + (a.cause || "unknown");
    if (a.remedy && a.remedy.action) {
      causeText += " (remedy: " + a.remedy.action + ")";
    }
    causeLine.textContent = causeText;
    wrap.appendChild(causeLine);
  }

  return wrap;
}

function buildOutlookBlock(b) {
  /* Replaces the old "Worst / EV / Best" footer EV figure (Blake, 2026-
     09-27: "EV is misleading - it either assumes everything fills or is
     like the average of all positions"). Two numbers instead: the best
     floor tradeable against the real order book RIGHT NOW (informational
     only, the publisher never trades), and a probability-weighted
     outcome using the bot's own live view (or market mids), with its
     15-minute trend. */
  var wrap = document.createElement("div");
  wrap.className = "outlook-block";

  var bgLine = document.createElement("div");
  bgLine.className = "outlook-line";
  var bg = b.break_glass;
  if (bg && bg.locked_floor !== null && bg.locked_floor !== undefined) {
    bgLine.appendChild(document.createTextNode("Break glass: lock "));
    bgLine.appendChild(moneySpan(bg.locked_floor));
    bgLine.appendChild(document.createTextNode(" now, costs " + fmtPlainDollars(bg.cost)));
  } else {
    bgLine.textContent = "Break glass: not available this update";
    bgLine.classList.add("pending");
  }
  wrap.appendChild(bgLine);

  var miLine = document.createElement("div");
  miLine.className = "outlook-line";
  if (b.market_implied_outcome_now !== null && b.market_implied_outcome_now !== undefined) {
    miLine.appendChild(document.createTextNode("Market-implied outcome (trend 15m): "));
    miLine.appendChild(moneySpan(b.market_implied_outcome_now));
    if (b.market_implied_trend_15m !== null && b.market_implied_trend_15m !== undefined) {
      var trendSpan = document.createElement("span");
      trendSpan.className = moneyClass(b.market_implied_trend_15m);
      trendSpan.textContent = " (" + fmtMoney(b.market_implied_trend_15m) + ")";
      miLine.appendChild(trendSpan);
    }
  } else {
    miLine.textContent = "Market-implied outcome (trend 15m): pending";
    miLine.classList.add("pending");
  }
  wrap.appendChild(miLine);

  return wrap;
}

/* -- collapsible card state (localStorage, wrapped in try/catch since a
   private-browsing tab or a blocked-storage context can throw just from
   touching localStorage at all) -- */

function getCardCollapsedPref(key) {
  try {
    var v = localStorage.getItem("kcc_collapsed_" + key);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch (e) {
    /* localStorage unavailable - no stored preference, fall through */
  }
  return null;
}

function setCardCollapsedPref(key, collapsed) {
  try {
    localStorage.setItem("kcc_collapsed_" + key, collapsed ? "1" : "0");
  } catch (e) {
    /* localStorage unavailable - nothing to persist, the page still works */
  }
}

function buildBookCard(b, opts) {
  opts = opts || {};
  var stored = getCardCollapsedPref(b.key);
  var collapsed = stored !== null ? stored : !!opts.defaultCollapsed;

  var card = document.createElement("div");
  card.className = "book-card";

  var head = document.createElement("div");
  head.className = "book-head";
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  head.setAttribute("aria-label", "Toggle " + b.title + " details");
  var dot = document.createElement("span");
  dot.className = "hb-dot " + hbDotClass(b);
  dot.setAttribute("aria-label", "heartbeat health: " + hbDotClass(b));
  var title = document.createElement("span");
  title.className = "title";
  title.textContent = b.title;
  var sportTag = document.createElement("span");
  sportTag.className = "sport-tag";
  sportTag.textContent = b.sport;
  var phase = document.createElement("span");
  phase.className = "phase-badge " + (b.in_play ? "in-play" : "pre-game");
  phase.textContent = b.phase;
  head.appendChild(dot);
  head.appendChild(title);
  head.appendChild(sportTag);
  head.appendChild(phase);

  var quick = document.createElement("span");
  quick.className = "book-head-quick";
  var floorSpan = document.createElement("span");
  floorSpan.className = "book-head-floor " + moneyClass(b.worst_now);
  floorSpan.textContent = fmtMoney(b.worst_now);
  var premSpan = document.createElement("span");
  premSpan.className = "book-head-premium";
  premSpan.textContent = fmtPlainDollars(b.premium_collected_dollars) + " prem";
  quick.appendChild(floorSpan);
  quick.appendChild(premSpan);
  head.appendChild(quick);

  var chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  head.appendChild(chevron);

  card.appendChild(head);

  var body = document.createElement("div");
  body.className = "book-body";

  body.appendChild(buildCollectedBlock(b));
  var activityBlock = buildActivityBlock(b);
  if (activityBlock) {
    body.appendChild(activityBlock);
  }

  var meta = document.createElement("div");
  meta.className = "book-meta";
  var startSpan = document.createElement("span");
  startSpan.textContent = startTimeText(b);
  meta.appendChild(startSpan);
  var allocSpan = document.createElement("span");
  if (b.allocation_dollars !== null && b.allocation_dollars !== undefined) {
    var allocText = "Allocation " + fmtPlainDollars(b.allocation_dollars);
    var target = state.feed && state.feed.allocation_target;
    if (target) {
      allocText += (target === b.key) ? " (receiving freed cash)" : " (reserved need)";
    }
    allocSpan.textContent = allocText;
  } else {
    allocSpan.textContent = "Allocation: -";
  }
  meta.appendChild(allocSpan);
  var staleNote = heartbeatStaleNote(b);
  if (staleNote) {
    var staleSpan = document.createElement("span");
    staleSpan.className = "heartbeat-stale-note";
    staleSpan.textContent = staleNote;
    meta.appendChild(staleSpan);
  }
  body.appendChild(meta);

  body.appendChild(buildOutcomeTable(b));

  var footRow = document.createElement("div");
  footRow.className = "stat-row";
  var webStat = document.createElement("span");
  webStat.className = "stat";
  webStat.appendChild(document.createTextNode("If it ended now / Best: "));
  webStat.appendChild(moneySpan(b.worst_now));
  webStat.appendChild(document.createTextNode(" / "));
  webStat.appendChild(moneySpan(b.best_now));
  footRow.appendChild(webStat);
  footRow.appendChild(statEl("Contracts held", fmtNum(b.contracts_held_total)));
  body.appendChild(footRow);

  body.appendChild(buildOutlookBlock(b));

  body.appendChild(buildFillsSection(b));

  card.appendChild(body);

  function applyState(nowCollapsed) {
    body.hidden = nowCollapsed;
    head.setAttribute("aria-expanded", String(!nowCollapsed));
    card.classList.toggle("collapsed", nowCollapsed);
  }
  applyState(collapsed);

  function toggle() {
    collapsed = !collapsed;
    applyState(collapsed);
    setCardCollapsedPref(b.key, collapsed);
  }
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", function (evt) {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      toggle();
    }
  });

  card.setCollapsed = function (val) {
    if (val === collapsed) return;
    collapsed = val;
    applyState(collapsed);
    setCardCollapsedPref(b.key, collapsed);
  };

  return card;
}

/* -- calendar -- */

function buildCalendarRow(r) {
  var row = document.createElement("div");
  row.className = "calendar-row" + (r.kind === "live_book" ? " live" : " candidate");

  var dot = document.createElement("span");
  dot.className = "calendar-dot" + (r.kind === "live_book" ? " live" : "");
  row.appendChild(dot);

  var iso = r.start_iso || r.ends_by_iso;
  var timeText = "date TBD";
  if (iso) {
    timeText = r.start_iso ? centralTimeOnly(iso) : ("by " + centralTimeOnly(iso));
  }

  var text = document.createElement("span");
  text.className = "calendar-text";
  var label = timeText + " - " + (r.sport || "-") + " - " + r.title;
  if (r.kind === "live_book") {
    label += " - LIVE BOOK";
  } else if (r.kind === "manual" && r.note) {
    label += " - " + r.note;
  }
  text.textContent = label;
  row.appendChild(text);

  return row;
}

function renderCalendar(container) {
  container.innerHTML = "";
  var rows = state.calendar || [];
  if (!rows.length) {
    var p = document.createElement("p");
    p.className = "state-msg";
    p.textContent = "Nothing on the calendar right now.";
    container.appendChild(p);
    return;
  }

  // Group by Central-time calendar day, in the order the publisher
  // already sorted rows (chronological, live books always kept
  // regardless of date math) - live books sort first within a day they
  // share with a candidate/manual row.
  var groups = [];
  var groupByKey = {};
  rows.forEach(function (r) {
    var iso = r.start_iso || r.ends_by_iso;
    var key = iso ? centralDateKey(iso) : "9999-99-99";
    var label = iso ? centralDayLabel(iso) : "Date TBD";
    if (!groupByKey[key]) {
      groupByKey[key] = { key: key, label: label, rows: [] };
      groups.push(groupByKey[key]);
    }
    groupByKey[key].rows.push(r);
  });
  groups.forEach(function (g) {
    g.rows.sort(function (a, b) {
      var aLive = a.kind === "live_book" ? 0 : 1;
      var bLive = b.kind === "live_book" ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return 0;
    });
  });

  var visibleGroups = [];
  var hiddenGroups = [];
  var count = 0;
  groups.forEach(function (g) {
    if (count < 8) {
      visibleGroups.push(g);
      count += g.rows.length;
    } else {
      hiddenGroups.push(g);
    }
  });

  function appendGroups(target, groupList) {
    groupList.forEach(function (g) {
      var header = document.createElement("div");
      header.className = "calendar-day-header";
      header.textContent = g.label;
      target.appendChild(header);
      g.rows.forEach(function (r) { target.appendChild(buildCalendarRow(r)); });
    });
  }

  appendGroups(container, visibleGroups);

  if (hiddenGroups.length) {
    var hiddenWrap = document.createElement("div");
    hiddenWrap.hidden = true;
    appendGroups(hiddenWrap, hiddenGroups);
    container.appendChild(hiddenWrap);

    var hiddenCount = hiddenGroups.reduce(function (s, g) { return s + g.rows.length; }, 0);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "show-more-btn";
    btn.textContent = "Show " + hiddenCount + " more";
    var expanded = false;
    btn.addEventListener("click", function () {
      expanded = !expanded;
      hiddenWrap.hidden = !expanded;
      btn.textContent = expanded ? "Show fewer" : ("Show " + hiddenCount + " more");
    });
    container.appendChild(btn);
  }
}

/* -- live books -- */

function renderLiveBooks(container, sportFilter) {
  container.innerHTML = "";
  var books = ((state.feed && state.feed.books) || []).filter(function (b) { return !sportFilter || b.sport === sportFilter; });
  if (!books.length) {
    var p = document.createElement("p");
    p.className = "state-msg";
    p.textContent = sportFilter ? ("No " + sportFilter + " book is live right now.") : "No books are live right now.";
    container.appendChild(p);
    return;
  }

  // Default (first visit, no stored preference yet): expanded for a
  // single live book, collapsed once there are two or more. Whatever the
  // person chose after that always wins (buildBookCard reads its own
  // stored preference per card).
  var defaultCollapsed = books.length >= 2;

  var controls = document.createElement("div");
  controls.className = "collapse-controls";
  var collapseAllBtn = document.createElement("button");
  collapseAllBtn.type = "button";
  collapseAllBtn.className = "link-btn";
  collapseAllBtn.textContent = "Collapse all";
  var sep = document.createTextNode(" / ");
  var expandAllBtn = document.createElement("button");
  expandAllBtn.type = "button";
  expandAllBtn.className = "link-btn";
  expandAllBtn.textContent = "Expand all";
  controls.appendChild(collapseAllBtn);
  controls.appendChild(sep);
  controls.appendChild(expandAllBtn);
  container.appendChild(controls);

  var cards = books.map(function (b) { return buildBookCard(b, { defaultCollapsed: defaultCollapsed }); });
  cards.forEach(function (c) { container.appendChild(c); });

  collapseAllBtn.addEventListener("click", function () {
    cards.forEach(function (c) { c.setCollapsed(true); });
  });
  expandAllBtn.addEventListener("click", function () {
    cards.forEach(function (c) { c.setCollapsed(false); });
  });
}

/* -- settled table (per sport page) -- */

function renderSettledTable(tbody, sport) {
  tbody.innerHTML = "";
  var rows = state.results.filter(function (r) { return r.sport === sport; })
    .sort(function (a, b) { return new Date(b.settled_time || 0) - new Date(a.settled_time || 0); });
  if (!rows.length) {
    var tr = document.createElement("tr");
    var cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "state-msg";
    cell.textContent = "No settled events yet.";
    tr.appendChild(cell);
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(function (r) {
    var tr2 = document.createElement("tr");
    tr2.appendChild(td(r.settled_time ? new Date(r.settled_time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "-"));
    tr2.appendChild(td(r.title || r.event_ticker));
    var resultTd = document.createElement("td");
    resultTd.appendChild(moneySpan(r.realized_pnl));
    tr2.appendChild(resultTd);
    tr2.appendChild(td(r.contracts_sold !== null && r.contracts_sold !== undefined ? fmtNum(r.contracts_sold) : "-"));
    tr2.appendChild(td(r.premium !== null && r.premium !== undefined ? fmtMoney(r.premium) : "-"));
    var collectedTd = document.createElement("td");
    if (r.premium !== null && r.premium !== undefined && r.fees !== null && r.fees !== undefined) {
      collectedTd.appendChild(moneySpan(r.premium - r.fees));
    } else {
      collectedTd.textContent = "-";
    }
    tr2.appendChild(collectedTd);
    tbody.appendChild(tr2);
  });
}

/* -- error / loading states -- */

function renderError(err) {
  var el = document.getElementById("updated-ago");
  el.textContent = "Could not load data (" + (err && err.message ? err.message : "unknown error") + ")";
  var badge = document.getElementById("stale-badge");
  badge.hidden = false;
}

/* -- top-level render -- */

function renderAll() {
  updateHeaderTimestamps();
  renderForRoute(currentRoute());
}

document.addEventListener("DOMContentLoaded", function () {
  applyRoute(currentRoute());
  initGlobalTooltipDismissal();
  refresh();
  setInterval(refresh, 60000);
  setInterval(function () {
    if (state.feed) updateHeaderTimestamps();
  }, 1000);
});
