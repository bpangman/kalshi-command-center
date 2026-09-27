"use strict";

/* Kalshi Command Center - vanilla JS, no build step.
   Fetches data/feed.json, data/results.json, data/snapshots.json every
   60 seconds and re-renders in place. Plain hyphens only, no em/en
   dashes, anywhere in this file including comments and strings. */

var SPORTS = ["NFL", "NASCAR", "F1", "Golf"];

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
  charts: {},
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
  ]).then(function (parts) {
    state.feed = parts[0];
    state.results = Array.isArray(parts[1]) ? parts[1] : [];
    state.snapshots = Array.isArray(parts[2]) ? parts[2] : [];
    renderAll();
  }).catch(function (err) {
    renderError(err);
  });
}

/* -- stale / header -- */

var STALE_GENERATED_AT_SECONDS = 8 * 60; // GitHub Pages can take 1 to 3 minutes to publish a push,
                                          // so generated_at is routinely a few minutes old in the
                                          // browser even when everything is healthy.
var STALE_HEARTBEAT_SECONDS = 2 * 60;

function computeStale() {
  if (!state.feed) return true;
  var genAgeS = (Date.now() - new Date(state.feed.generated_at).getTime()) / 1000;
  if (genAgeS > STALE_GENERATED_AT_SECONDS) return true;
  var books = state.feed.books || [];
  for (var i = 0; i < books.length; i++) {
    var age = heartbeatAgeAtGeneration(books[i]);
    if (age !== null && age !== undefined && age > STALE_HEARTBEAT_SECONDS) return true;
  }
  return false;
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

function renderHeader() {
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
  var evSum = sumBy(books, "ev_now");
  var rangeNode = document.createElement("span");
  if (books.length) {
    rangeNode.appendChild(moneySpan(worstSum));
    rangeNode.appendChild(document.createTextNode(" .. "));
    rangeNode.appendChild(moneySpan(bestSum));
  } else {
    rangeNode.textContent = "no live books";
  }
  var sub = books.length ? ("EV " + fmtMoney(evSum) + " across " + books.length + " book" + (books.length === 1 ? "" : "s")) : "";
  tiles.appendChild(tile("Open books right now", rangeNode, sub));

  var allocNote = document.getElementById("allocation-note");
  if (allocNote) {
    allocNote.hidden = !f.allocation_target;
  }

  updateHeaderTimestamps();
}

/* -- charts -- */

function destroyChart(id) {
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
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
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
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

function buildPurseSeries() {
  var results = state.results.filter(function (r) { return r.settled_time; });
  results = results.slice().sort(function (a, b) { return new Date(a.settled_time) - new Date(b.settled_time); });
  var cum = 0;
  var solidPoints = results.map(function (r) {
    cum += (r.realized_pnl || 0);
    return { x: new Date(r.settled_time).getTime(), y: round2(cum), title: r.title, realized: r.realized_pnl };
  });
  var dashedPoints = [];
  if (state.snapshots && state.snapshots.length) {
    state.snapshots.forEach(function (snap) {
      var t = new Date(snap.ts).getTime();
      var realizedToDate = 0;
      results.forEach(function (r) {
        if (new Date(r.settled_time).getTime() <= t) realizedToDate += (r.realized_pnl || 0);
      });
      dashedPoints.push({ x: t, y: round2(realizedToDate + (snap.open_ev || 0)) });
    });
  }
  return { solidPoints: solidPoints, dashedPoints: dashedPoints };
}

function renderPurseChart() {
  if (typeof Chart === "undefined") return;
  var canvas = document.getElementById("purse-chart");
  var series = buildPurseSeries();
  destroyChart("purse-chart");
  var datasets = [{
    label: "Realized profit",
    data: series.solidPoints,
    borderColor: "#3fb950",
    backgroundColor: "rgba(63,185,80,0.08)",
    stepped: "before",
    pointRadius: 3,
    pointBackgroundColor: "#3fb950",
    fill: true,
    tension: 0,
  }];
  if (series.dashedPoints.length) {
    datasets.push({
      label: "Realized + open EV",
      data: series.dashedPoints,
      borderColor: "#8b949e",
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
      tension: 0.1,
    });
  }
  state.charts["purse-chart"] = new Chart(canvas, {
    type: "line",
    data: { datasets: datasets },
    options: chartOptions(function (ctx) {
      var raw = ctx.raw || {};
      if (raw.title) {
        return [raw.title + ": " + fmtMoney(raw.realized), "Running total: " + fmtMoney(ctx.parsed.y)];
      }
      return ["Total: " + fmtMoney(ctx.parsed.y)];
    }),
  });
}

function renderSportChart(canvasId, points, highlightIdx, xMin, xMax) {
  if (typeof Chart === "undefined") return;
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  destroyChart(canvasId);
  var pointColors = points.map(function (p, i) {
    if (p.synthetic) return "rgba(0,0,0,0)";
    return i === highlightIdx ? "#d29922" : ((p.realized || 0) >= 0 ? "#3fb950" : "#f85149");
  });
  var pointRadii = points.map(function (p, i) {
    if (p.synthetic) return 0;
    return i === highlightIdx ? 6 : 3;
  });
  state.charts[canvasId] = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [{
        data: points,
        stepped: "before",
        borderColor: "#58a6ff",
        backgroundColor: "rgba(88,166,255,0.08)",
        pointBackgroundColor: pointColors,
        pointRadius: pointRadii,
        fill: true,
        tension: 0,
      }],
    },
    options: chartOptions(function (ctx) {
      var raw = ctx.raw || {};
      if (raw.synthetic) return ["Before the first settled event"];
      return [(raw.title || "") + ": " + fmtMoney(raw.realized), "Running total: " + fmtMoney(ctx.parsed.y)];
    }, xMin, xMax),
  });
}

/* -- sport cards -- */

function renderSportCards() {
  var container = document.getElementById("sport-cards");
  container.innerHTML = "";

  /* One shared time window for all four sport charts, so they line up:
     earliest settled_time across every sport, minus a day, to today plus
     a day. Without an explicit min/max, a chart with a single data point
     lets Chart.js's linear scale invent its own arbitrary padding around
     that one x value (this was the bug: F1's one point showed an axis
     running Nov 14 to Mar 17 with nothing to anchor it). */
  var allSettledMs = state.results
    .map(function (r) { return r.settled_time ? new Date(r.settled_time).getTime() : null; })
    .filter(function (t) { return t !== null && !Number.isNaN(t); });
  var DAY_MS = 24 * 60 * 60 * 1000;
  var sportWindowStart = allSettledMs.length ? (Math.min.apply(null, allSettledMs) - DAY_MS) : (Date.now() - DAY_MS);
  var sportWindowEnd = Date.now() + DAY_MS;

  SPORTS.forEach(function (sport) {
    var results = state.results.filter(function (r) { return r.sport === sport; });
    var card = document.createElement("div");
    card.className = "sport-card";
    var h3 = document.createElement("h3");
    h3.textContent = sport;
    card.appendChild(h3);

    /* Append the card to the document BEFORE building anything with a
       canvas in it. Chart.js measures its canvas's container via
       getBoundingClientRect/ResizeObserver at construction time; a card
       still detached from the document has zero layout size, so a chart
       created before this line renders as a blank box (this was exactly
       the bug: NFL and F1 cards were blank because renderSportChart used
       to run before container.appendChild(card)). The purse chart never
       had this problem because its canvas is already static markup in
       index.html, present in the document from page load. */
    container.appendChild(card);

    if (!results.length) {
      var p = document.createElement("p");
      p.className = "no-results";
      p.textContent = "No settled events yet.";
      card.appendChild(p);
    } else {
      var sorted = results.slice().sort(function (a, b) { return new Date(a.settled_time || 0) - new Date(b.settled_time || 0); });
      var cum = 0;
      var points = sorted.map(function (r) {
        cum += (r.realized_pnl || 0);
        return { x: r.settled_time ? new Date(r.settled_time).getTime() : Date.now(), y: round2(cum), title: r.title, realized: r.realized_pnl };
      });
      var maxIdx = 0;
      points.forEach(function (pt, i) {
        if ((pt.realized || -Infinity) > (points[maxIdx].realized || -Infinity)) maxIdx = i;
      });

      /* A sport with exactly one settled event has nothing to draw a
         line between - anchor it with a synthetic $0 point at the shared
         window's start so the step line still draws from $0 up (or down)
         to the real point, instead of a single floating dot. */
      if (points.length === 1) {
        points.unshift({ x: sportWindowStart, y: 0, title: null, realized: null, synthetic: true });
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
      card.appendChild(chartBox);

      var total = sorted.reduce(function (s, r) { return s + (r.realized_pnl || 0); }, 0);
      var best = Math.max.apply(null, sorted.map(function (r) { return r.realized_pnl || 0; }));
      var worst = Math.min.apply(null, sorted.map(function (r) { return r.realized_pnl || 0; }));
      var statRow = document.createElement("div");
      statRow.className = "stat-row";
      statRow.appendChild(statEl("Events", String(sorted.length)));
      statRow.appendChild(statMoneyEl("Total", total));
      statRow.appendChild(statMoneyEl("Best", best));
      statRow.appendChild(statMoneyEl("Worst", worst));
      card.appendChild(statRow);

      renderSportChart(canvasId, points, maxIdx, sportWindowStart, sportWindowEnd);
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
    card.appendChild(details);
  });
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

function buildFillsSection(b) {
  var details = document.createElement("details");
  details.className = "fills-toggle";
  var fills = b.recent_fills || [];
  var summary = document.createElement("summary");
  summary.textContent = "Recent fills (" + fills.length + ")";
  details.appendChild(summary);
  var ul = document.createElement("ul");
  ul.className = "fills-list";
  if (!fills.length) {
    var li0 = document.createElement("li");
    li0.textContent = "No fills recorded yet.";
    ul.appendChild(li0);
  }
  fills.forEach(function (f) {
    var li = document.createElement("li");
    var left = document.createElement("span");
    left.textContent = f.label + " - " + fmtNum(f.count) + " @ " + fmtCents(f.price);
    var right = document.createElement("span");
    right.className = f.side === "sell" ? "side-sell" : "side-buyback";
    right.textContent = f.side === "sell" ? "sold" : "bought back";
    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  });
  details.appendChild(ul);
  return details;
}

function buildBookCard(b) {
  var card = document.createElement("div");
  card.className = "book-card";

  var head = document.createElement("div");
  head.className = "book-head";
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
  card.appendChild(head);

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
  card.appendChild(meta);

  card.appendChild(buildOutcomeTable(b));

  var footRow = document.createElement("div");
  footRow.className = "stat-row";
  footRow.appendChild(statMoneyEl("Premium", b.premium_collected));
  footRow.appendChild(statMoneyEl("Fees", b.fees ? -Math.abs(b.fees) : 0));
  var webStat = document.createElement("span");
  webStat.className = "stat";
  webStat.appendChild(document.createTextNode("Worst / EV / Best: "));
  webStat.appendChild(moneySpan(b.worst_now));
  webStat.appendChild(document.createTextNode(" / "));
  webStat.appendChild(moneySpan(b.ev_now));
  webStat.appendChild(document.createTextNode(" / "));
  webStat.appendChild(moneySpan(b.best_now));
  footRow.appendChild(webStat);
  footRow.appendChild(statEl("Contracts held", fmtNum(b.contracts_held_total)));
  card.appendChild(footRow);

  card.appendChild(buildFillsSection(b));

  return card;
}

function renderLiveBooks() {
  var container = document.getElementById("live-books-list");
  container.innerHTML = "";
  var books = (state.feed && state.feed.books) || [];
  if (!books.length) {
    var p = document.createElement("p");
    p.className = "state-msg";
    p.textContent = "No books are live right now.";
    container.appendChild(p);
    return;
  }
  books.forEach(function (b) { container.appendChild(buildBookCard(b)); });
}

/* -- settled table -- */

function renderSettledTable() {
  var tbody = document.getElementById("settled-tbody");
  tbody.innerHTML = "";
  var rows = state.results.slice().sort(function (a, b) { return new Date(b.settled_time || 0) - new Date(a.settled_time || 0); });
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
    tr2.appendChild(td(r.sport || "-"));
    var resultTd = document.createElement("td");
    resultTd.appendChild(moneySpan(r.realized_pnl));
    tr2.appendChild(resultTd);
    tr2.appendChild(td(r.contracts_sold !== null && r.contracts_sold !== undefined ? fmtNum(r.contracts_sold) : "-"));
    tr2.appendChild(td(r.premium !== null && r.premium !== undefined ? fmtMoney(r.premium) : "-"));
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
  renderHeader();
  renderPurseChart();
  renderSportCards();
  renderLiveBooks();
  renderSettledTable();
}

document.addEventListener("DOMContentLoaded", function () {
  refresh();
  setInterval(refresh, 60000);
  setInterval(function () {
    if (state.feed) updateHeaderTimestamps();
  }, 1000);
});
