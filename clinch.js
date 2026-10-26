"use strict";

/* CLINCH tab (2026-10-25) - vanilla JS, no build step. Loaded after app.js
   and live.js; uses app.js globals (fetchJSON, fetchJSONFrom, fmtMoney,
   moneyClass, chartOptions, destroyChart, state, attachTooltipDismissal).
   Reads data/clinch.json, which the feed daemon copies from the Clinch
   module's dashboard.json (see publish_clinch_dashboard in
   tools/feed/publish.py). While the module is still being built, open
   index.html?clinch=sample#clinch to read data/clinch.sample.json instead.
   Clinch buys the side of a market that is already certain (a game that is
   decided but the price has not reached 100c yet), in small safe amounts.
   Everything on this page is a straight read of the module's file; nothing
   is re-derived here except sums over what the file lists. Plain hyphens
   only, no em/en dashes, anywhere in this file. */

(function () {
  var POLL_MS = 30000;
  var WARN_AGE_S = 12 * 60; // the feed daemon pushes every 1 to 10 minutes, so a few minutes old is normal
  var STALE_AGE_S = 30 * 60;
  var SAMPLE = /[?&]clinch=sample\b/.test(location.search);
  var TZ = "America/Chicago";

  var MODES = {
    watch: { label: "WATCHING", cls: "watch", text: "No real orders are being sent. Clinch is only watching games and showing what it would do." },
    armed: { label: "ARMED", cls: "armed", text: "Ready. Clinch will send real orders the moment a target locks in." },
    live: { label: "LIVE", cls: "live", text: "Real orders are being sent with real money." },
  };

  var STATUS = {
    planned: { label: "Planned", tip: "On today's list, not being watched closely yet." },
    watching: { label: "Watching", tip: "Clinch is watching this game and waiting for it to lock." },
    fired: { label: "Order sent", tip: "The order went out; waiting to hear how much filled." },
    filled: { label: "Filled", tip: "The order filled; waiting for the game to settle." },
    partial: { label: "Part filled", tip: "Only some of the order filled." },
    skipped: { label: "Skipped", tip: "Clinch decided not to buy this one." },
    unconfirmed: { label: "Unconfirmed", tip: "An order went out but Kalshi has not confirmed it yet. Worth a look." },
    settled_win: { label: "Won", tip: "Settled in our favor." },
    settled_loss: { label: "Lost", tip: "Settled against us." },
  };
  var STATUS_ORDER = ["planned", "watching", "fired", "filled", "partial", "unconfirmed", "skipped", "settled_win", "settled_loss"];

  var SAFE = {
    safe: { label: "Safe", tip: "Certain, with plenty of room. Clinch will buy." },
    thin: { label: "Thin", tip: "Certain, but with little room for surprise." },
    unsafe: { label: "Unsafe", tip: "Not safe enough. Clinch will never buy this one." },
  };

  var C = {
    active: false,
    built: false,
    root: null,
    r: {}, // named DOM nodes
    data: null, // last good dashboard file
    missing: false, // the file does not exist yet (404)
    fetchErr: null,
    fetchedAt: 0,
    sig: {}, // section -> signature of what it last drew
    pollTimer: null,
    tickTimer: null,
    day: null,
    league: "",
    status: "",
    q: "",
    chartMode: "line",
    chart: null,
    chartSig: "",
    openGroups: {},
    fillsShown: 15,
  };

  /* -- small helpers -- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var x = Number(v);
    return isNaN(x) ? null : x;
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

  function usd(v, dec) {
    v = num(v);
    if (v === null) return "-";
    var d = dec === undefined ? 2 : dec;
    return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function signed(v, dec) {
    v = num(v);
    if (v === null) return "-";
    var s = usd(Math.abs(v), dec);
    return v > 0 ? "+" + s : (v < 0 ? "-" + s : s);
  }

  function moneyEl(v, dec) {
    var s = el("span", moneyClass(num(v)), signed(v, dec));
    return s;
  }

  /* Prices arrive as dollars (0.991); anything above 1 is taken as cents already. */
  function cents(v) {
    v = num(v);
    if (v === null) return null;
    return v <= 1.0001 ? v * 100 : v;
  }

  function fmtC(v) {
    var c = cents(v);
    return c === null ? "-" : (Math.round(c * 10) / 10).toFixed(1) + "c";
  }

  function pct(v) {
    v = num(v);
    if (v === null) return "-";
    if (v <= 1.0001) v = v * 100;
    return Math.round(v * 10) / 10 + "%";
  }

  function whole(v) {
    v = num(v);
    return v === null ? "-" : Math.round(v).toLocaleString("en-US");
  }

  function parseMs(iso) {
    var t = iso ? new Date(iso).getTime() : NaN;
    return isNaN(t) ? NaN : t;
  }

  var FMT_CLOCK = null, FMT_DAY = null, FMT_STAMP = null;
  try {
    FMT_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
    FMT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    FMT_STAMP = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit", hour12: true });
  } catch (e) { /* very old browser: falls back to local time below */ }

  function parts(fmt, ms) {
    var p = {};
    fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }

  /* "7:05pm" in Central time. Built from parts so a newer browser's narrow no-break space never sneaks in. */
  function clock(iso) {
    var ms = parseMs(iso);
    if (isNaN(ms)) return "";
    if (!FMT_CLOCK) return new Date(ms).toLocaleTimeString();
    var p = parts(FMT_CLOCK, ms);
    return p.hour + ":" + p.minute + String(p.dayPeriod || "").toLowerCase();
  }

  /* "Sat 3:12pm" */
  function stamp(iso) {
    var ms = parseMs(iso);
    if (isNaN(ms)) return "";
    if (!FMT_STAMP) return new Date(ms).toLocaleString();
    var p = parts(FMT_STAMP, ms);
    return p.weekday + " " + p.hour + ":" + p.minute + String(p.dayPeriod || "").toLowerCase();
  }

  function ctDate(ms) {
    if (!FMT_DAY) return new Date(ms).toISOString().slice(0, 10);
    return FMT_DAY.format(new Date(ms));
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /* "Sun Oct 25" from "2026-10-25" (pure calendar math, no timezone involved) */
  function dateLabel(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
    if (!m) return String(ymd || "");
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return WEEKDAYS[d.getUTCDay()] + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  }

  function shortDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
    return m ? MONTHS[+m[2] - 1] + " " + (+m[3]) : String(ymd || "");
  }

  function dayDiff(ymd, todayYmd) {
    var a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd), b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayYmd);
    if (!a || !b) return NaN;
    return Math.round((Date.UTC(+a[1], +a[2] - 1, +a[3]) - Date.UTC(+b[1], +b[2] - 1, +b[3])) / 86400000);
  }

  function ageText(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + "s";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }

  function latencyText(ms) {
    ms = num(ms);
    if (ms === null) return "-";
    return ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s";
  }

  function ageSeconds() {
    var ms = parseMs(C.data && C.data.generated_at);
    return isNaN(ms) ? null : (Date.now() - ms) / 1000;
  }

  /* -- data -- */

  function fetchData() {
    if (typeof fetchJSON !== "function") return Promise.reject(new Error("app.js not loaded"));
    var p = SAMPLE ? fetchJSONFrom("data/clinch.sample.json") : fetchJSON("data/clinch.json");
    return p.then(function (d) {
      if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("clinch file is not an object");
      C.data = d;
      C.missing = false;
      C.fetchErr = null;
      C.fetchedAt = Date.now();
    }).catch(function (err) {
      var msg = String((err && err.message) || err);
      if (!C.data && /\b404\b/.test(msg)) C.missing = true;
      else C.fetchErr = msg;
    });
  }

  function poll() {
    return fetchData().then(function () {
      if (C.active) render();
      paintHome();
    });
  }

  /* -- page skeleton (built once; sections redraw in place) -- */

  function build() {
    var root = document.getElementById("page-clinch");
    if (!root || C.built) return;
    C.root = root;
    C.built = true;
    root.innerHTML = "";

    var r = C.r;
    var title = el("div", "cl-title");
    title.appendChild(el("h2", null, "Clinch"));
    title.appendChild(el("p", "cl-intro", "Clinch buys the side of a market that is already certain - a game that is decided but whose price has not quite reached 100c - a little under a dollar, for a small sure gain."));
    root.appendChild(title);

    r.banner = el("div", "cl-banner-wrap");
    root.appendChild(r.banner);

    r.strip = el("div", "cl-strip");
    root.appendChild(r.strip);

    var chartBlock = el("div", "section-block");
    var chartHead = el("div", "cl-head");
    chartHead.appendChild(el("h2", null, "Progress"));
    var seg = el("div", "cl-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Chart style");
    [["line", "Running total"], ["bars", "By day"]].forEach(function (o) {
      var b = el("button", "cl-seg-btn", o[1]);
      b.type = "button";
      b.setAttribute("data-mode", o[0]);
      b.addEventListener("click", function () {
        C.chartMode = o[0];
        renderChart();
      });
      seg.appendChild(b);
    });
    r.seg = seg;
    chartHead.appendChild(seg);
    chartBlock.appendChild(chartHead);
    r.chartBox = el("div", "chart-box cl-chart-box");
    r.canvas = document.createElement("canvas");
    r.canvas.id = "clinch-chart";
    r.canvas.setAttribute("role", "img");
    r.chartBox.appendChild(r.canvas);
    r.chartEmpty = el("p", "cl-chart-empty");
    r.chartEmpty.hidden = true;
    r.chartBox.appendChild(r.chartEmpty);
    chartBlock.appendChild(r.chartBox);
    r.chartCap = el("p", "chart-caption");
    chartBlock.appendChild(r.chartCap);
    root.appendChild(chartBlock);

    var scoreBlock = el("div", "section-block");
    scoreBlock.appendChild(el("h2", null, "Scoreboard"));
    r.tiles = el("div", "stat-tiles cl-tiles");
    scoreBlock.appendChild(r.tiles);
    root.appendChild(scoreBlock);

    var tBlock = el("div", "section-block");
    tBlock.appendChild(el("h2", null, "Targets by day"));
    r.dayTabs = el("div", "cl-daytabs");
    r.dayTabs.setAttribute("role", "tablist");
    tBlock.appendChild(r.dayTabs);
    r.daySummary = el("p", "cl-day-summary");
    tBlock.appendChild(r.daySummary);

    var bar = el("div", "cl-filters");
    r.league = document.createElement("select");
    r.league.className = "cl-input";
    r.league.setAttribute("aria-label", "Filter by league");
    r.league.addEventListener("change", function () { C.league = r.league.value; renderTargets(); });
    r.statusSel = document.createElement("select");
    r.statusSel.className = "cl-input";
    r.statusSel.setAttribute("aria-label", "Filter by status");
    r.statusSel.addEventListener("change", function () { C.status = r.statusSel.value; renderTargets(); });
    r.search = document.createElement("input");
    r.search.type = "search";
    r.search.className = "cl-input cl-search";
    r.search.placeholder = "Search teams, markets...";
    r.search.setAttribute("aria-label", "Search targets");
    r.search.addEventListener("input", function () { C.q = r.search.value; renderTargets(); });
    bar.appendChild(r.league);
    bar.appendChild(r.statusSel);
    bar.appendChild(r.search);
    tBlock.appendChild(bar);

    var legend = el("p", "cl-legend");
    legend.appendChild(document.createTextNode("Safety: "));
    [["safe", "certain with plenty of room, Clinch buys"], ["thin", "certain but little room for surprise"], ["unsafe", "never bought"]].forEach(function (o, i) {
      if (i) legend.appendChild(document.createTextNode(" | "));
      legend.appendChild(chip("cl-safe-" + o[0], SAFE[o[0]].label));
      legend.appendChild(document.createTextNode(" " + o[1]));
    });
    tBlock.appendChild(legend);

    r.groups = el("div", "cl-groups");
    tBlock.appendChild(r.groups);
    root.appendChild(tBlock);

    var resBlock = el("div", "section-block");
    var resHead = el("div", "cl-head");
    resHead.appendChild(el("h2", null, "Record book"));
    resBlock.appendChild(resHead);
    resBlock.appendChild(el("p", "chart-caption cl-record-note", "The permanent record: how much Clinch has secured, at what price, and what it earned."));
    r.byDay = el("div", "cl-byday");
    resBlock.appendChild(r.byDay);
    resBlock.appendChild(el("h3", "cl-sub", "Recent fills"));
    r.fills = el("div", "cl-fills");
    resBlock.appendChild(r.fills);
    root.appendChild(resBlock);

    r.foot = el("p", "chart-caption cl-foot");
    root.appendChild(r.foot);
  }

  /* -- header strip -- */

  function chip(cls, text, tip) {
    var s = el("span", "cl-chip " + cls, text);
    if (tip) s.title = tip;
    return s;
  }

  function dot(level) { return el("i", "hb-dot " + level); }

  function renderBanner() {
    var host = C.r.banner;
    host.innerHTML = "";
    var msg = null, level = "warn";
    if (SAMPLE) {
      msg = "Sample data - these numbers are made up to show the layout.";
      level = "info";
    } else if (C.missing) {
      msg = null;
    } else if (C.data) {
      var age = ageSeconds();
      if (age === null) {
        msg = "This report has no timestamp, so there is no way to tell how fresh it is.";
      } else if (age > STALE_AGE_S) {
        level = "bad";
        msg = "STALE: this report is " + ageText(age) + " old. Clinch or the publisher may have stopped. Do not trust the numbers below.";
      } else if (age > WARN_AGE_S) {
        msg = "This report is " + ageText(age) + " old - it usually refreshes every few minutes.";
      } else if (C.fetchErr) {
        msg = "Could not reach the data just now. Showing the last report received.";
      }
    }
    if (!msg) return;
    var b = el("div", "cl-banner cl-banner-" + level);
    b.setAttribute("role", level === "bad" ? "alert" : "status");
    b.appendChild(el("span", "cl-banner-text", msg));
    host.appendChild(b);
  }

  function renderStrip() {
    var host = C.r.strip;
    host.innerHTML = "";
    var d = C.data;
    if (!d) {
      host.appendChild(el("p", "cl-empty", C.missing ? "Clinch has not reported in yet. This page fills in as soon as its first report is published." : (C.fetchErr ? "Could not load Clinch data: " + C.fetchErr : "Loading...")));
      return;
    }
    var mode = MODES[d.mode] || { label: String(d.mode || "UNKNOWN").toUpperCase(), cls: "watch", text: "Mode not reported." };
    var h = d.health || {};

    var top = el("div", "cl-strip-top");
    var badge = el("span", "cl-mode cl-mode-" + mode.cls, mode.label);
    badge.setAttribute("aria-label", "Mode: " + mode.label);
    top.appendChild(badge);
    top.appendChild(el("span", "cl-mode-text", mode.text));
    var upd = el("span", "cl-updated");
    upd.id = "clinch-updated";
    top.appendChild(upd);
    host.appendChild(top);

    var grid = el("div", "cl-strip-grid");

    var cash = el("div", "cl-cell");
    cash.appendChild(el("div", "cl-cell-label", "Cash"));
    var cv = el("div", "cl-cell-value");
    cv.appendChild(document.createTextNode(usd(h.cash_free, 0) + " free"));
    cv.appendChild(el("span", "cl-sep", " / "));
    cv.appendChild(document.createTextNode(usd(h.cash_tied, 0) + " tied up"));
    cash.appendChild(cv);
    cash.appendChild(el("div", "cl-cell-sub", "Free can be used for new buys; tied up is waiting on games to settle."));
    grid.appendChild(cash);

    var kill = el("div", "cl-cell");
    kill.appendChild(el("div", "cl-cell-label", "Kill switch"));
    var kv = el("div", "cl-cell-value");
    if (h.kill) {
      kv.appendChild(chip("cl-bad", "STOPPED", "The kill switch is on. No orders will be sent."));
      kill.appendChild(kv);
      kill.appendChild(el("div", "cl-cell-sub", "The kill switch is on - no orders will go out."));
    } else if (d.mode !== "watch" && h.armed === false) {
      kv.appendChild(chip("cl-warn", "ON HOLD", "Not armed, so no orders will go out."));
      kill.appendChild(kv);
      kill.appendChild(el("div", "cl-cell-sub", "Clinch is not armed right now, so it is holding off."));
    } else {
      kv.appendChild(chip("cl-ok", "CLEAR", "The kill switch is off."));
      kill.appendChild(kv);
      kill.appendChild(el("div", "cl-cell-sub", d.mode === "watch" ? "Kill switch is off. (No real orders in watch mode anyway.)" : "Kill switch is off - Clinch can send orders."));
    }
    grid.appendChild(kill);

    var link = el("div", "cl-cell");
    link.appendChild(el("div", "cl-cell-label", "Kalshi live link"));
    var lv = el("div", "cl-cell-value");
    var ws = num(h.ws_age_s);
    if (ws === null) {
      lv.appendChild(el("span", "cl-muted", "not reported"));
    } else {
      lv.appendChild(dot(ws > 30 ? "bad" : (ws > 10 ? "warn" : "ok")));
      lv.appendChild(document.createTextNode(" last heard " + ageText(ws) + " ago"));
    }
    link.appendChild(lv);
    link.appendChild(el("div", "cl-cell-sub", "How long since Kalshi last sent prices. Should stay under a few seconds."));
    grid.appendChild(link);
    host.appendChild(grid);

    var feeds = arr(h.feeds);
    var fw = el("div", "cl-feeds");
    fw.appendChild(el("span", "cl-cell-label", "Score feeds"));
    if (!feeds.length) {
      fw.appendChild(el("span", "cl-muted", "none reported"));
    } else {
      feeds.forEach(function (f) {
        var lag = num(f.lag_s);
        var level = f.ok === false ? "bad" : (lag !== null && lag > 30 ? "warn" : "ok");
        var s = el("span", "cl-feed");
        s.appendChild(dot(level));
        s.appendChild(document.createTextNode(" " + (f.name || f.sport || "feed") + " "));
        s.appendChild(el("span", "cl-feed-lag", lag === null ? "" : ageText(lag)));
        s.title = (f.ok === false ? "Not healthy. " : "Healthy. ") + (lag === null ? "" : "Last update " + ageText(lag) + " ago.");
        fw.appendChild(s);
      });
    }
    host.appendChild(fw);
    tickText();
  }

  /* -- chart -- */

  function renderChart() {
    var r = C.r;
    if (!r.canvas) return;
    var btns = r.seg.querySelectorAll(".cl-seg-btn");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute("data-mode") === C.chartMode;
      btns[i].classList.toggle("active", on);
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    var res = (C.data && C.data.results) || {};
    var line = arr(res.cumulative).map(function (p) { return { x: parseMs(p.ts), y: num(p.profit) }; })
      .filter(function (p) { return !isNaN(p.x) && p.y !== null; }).sort(function (a, b) { return a.x - b.x; });
    var bars = arr(res.by_day).filter(function (b) { return b.date && num(b.profit) !== null; })
      .slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var isLine = C.chartMode === "line";
    var rows = isLine ? line : bars;
    var sig = C.chartMode + JSON.stringify(rows);
    if (sig === C.chartSig && C.chart) return;
    C.chartSig = sig;

    r.chartCap.textContent = isLine
      ? "Total profit after fees, drawn as each trade settles. Tap the line to see the exact figure."
      : "Profit for each day. Green bars made money, red bars lost money.";
    r.canvas.setAttribute("aria-label", isLine ? "Line chart of total Clinch profit over time" : "Bar chart of Clinch profit by day");

    if (typeof destroyChart === "function") destroyChart("clinch-chart");
    else if (C.chart) { C.chart.destroy(); }
    C.chart = null;

    if (!rows.length) {
      r.canvas.hidden = true;
      r.chartEmpty.hidden = false;
      r.chartEmpty.textContent = C.data
        ? "No profit to chart yet. The line starts after the first trade settles."
        : "Nothing to chart yet.";
      return;
    }
    r.canvas.hidden = false;
    r.chartEmpty.hidden = true;
    if (typeof Chart === "undefined" || typeof chartOptions !== "function") {
      r.canvas.hidden = true;
      r.chartEmpty.hidden = false;
      r.chartEmpty.textContent = "The chart could not load (no connection to the chart library).";
      return;
    }

    var cfg;
    if (isLine) {
      var last = rows[rows.length - 1].y;
      var col = last >= 0 ? "#3fb950" : "#f85149";
      var opts = chartOptions(function (ctx) { return "Total: " + signed(ctx.parsed.y, 2); });
      opts.plugins.tooltip.callbacks.title = function (items) {
        return items.length ? stamp(new Date(items[0].parsed.x).toISOString()) : "";
      };
      opts.interaction = { mode: "nearest", intersect: false, axis: "x" };
      var minX = rows[0].x, maxX = rows[rows.length - 1].x;
      var pad = Math.max((maxX - minX) * 0.03, 3600 * 1000);
      opts.scales.x.min = minX - pad;
      opts.scales.x.max = maxX + pad;
      opts.scales.x.ticks.maxTicksLimit = 6;
      opts.scales.x.ticks.callback = function (v) { return shortDate(ctDate(v)); };
      opts.scales.y.beginAtZero = true;
      opts.scales.y.ticks.callback = function (v) { return (v < 0 ? "-" : "") + "$" + Math.abs(Number(v)).toLocaleString("en-US"); };
      cfg = {
        type: "line",
        data: { datasets: [{
          data: rows,
          borderColor: col,
          backgroundColor: last >= 0 ? "rgba(63,185,80,0.10)" : "rgba(248,81,73,0.10)",
          borderWidth: 2,
          tension: 0,
          stepped: false,
          pointRadius: rows.length > 60 ? 0 : 2,
          pointHoverRadius: 5,
          pointHitRadius: 14,
          pointBackgroundColor: col,
          fill: true,
        }] },
        options: opts,
      };
    } else {
      var bopts = chartOptions(function (ctx) { return "Profit that day: " + signed(ctx.parsed.y, 2); });
      bopts.plugins.tooltip.callbacks.title = function (items) { return items.length ? dateLabel(bars[items[0].dataIndex].date) : ""; };
      bopts.interaction = { mode: "nearest", intersect: false, axis: "x" };
      bopts.scales.x = {
        type: "category",
        ticks: { color: "#8b949e", maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        grid: { color: "#30363d" },
      };
      bopts.scales.y.beginAtZero = true;
      bopts.scales.y.ticks.callback = function (v) { return (v < 0 ? "-" : "") + "$" + Math.abs(Number(v)).toLocaleString("en-US"); };
      cfg = {
        type: "bar",
        data: {
          labels: bars.map(function (b) { return shortDate(b.date); }),
          datasets: [{
            data: bars.map(function (b) { return num(b.profit); }),
            backgroundColor: bars.map(function (b) { return num(b.profit) >= 0 ? "#3fb950" : "#f85149"; }),
            borderRadius: 3,
            maxBarThickness: 40,
          }],
        },
        options: bopts,
      };
    }
    C.chart = new Chart(r.canvas, cfg);
    if (typeof state !== "undefined" && state.charts) {
      state.charts["clinch-chart"] = C.chart;
      if (typeof attachTooltipDismissal === "function") attachTooltipDismissal("clinch-chart", r.canvas);
    }
  }

  /* -- scoreboard -- */

  function mkTile(label, valueNode, sub) {
    var t = el("div", "tile");
    t.appendChild(el("div", "label", label));
    var v = el("div", "value");
    if (typeof valueNode === "string") v.textContent = valueNode; else v.appendChild(valueNode);
    t.appendChild(v);
    if (sub) t.appendChild(el("div", "sub", sub));
    return t;
  }

  function renderTiles() {
    var host = C.r.tiles;
    host.innerHTML = "";
    var t = (C.data && C.data.results && C.data.results.totals) || null;
    if (!t) {
      host.appendChild(el("p", "cl-empty", C.data ? "No results yet. The scoreboard fills in after the first trade." : "Nothing to show yet."));
      return;
    }
    var fees = num(t.fees);
    host.appendChild(mkTile("Total profit", moneyEl(t.profit, 2), fees !== null ? "After " + usd(fees, 2) + " in fees" : "After fees"));
    host.appendChild(mkTile("Contracts secured", whole(t.contracts), "Each pays $1 if it wins"));
    host.appendChild(mkTile("Average price paid", fmtC(t.avg_price), "Out of 100c. Lower is more profit"));
    host.appendChild(mkTile("Fill rate", pct(t.fill_rate), "Orders that actually got filled"));
    var wl = el("span");
    wl.appendChild(el("span", "pos", whole(t.wins)));
    wl.appendChild(document.createTextNode(" - "));
    wl.appendChild(el("span", num(t.losses) > 0 ? "neg" : "zero", whole(t.losses)));
    host.appendChild(mkTile("Wins vs losses", wl, "Settled trades that paid out vs did not"));
    host.appendChild(mkTile("Money deployed", usd(t.cost, 0), "Total spent buying contracts"));
  }

  /* -- targets -- */

  function orderedDays(days) {
    var today = ctDate(Date.now());
    var list = days.filter(function (d) { return d && d.date; });
    var cur = list.filter(function (d) { return d.date === today; });
    var fut = list.filter(function (d) { return d.date > today; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var past = list.filter(function (d) { return d.date < today; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return cur.concat(fut, past);
  }

  function dayName(ymd) {
    var diff = dayDiff(ymd, ctDate(Date.now()));
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    return dateLabel(ymd);
  }

  function renderDayTabs(days) {
    var host = C.r.dayTabs;
    var sig = JSON.stringify([C.day, days.map(function (d) { return [d.date, arr(d.targets).length]; }), ctDate(Date.now())]);
    if (sig === C.sig.tabs) return;
    C.sig.tabs = sig;
    host.innerHTML = "";
    if (!days.length) return;
    days.forEach(function (d) {
      var b = el("button", "cl-daytab" + (d.date === C.day ? " active" : ""));
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", d.date === C.day ? "true" : "false");
      b.appendChild(el("span", "cl-daytab-name", dayName(d.date)));
      var diff = dayDiff(d.date, ctDate(Date.now()));
      if (diff !== 0 && diff !== 1 && diff !== -1) { /* weekday + date already in the name */ }
      else b.appendChild(el("span", "cl-daytab-date", dateLabel(d.date)));
      b.appendChild(el("span", "cl-daytab-n", String(arr(d.targets).length)));
      b.addEventListener("click", function () {
        C.day = d.date;
        C.sig.tabs = null;
        C.sig.groups = null;
        renderTargets();
      });
      host.appendChild(b);
    });
  }

  function daySummaryText(s, nTargets) {
    s = s || {};
    var bits = [];
    var t = num(s.targets), g = num(s.games);
    bits.push(plural(t === null ? nTargets : t, "target") + (g !== null ? " across " + plural(g, "game") : ""));
    var plan = num(s.cash_planned), cap = num(s.cash_cap);
    if (plan !== null) bits.push(usd(plan, 0) + " of cash planned" + (cap !== null ? " (limit " + usd(cap, 0) + ")" : ""));
    var cc = num(s.cut_for_cash) || 0, ca = num(s.cut_for_api) || 0;
    if (cc || ca) {
      var cut = [];
      if (cc) cut.push(plural(cc, "target") + " cut because cash ran short");
      if (ca) cut.push(plural(ca, "target") + " cut to stay under Kalshi's order-speed limit");
      bits.push(cut.join(", "));
    } else {
      bits.push("nothing cut");
    }
    var peak = num(s.api_peak_orders_per_lock);
    if (peak !== null) bits.push("busiest moment: " + plural(peak, "order") + " at once");
    return bits.join(" - ");
  }

  function targetMatches(t) {
    if (C.league && t.league !== C.league) return false;
    if (C.status && t.status !== C.status) return false;
    var q = C.q.trim().toLowerCase();
    if (q) {
      var hay = [t.title, t.game, t.league, t.ticker, t.condition, t.certain_side, t.market_type].join(" ").toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  function syncFilterOptions(day) {
    var r = C.r;
    var leagues = {};
    arr(day && day.targets).forEach(function (t) { if (t.league) leagues[t.league] = 1; });
    var names = Object.keys(leagues).sort();
    if (C.league && !leagues[C.league]) C.league = "";
    var lsig = names.join("|") + "#" + C.league;
    if (lsig !== C.sig.leagues) {
      C.sig.leagues = lsig;
      r.league.innerHTML = "";
      var all = el("option", null, "All leagues");
      all.value = "";
      r.league.appendChild(all);
      names.forEach(function (n) {
        var o = el("option", null, n);
        o.value = n;
        r.league.appendChild(o);
      });
      r.league.value = C.league;
    }
    if (!C.sig.statuses) {
      C.sig.statuses = 1;
      var sAll = el("option", null, "Any status");
      sAll.value = "";
      r.statusSel.appendChild(sAll);
      STATUS_ORDER.forEach(function (k) {
        var o = el("option", null, STATUS[k].label);
        o.value = k;
        r.statusSel.appendChild(o);
      });
    }
    r.statusSel.value = C.status;
  }

  function td(label, cls) {
    var c = document.createElement("td");
    c.setAttribute("data-label", label);
    if (cls) c.className = cls;
    return c;
  }

  function buildRow(t) {
    var tr = el("tr", "cl-row cl-safe-row-" + (t.safe_class || "none"));
    var st = STATUS[t.status] || { label: String(t.status || "-"), tip: "" };

    var c = td("Game time", "cl-c-time");
    c.appendChild(el("div", null, clock(t.start_time) || "-"));
    var sub = null;
    if (t.lock_ts) sub = "locked " + clock(t.lock_ts);
    else if (t.est_lock_time && t.safe_class !== "unsafe") sub = "locks about " + clock(t.est_lock_time);
    if (sub) c.appendChild(el("div", "cl-sub-txt", sub));
    tr.appendChild(c);

    c = td("League", "cl-c-league");
    c.appendChild(el("span", "cl-league cl-league-" + String(t.league || "").toLowerCase().replace(/[^a-z0-9]/g, ""), t.league || "-"));
    tr.appendChild(c);

    c = td("Market", "cl-c-market");
    c.appendChild(el("div", "cl-market-title", t.title || t.ticker || "-"));
    if (t.condition) {
      var why = el("div", "cl-sub-txt");
      why.appendChild(el("span", "cl-why", "Certain because: "));
      why.appendChild(document.createTextNode(t.condition));
      c.appendChild(why);
    }
    tr.appendChild(c);

    c = td("We buy", "cl-c-side");
    if (t.certain_side) c.appendChild(chip("cl-side cl-side-" + String(t.certain_side).toLowerCase(), String(t.certain_side).toUpperCase(), "The side Clinch buys"));
    else c.textContent = "-";
    tr.appendChild(c);

    c = td("Safety", "cl-c-safe");
    var sc = SAFE[t.safe_class];
    c.appendChild(sc ? chip("cl-safe-" + t.safe_class, sc.label, sc.tip) : el("span", "cl-muted", "-"));
    tr.appendChild(c);

    c = td("Status", "cl-c-status");
    c.appendChild(chip("cl-st cl-st-" + t.status, st.label, st.tip));
    tr.appendChild(c);

    var contracts = num(t.contracts);
    var got = contracts !== null && contracts > 0;
    c = td("Bought", "cl-c-bought");
    if (got) c.textContent = whole(contracts) + " at " + fmtC(t.avg_price);
    else if (num(t.cash_plan) > 0) { c.appendChild(el("span", "cl-muted", "plan " + usd(t.cash_plan, 0))); }
    else c.textContent = "-";
    tr.appendChild(c);

    c = td("Cost", "cl-c-cost");
    c.textContent = got ? usd(t.cost, 2) : "-";
    tr.appendChild(c);

    c = td("Profit", "cl-c-profit");
    if (num(t.profit) !== null) c.appendChild(moneyEl(t.profit, 2)); else c.textContent = "-";
    tr.appendChild(c);

    c = td("Speed", "cl-c-speed");
    c.textContent = latencyText(t.latency_ms);
    c.title = "How fast the order went out after the game locked";
    tr.appendChild(c);
    for (var i = 0; i < tr.children.length; i++) {
      if (tr.children[i].textContent.trim() === "-") tr.children[i].classList.add("cl-nil"); // hidden on phones, where empty cells only add height
    }
    return tr;
  }

  function buildGroup(dayDate, game, list, forceOpen) {
    var key = dayDate + "|" + game;
    var det = document.createElement("details");
    det.className = "cl-group";
    var openDefault = window.matchMedia ? window.matchMedia("(min-width: 701px)").matches : true;
    det.open = forceOpen || (key in C.openGroups ? C.openGroups[key] : openDefault);
    det.addEventListener("toggle", function () { if (!forceOpen) C.openGroups[key] = det.open; });

    var sum = document.createElement("summary");
    sum.className = "cl-group-sum";
    sum.appendChild(el("span", "cl-group-name", game));
    var first = list[0];
    sum.appendChild(el("span", "cl-group-time", clock(first.start_time)));
    var meta = el("span", "cl-group-meta");
    meta.appendChild(document.createTextNode(plural(list.length, "target")));
    var got = list.filter(function (t) { return num(t.contracts) > 0; }).length;
    if (got) meta.appendChild(document.createTextNode(" - " + got + " bought"));
    var prof = 0, any = false;
    list.forEach(function (t) { if (num(t.profit) !== null) { prof += num(t.profit); any = true; } });
    if (any) { meta.appendChild(document.createTextNode(" - ")); meta.appendChild(moneyEl(prof, 2)); }
    sum.appendChild(meta);
    det.appendChild(sum);

    var wrap = el("div", "table-scroll");
    var table = el("table", "cl-table");
    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    ["Game time", "League", "Market", "We buy", "Safety", "Status", "Bought", "Cost", "Profit", "Speed"].forEach(function (h) {
      hr.appendChild(el("th", null, h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tb = document.createElement("tbody");
    list.forEach(function (t) { tb.appendChild(buildRow(t)); });
    table.appendChild(tb);
    wrap.appendChild(table);
    det.appendChild(wrap);
    return det;
  }

  function renderTargets() {
    var r = C.r;
    var days = orderedDays(arr(C.data && C.data.days));
    if (days.length && !days.some(function (d) { return d.date === C.day; })) C.day = days[0].date;
    var day = null;
    days.forEach(function (d) { if (d.date === C.day) day = d; });
    renderDayTabs(days);
    syncFilterOptions(day);

    var all = arr(day && day.targets);
    var shown = all.filter(targetMatches);
    var sig = JSON.stringify([C.day, C.league, C.status, C.q, day && day.summary, shown]);
    if (sig === C.sig.groups) return;
    C.sig.groups = sig;

    r.daySummary.textContent = day ? daySummaryText(day.summary, all.length) : "";
    r.daySummary.hidden = !day;
    r.groups.innerHTML = "";

    if (!C.data) {
      r.groups.appendChild(el("p", "cl-empty", C.missing ? "No targets yet - Clinch has not reported in." : "Loading..."));
      return;
    }
    if (!days.length) {
      r.groups.appendChild(el("p", "cl-empty", "No targets yet. Clinch lists each day's targets here as it plans them."));
      return;
    }
    if (!all.length) {
      r.groups.appendChild(el("p", "cl-empty", "No targets yet for this day."));
      return;
    }
    if (!shown.length) {
      r.groups.appendChild(el("p", "cl-empty", "Nothing matches these filters."));
      return;
    }
    var by = {}, order = [];
    shown.forEach(function (t) {
      var g = t.game || "Other";
      if (!by[g]) { by[g] = []; order.push(g); }
      by[g].push(t);
    });
    order.forEach(function (g) {
      by[g].sort(function (a, b) {
        return (parseMs(a.start_time) || 0) - (parseMs(b.start_time) || 0) || String(a.ticker).localeCompare(String(b.ticker));
      });
    });
    order.sort(function (a, b) { return (parseMs(by[a][0].start_time) || 0) - (parseMs(by[b][0].start_time) || 0); });
    var searching = C.q.trim() !== "";
    order.forEach(function (g) { r.groups.appendChild(buildGroup(C.day, g, by[g], searching)); });
  }

  /* -- record book -- */

  function th(text, cls) { return el("th", cls || null, text); }

  function renderResults() {
    var r = C.r;
    var res = (C.data && C.data.results) || {};
    var sig = JSON.stringify([res.by_day, res.totals, res.recent_fills, C.fillsShown, !!C.data]);
    if (sig === C.sig.results) return;
    C.sig.results = sig;

    r.byDay.innerHTML = "";
    var rows = arr(res.by_day).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    if (!rows.length) {
      r.byDay.appendChild(el("p", "cl-empty", "No finished days yet. Each day gets a line here once Clinch has bought something."));
    } else {
      var wrap = el("div", "table-scroll");
      var table = el("table", "cl-table cl-plain");
      var thead = document.createElement("thead");
      var hr = document.createElement("tr");
      [["Day", ""], ["Targets fired", "num"], ["Fills", "num"], ["Contracts", "num"], ["Avg price", "num"], ["Cost", "num"], ["Profit", "num"]].forEach(function (h) { hr.appendChild(th(h[0], h[1])); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tb = document.createElement("tbody");
      rows.forEach(function (b) {
        var tr = document.createElement("tr");
        tr.appendChild(el("td", null, dateLabel(b.date)));
        tr.appendChild(el("td", "num", whole(b.targets_fired)));
        tr.appendChild(el("td", "num", whole(b.fills)));
        tr.appendChild(el("td", "num", whole(b.contracts)));
        tr.appendChild(el("td", "num", fmtC(b.avg_price)));
        tr.appendChild(el("td", "num", usd(b.cost, 2)));
        var p = el("td", "num");
        p.appendChild(moneyEl(b.profit, 2));
        tr.appendChild(p);
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      var t = res.totals;
      if (t) {
        var tf = document.createElement("tfoot");
        var fr = document.createElement("tr");
        var firedSum = 0, fillsSum = 0;
        rows.forEach(function (b) { firedSum += num(b.targets_fired) || 0; fillsSum += num(b.fills) || 0; });
        fr.appendChild(el("td", null, "All time"));
        fr.appendChild(el("td", "num", whole(firedSum)));
        fr.appendChild(el("td", "num", whole(fillsSum)));
        fr.appendChild(el("td", "num", whole(t.contracts)));
        fr.appendChild(el("td", "num", fmtC(t.avg_price)));
        fr.appendChild(el("td", "num", usd(t.cost, 2)));
        var tp = el("td", "num");
        tp.appendChild(moneyEl(t.profit, 2));
        fr.appendChild(tp);
        tf.appendChild(fr);
        table.appendChild(tf);
      }
      wrap.appendChild(table);
      r.byDay.appendChild(wrap);
    }

    r.fills.innerHTML = "";
    var fills = arr(res.recent_fills).slice().sort(function (a, b) { return parseMs(b.ts) - parseMs(a.ts); });
    if (!fills.length) {
      r.fills.appendChild(el("p", "cl-empty", "No fills yet. Every contract Clinch buys will show up here, newest first."));
      return;
    }
    var list = el("div", "cl-fill-list");
    fills.slice(0, C.fillsShown).forEach(function (f) {
      var row = el("div", "cl-fill");
      row.appendChild(el("span", "cl-fill-time", stamp(f.ts)));
      var mid = el("span", "cl-fill-what");
      mid.appendChild(el("span", "cl-fill-title", f.title || f.ticker || "-"));
      if (f.side) mid.appendChild(chip("cl-side cl-side-" + String(f.side).toLowerCase(), String(f.side).toUpperCase()));
      row.appendChild(mid);
      row.appendChild(el("span", "cl-fill-qty", whole(f.contracts) + " at " + fmtC(f.price)));
      row.appendChild(el("span", "cl-fill-cost", usd(f.cost, 2)));
      list.appendChild(row);
    });
    r.fills.appendChild(list);
    if (fills.length > C.fillsShown) {
      var more = el("button", "show-more-btn", "Show more (" + (fills.length - C.fillsShown) + " older)");
      more.type = "button";
      more.addEventListener("click", function () { C.fillsShown += 15; renderResults(); });
      r.fills.appendChild(more);
    }
  }

  /* -- clock-driven bits (run every second, touch only text) -- */

  function tickText() {
    var u = document.getElementById("clinch-updated");
    if (u && C.data) {
      var age = ageSeconds();
      u.textContent = age === null ? "update time unknown" : "updated " + ageText(age) + " ago";
    }
    if (C.r.foot && C.data) {
      C.r.foot.textContent = "Report written " + stamp(C.data.generated_at) + " CT. This page re-checks every 30 seconds.";
    }
  }

  function tick() {
    tickText();
    if (C.built) {
      var sig = (C.data ? Math.floor(((ageSeconds() || 0)) / 60) : "x") + "|" + (C.fetchErr || "") + C.missing;
      if (sig !== C.sig.banner) { C.sig.banner = sig; renderBanner(); }
    }
  }

  /* -- Home tile -- */

  function paintHome() {
    var host = document.getElementById("stat-tiles");
    if (!host) return;
    var old = host.querySelector(".cl-home-tile");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    host.classList.remove("has-clinch");
    var d = C.data;
    if (!d || SAMPLE) return;
    var mode = MODES[d.mode] || MODES.watch;
    var t = (d.results && d.results.totals) || {};
    var a = el("a", "tile cl-home-tile");
    a.href = "#clinch";
    a.appendChild(el("div", "label", "Clinch"));
    var v = el("div", "value");
    v.appendChild(moneyEl(t.profit === undefined ? 0 : t.profit, Math.abs(num(t.profit) || 0) < 100 ? 2 : 0));
    a.appendChild(v);
    var sub = el("div", "sub");
    sub.appendChild(el("span", "cl-mode cl-mode-" + mode.cls + " cl-mode-mini", mode.label));
    var age = ageSeconds();
    sub.appendChild(document.createTextNode(" " + (d.mode === "watch" ? "no real orders" : whole(t.contracts) + " contracts") + (age !== null && age > STALE_AGE_S ? " - stale" : "")));
    a.appendChild(sub);
    host.appendChild(a);
    host.classList.add("has-clinch");
  }

  function homeHook() {
    /* called by app.js each time Home redraws */
    paintHome();
    if (Date.now() - C.fetchedAt > 50000 && !C.active) poll();
  }

  /* -- lifecycle -- */

  function render() {
    if (!C.built) build();
    if (!C.built) return;
    renderBanner();
    renderStrip();
    renderChart();
    renderTiles();
    renderTargets();
    renderResults();
    tick();
  }

  function setActive(on) {
    try { document.body.classList.toggle("on-clinch", !!on); } catch (e) { /* ignore */ }
    if (on === C.active) return;
    C.active = on;
    if (on) {
      build();
      render();
      poll();
      C.pollTimer = setInterval(poll, POLL_MS);
      C.tickTimer = setInterval(tick, 1000);
    } else {
      clearInterval(C.pollTimer);
      clearInterval(C.tickTimer);
      C.pollTimer = null;
      C.tickTimer = null;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && C.active) poll();
  });

  window.ClinchTab = {
    render: function () { if (C.active) render(); },
    setActive: setActive,
    homeHook: homeHook,
    _test: { state: C, cents: cents, daySummaryText: daySummaryText },
  };
})();
