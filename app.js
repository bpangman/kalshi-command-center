"use strict";

/* Kalshi Command Center - vanilla JS, no build step.
   Fetches data/feed.json, data/results.json, data/snapshots.json,
   data/calendar.json every 60 seconds and re-renders in place.
   Single-page app with hash routing (#home, #nfl, #nascar, #f1, #golf,
   #calendar) so back/forward and bookmarks work. Plain hyphens only, no
   em/en dashes, anywhere in this file including comments and strings. */

var SPORTS = ["NFL", "NASCAR", "F1", "Golf", "UFC"];
var ROUTES = ["home", "nfl", "nascar", "f1", "golf", "ufc", "calendar"];
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
  UFC: [
    "Every fight becomes seven small markets: how it ends. Each fighter can win by KO/TKO, by submission, or by decision, plus one Draw/No Contest market shared by both.",
    "We sell NO on every one of those seven outcomes, priced off Kalshi's own fight-winner odds times each fighter's own history of how they usually win (or lose), blended with what the crowd is already paying.",
    "Only one outcome can actually happen, so Kalshi only holds our money against the single worst outcome, not all seven added together.",
    "We only trade before the walkout - once the fight starts, every resting order is pulled. There is no in-fight trading in this build.",
    "Each fight is capped at a small fixed dollar loss no matter which way it goes, set before a single order ever posts.",
  ],
};

var state = {
  feed: null,
  results: [],
  snapshots: [],
  calendar: [],
  charts: {},
  tooltipTimers: {},
  eventArchives: {}, // key -> fetched data/events/<key>.json, or "error" on a failed fetch
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

function fmtCents(p, deciCent) {
  // 2026-09-30 deci-cent build (Fix 1e): golf's own tapered_deci_cent
  // markets (KXPGATOUR/KXDPWORLDTOUR) quote real prices down to tenths
  // of a cent (0.2c-1.7c on a thin field) -- whole-cent rounding here
  // collapsed every one of those down to "0c", making a real, correctly
  // quoted sub-cent price look like a bug on the site. deciCent (the
  // book's own is_deci_cent flag from the feed) switches to one decimal
  // place; omitted/false (every NFL/NASCAR call site) is byte-for-byte
  // the original whole-cent display -- margins already show one decimal
  // (fmtMarginCents), this just matches that for the plain price/fair
  // columns on a deci-cent book.
  if (p === null || p === undefined || Number.isNaN(Number(p))) return "-";
  if (deciCent) return (Math.round(Number(p) * 1000) / 10).toFixed(1) + "c";
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

function shortTeamNicknames(title) {
  /* "New England Patriots at Buffalo Bills" -> "Patriots at Bills" - the
     last word of each team name, split on " at " (Blake, 2026-10-02, for
     the sport-page tile grid's compact title). Anything that is not a
     clean two-team " at " title (golf/NASCAR/F1 event names, or an odd
     NFL title) falls back to the full title unchanged. */
  if (!title) return "";
  var parts = String(title).split(" at ");
  if (parts.length !== 2) return title;
  function nickname(full) {
    var words = full.trim().split(/\s+/);
    return words.length ? words[words.length - 1] : "";
  }
  var a = nickname(parts[0]);
  var b = nickname(parts[1]);
  if (!a || !b) return title;
  return a + " at " + b;
}

function shortOutcomeLabel(label) {
  /* "New York Giants wins by 7-14" -> "Giants 7-14" for the tile grid's
     compact outcome strip; a label that does not match the "<team> wins
     by <range>" shape (e.g. "Tie") is already short and passes through. */
  if (!label) return "";
  var m = /^(.*?)\s+wins by\s+(.+)$/i.exec(String(label));
  if (!m) return label;
  var words = m[1].trim().split(/\s+/);
  var nickname = words.length ? words[words.length - 1] : m[1];
  var range = m[2].replace(/\s+points?$/i, "").trim();
  return nickname + " " + range;
}

function formatGameClock(book) {
  /* Blake 2026-10-04: what to print on an in-play tile's badge instead of
     "In play" - how much of the event is left, in that sport's own units.
     Reads book.game_clock (built by the publisher from the bot's own
     event state). Returns a short string, or null when there is nothing
     trustworthy to show (caller then keeps the plain phase text). */
  var gc = book && book.game_clock;
  if (!gc || typeof gc !== "object") return null;
  if (gc.stale) return null; // the bot's feed has stalled - a frozen clock would mislead
  if (gc.final) return "Final";
  var period = (typeof gc.period === "number") ? gc.period : null;
  if (period !== null && period >= 1 && gc.clock) {
    if (period >= 5) return "OT " + gc.clock;
    if (period === 2 && gc.clock === "0:00") return "Halftime";
    return "Q" + period + " " + gc.clock;
  }
  var lapsRem = (typeof gc.laps_remaining === "number") ? gc.laps_remaining : null;
  var lapsTot = (typeof gc.laps_total === "number") ? gc.laps_total : null;
  if (lapsRem !== null && lapsTot !== null && lapsTot > 0) {
    var done = Math.max(0, Math.min(lapsTot, lapsTot - lapsRem));
    return "Lap " + done + " of " + lapsTot;
  }
  if (lapsRem !== null) return lapsRem + " laps to go";
  var pct = null;
  if (typeof gc.round === "number") {
    if (typeof gc.tournament_progress === "number") pct = gc.tournament_progress;
    return "Rd " + gc.round + (pct !== null ? ", " + Math.round(pct * 100) + "% done" : "");
  }
  if (typeof gc.progress === "number") pct = gc.progress;
  else if (typeof gc.tournament_progress === "number") pct = gc.tournament_progress;
  if (pct === null) return null;
  if (pct <= 0) return "Just started";
  return Math.round(pct * 100) + "% done";
}

function phaseBadgeText(b) {
  /* In play with a usable clock: the clock. Everything else (pre-game,
     no event data): exactly the old text. */
  if (b && b.in_play) {
    var t = null;
    try { t = formatGameClock(b); } catch (e) { t = null; }
    if (t) return t;
  }
  return b ? b.phase : "";
}

function gameScoreText(b) {
  /* "NE 29 - BUF 26" (away first), or "" when the score is not known. */
  var gc = b && b.in_play && b.game_clock;
  if (!gc || gc.stale) return "";
  if (typeof gc.home_score !== "number" || typeof gc.away_score !== "number") return "";
  if (!gc.home_code || !gc.away_code) return "";
  return gc.away_code + " " + gc.away_score + " - " + gc.home_code + " " + gc.home_score;
}

function likelihoodSortedOutcomes(b) {
  /* Most-likely-to-win first (Blake, 10/1/26) - shared by the full
     outcome table (buildOutcomeTable) and the tile grid's compact strip
     (buildBookTile), so both pages rank outcomes the same way. */
  var outcomes = (b.outcomes || []).map(function (o, i) { return { o: o, i: i }; });
  function likelihood(o) {
    if (typeof o.win_pct === "number") return o.win_pct;
    if (typeof o.implied_prob === "number") return o.implied_prob * 100;
    return -1;
  }
  // 2026-10-03 fix (Blake): a settled-"no" outcome is dead - Kalshi has
  // a final "no" result for it - so it always sorts after every live
  // outcome, even on a stale read where its win_pct/implied_prob has
  // not caught up to 0 yet. Live outcomes keep their normal order
  // among themselves.
  function deadLast(o) {
    return o.settled === "no" ? 1 : 0;
  }
  outcomes.sort(function (a, c) {
    var deadDiff = deadLast(a.o) - deadLast(c.o);
    if (deadDiff !== 0) return deadDiff;
    var d = likelihood(c.o) - likelihood(a.o);
    return d !== 0 ? d : a.i - c.i;
  });
  return outcomes.map(function (x) { return x.o; });
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
    updateFillsFromFeed();
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
  closeTileModal(); // switching tabs while a tile modal is open would otherwise leave it floating over the wrong page
  closeCalPopover(); // same, for the calendar tab's own popover
  closeSettledModal(); // same, for the settled-event side-by-side modal
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
  // Every page (Home included, 2026-10-02) gets the wider wrapper so a
  // live-book tile grid has room for 4 across.
  var wrapEl = document.querySelector(".wrap");
  if (wrapEl) wrapEl.classList.add("wrap-wide");
}

function renderForRoute(route) {
  if (!state.feed) return;
  if (route === "home") {
    closeTileModal(); // re-render (60s refresh) closes any open tile modal rather than risk showing stale book data
    closeSettledModal();
    renderHomeTiles();
    renderPurseChart();
    // Every live book, every sport, in the same tile grid as the sport
    // pages (Blake, 2026-10-02) - sports mix here so each tile keeps its
    // own sport tag (buildBookTile's opts.showSport).
    var homeLiveBooks = (state.feed && state.feed.books) || [];
    renderLiveBookTileGrid(document.getElementById("live-books-list"), homeLiveBooks, { showSport: true });
    renderAwaitingBlock(document.getElementById("awaiting-block"), awaitingBooks());
  } else if (route === "calendar") {
    renderCalendarPage();
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

function purseDotRadius(count) {
  /* Four steps: one settled event that day, two, three, four or more. */
  if (count >= 4) return 11;
  if (count === 3) return 9;
  if (count === 2) return 7;
  return 4;
}

function buildPurseSeries() {
  /* One point per Central-time day that had at least one settled event; the
     line is the running total after that day. */
  var results = state.results.filter(function (r) { return r.settled_time; });
  results = results.slice().sort(function (a, b) { return new Date(a.settled_time) - new Date(b.settled_time); });
  var days = [];
  var byKey = {};
  results.forEach(function (r) {
    var key = centralDateKey(r.settled_time);
    if (!byKey[key]) {
      var p = key.split("-");
      byKey[key] = { key: key, x: Date.UTC(+p[0], +p[1] - 1, +p[2], 18, 0, 0), total: 0, count: 0 };
      days.push(byKey[key]);
    }
    byKey[key].total += (r.realized_pnl || 0);
    byKey[key].count += 1;
  });
  var cum = 0;
  var solidPoints = days.map(function (d) {
    cum += d.total;
    return { x: d.x, y: round2(cum), dayTotal: round2(d.total), count: d.count };
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
    pointRadius: series.solidPoints.map(function (p) { return purseDotRadius(p.count); }),
    pointHoverRadius: series.solidPoints.map(function (p) { return purseDotRadius(p.count) + 2; }),
    pointHitRadius: 16,
    pointBackgroundColor: series.solidPoints.map(function (p) { return p.dayTotal >= 0 ? "#3fb950" : "#f85149"; }),
    pointBorderColor: "#0d1117",
    pointBorderWidth: 2,
    fill: true,
  }];
  var chart = createLineChart("purse-chart", datasets, function (ctx) {
    /* Hover shows only that day's dollars, no event names. */
    var raw = ctx.raw || {};
    return fmtMoney(raw.dayTotal);
  });
  if (chart) {
    chart.options.interaction = { mode: "nearest", intersect: true };
    chart.options.plugins.tooltip.filter = function (item) { return item.datasetIndex === 0; };
    chart.update();
  }
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
  closeTileModal(); // re-render (60s refresh or a tab switch) closes any open tile modal rather than risk showing stale book data
  closeSettledModal();
  container.innerHTML = "";

  var h2 = document.createElement("h2");
  h2.textContent = sport;
  container.appendChild(h2);

  // Live books as a tile grid, directly under the h2, above the chart and
  // settled table below (which may scroll) - Blake, 2026-10-02: laptop
  // no-scroll for the current 8 NFL games, 4 tiles per row x 2 rows.
  var tileGridWrap = document.createElement("div");
  tileGridWrap.className = "section-block book-tile-grid-wrap";
  container.appendChild(tileGridWrap);
  var liveBooks = ((state.feed && state.feed.books) || []).filter(function (b) { return b.sport === sport; });
  renderLiveBookTileGrid(tileGridWrap, liveBooks);
  var awaitWrap = document.createElement("div");
  awaitWrap.className = "section-block";
  container.appendChild(awaitWrap);
  renderAwaitingBlock(awaitWrap, awaitingBooks(sport));

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

  // Rows are ordered most-likely-to-win first (Blake, 10/1/26): a quiet
  // reorder only, no extra column. Uses the feed's win_pct when present,
  // else the older implied_prob; rows with neither keep their feed order.
  var outcomes = likelihoodSortedOutcomes(b);
  var visible = outcomes.filter(function (o) { return (o.held || 0) > 0 || (o.resting || 0) > 0; });
  var zero = outcomes.filter(function (o) { return !((o.held || 0) > 0) && !((o.resting || 0) > 0); });

  var tbody = document.createElement("tbody");
  var deciCent = !!b.is_deci_cent;
  visible.forEach(function (o) { tbody.appendChild(outcomeRow(o, false, deciCent)); });
  table.appendChild(tbody);

  if (zero.length) {
    var extraBody = document.createElement("tbody");
    extraBody.hidden = true;
    zero.forEach(function (o) { extraBody.appendChild(outcomeRow(o, true, deciCent)); });
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

function outcomeRow(o, dim, deciCent) {
  var tr = document.createElement("tr");
  if (dim) tr.className = "zero-row";
  tr.appendChild(td(o.label));
  tr.appendChild(td(fmtNum(o.held)));
  tr.appendChild(td(fmtNum(o.resting)));
  tr.appendChild(td(o.market_yes_price !== null && o.market_yes_price !== undefined ? fmtCents(o.market_yes_price, deciCent) : "-"));
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

function buildFillsTable(fills, deciCent) {
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
      tr.appendChild(td(fmtCents(f.price, deciCent)));
      tr.appendChild(td(f.fair !== null && f.fair !== undefined ? fmtCents(f.fair, deciCent) : "-"));
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
  details.className = "fills-details";
  var fills = b.recent_fills || [];
  var summary = document.createElement("summary");
  summary.textContent = "Recent fills (" + fills.length + ")";
  details.appendChild(summary);
  details.appendChild(buildFillsTable(fills, !!b.is_deci_cent));
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

/* Tile minimize state (Blake 2026-10-02) - deliberately its own
   localStorage key (kcc_tile_min_, not kcc_collapsed_) so minimizing a
   tile never also collapses that same book's full-card modal, which
   reads getCardCollapsedPref(b.key) independently. Same try/catch
   pattern as the pair above. Default: expanded (shows the full tile). */

function getTileMinimizedPref(key) {
  try {
    var v = localStorage.getItem("kcc_tile_min_" + key);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch (e) {
    /* localStorage unavailable - no stored preference, fall through */
  }
  return null;
}

function setTileMinimizedPref(key, minimized) {
  try {
    localStorage.setItem("kcc_tile_min_" + key, minimized ? "1" : "0");
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
  var titleWrap = document.createElement("span");
  titleWrap.className = "book-head-title-wrap";
  var title = document.createElement("span");
  title.className = "title";
  title.textContent = b.title;
  titleWrap.appendChild(title);
  if (b.subtitle) {
    var cardSubtitle = document.createElement("span");
    cardSubtitle.className = "book-tile-subtitle";
    cardSubtitle.textContent = b.subtitle;
    titleWrap.appendChild(cardSubtitle);
  }
  var sportTag = document.createElement("span");
  sportTag.className = "sport-tag";
  sportTag.textContent = b.sport;
  var phase = document.createElement("span");
  phase.className = "phase-badge " + (b.in_play ? "in-play" : "pre-game");
  phase.textContent = phaseBadgeText(b);
  head.appendChild(dot);
  head.appendChild(titleWrap);
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

/* -- tile modal (sport pages: tapping a tile opens the full card above,
   reusing buildBookCard so nothing from the detailed view is lost) -- */

var tileModal = { open: false, overlay: null, prevFocusEl: null };

function onTileModalKeydown(evt) {
  if (evt.key === "Escape" || evt.key === "Esc") closeTileModal();
}

function closeTileModal() {
  if (!tileModal.open) return;
  if (tileModal.overlay && tileModal.overlay.parentNode) {
    tileModal.overlay.parentNode.removeChild(tileModal.overlay);
  }
  tileModal.overlay = null;
  tileModal.open = false;
  document.body.classList.remove("modal-open");
  document.removeEventListener("keydown", onTileModalKeydown);
  if (tileModal.prevFocusEl && typeof tileModal.prevFocusEl.focus === "function") {
    try { tileModal.prevFocusEl.focus(); } catch (e) { /* element may be gone after a re-render */ }
  }
  tileModal.prevFocusEl = null;
}

function openTileModal(b) {
  closeTileModal();
  tileModal.prevFocusEl = document.activeElement;

  var overlay = document.createElement("div");
  overlay.className = "tile-modal-overlay";
  overlay.addEventListener("click", function (evt) {
    if (evt.target === overlay) closeTileModal();
  });

  var dialog = document.createElement("div");
  dialog.className = "tile-modal-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", b.title + " details");

  var closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tile-modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeTileModal);
  dialog.appendChild(closeBtn);

  dialog.appendChild(buildBookCard(b, { defaultCollapsed: false }));
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  tileModal.overlay = overlay;
  tileModal.open = true;
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onTileModalKeydown);
  closeBtn.focus();
}

/* -- settled event modal (Blake, 2026-10-05: click any settled event, on
   any page, to see where each side's contracts ended up). Same shell
   pattern as the tile modal above (overlay/backdrop, Close button,
   Escape, focus restore, body.modal-open) but its own instance since the
   content is fetched (data/events/<key>.json) instead of built from
   already-loaded feed data. -- */

var settledModal = { open: false, overlay: null, prevFocusEl: null };

function onSettledModalKeydown(evt) {
  if (evt.key === "Escape" || evt.key === "Esc") closeSettledModal();
}

function closeSettledModal() {
  if (!settledModal.open) return;
  if (settledModal.overlay && settledModal.overlay.parentNode) {
    settledModal.overlay.parentNode.removeChild(settledModal.overlay);
  }
  settledModal.overlay = null;
  settledModal.open = false;
  document.body.classList.remove("modal-open");
  document.removeEventListener("keydown", onSettledModalKeydown);
  if (settledModal.prevFocusEl && typeof settledModal.prevFocusEl.focus === "function") {
    try { settledModal.prevFocusEl.focus(); } catch (e) { /* element may be gone after a re-render */ }
  }
  settledModal.prevFocusEl = null;
}

function fetchEventArchive(key) {
  if (state.eventArchives[key] && state.eventArchives[key] !== "error") {
    return Promise.resolve(state.eventArchives[key]);
  }
  return fetchJSON("data/events/" + encodeURIComponent(key) + ".json").then(function (archive) {
    state.eventArchives[key] = archive;
    return archive;
  }).catch(function (err) {
    state.eventArchives[key] = "error";
    throw err;
  });
}

function buildSettledModalHeader(r) {
  var wrap = document.createElement("div");

  var h2 = document.createElement("h2");
  h2.className = "settled-modal-title";
  h2.textContent = r.title || r.event_ticker || "Settled event";
  wrap.appendChild(h2);

  var sub = document.createElement("p");
  sub.className = "settled-modal-sub";
  var subText = "Settled " + (r.settled_time ? new Date(r.settled_time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "date unknown");
  if (r.winner_label) subText += " - winner: " + r.winner_label;
  sub.textContent = subText;
  wrap.appendChild(sub);

  var big = document.createElement("div");
  big.className = "settled-modal-result";
  big.appendChild(moneySpan(r.realized_pnl));
  wrap.appendChild(big);

  var statRow = document.createElement("div");
  statRow.className = "stat-row";
  statRow.appendChild(statMoneyEl("Premium", r.premium));
  statRow.appendChild(statMoneyEl("Fees", r.fees));
  statRow.appendChild(statEl("Contracts sold", r.contracts_sold !== null && r.contracts_sold !== undefined ? fmtNum(r.contracts_sold) : "-"));
  statRow.appendChild(statEl("Bought back", r.contracts_bought_back !== null && r.contracts_bought_back !== undefined ? fmtNum(r.contracts_bought_back) : "-"));
  wrap.appendChild(statRow);

  return wrap;
}

function settledRowHeld(row) {
  if (typeof row.held === "number") return row.held;
  return (row.sell_count || 0) - (row.buy_count || 0);
}

function settledRowNetPremium(row) {
  if (typeof row.net_premium === "number") return row.net_premium;
  return (row.sell_cost || 0) - (row.buy_cost || 0);
}

function settledRowIsWinner(row, hasSchema2, winnerLabel) {
  if (hasSchema2) return row.result === "yes";
  return !!winnerLabel && row.label === winnerLabel;
}

function buildSettledSideRow(row, hasSchema2, winnerLabel) {
  var isWinner = settledRowIsWinner(row, hasSchema2, winnerLabel);
  var tr = document.createElement("tr");
  if (isWinner) tr.className = "settled-side-winner";
  tr.appendChild(td(row.label || row.ticker || ""));
  if (hasSchema2) {
    tr.appendChild(td(isWinner ? "WON" : "lost"));
  }
  tr.appendChild(td(fmtNum(row.sell_count || 0)));
  tr.appendChild(td(fmtNum(row.buy_count || 0)));
  tr.appendChild(td(fmtNum(settledRowHeld(row))));
  var avgTd = document.createElement("td");
  avgTd.textContent = (row.avg_sale_price !== null && row.avg_sale_price !== undefined) ? fmtCents(row.avg_sale_price) : "-";
  tr.appendChild(avgTd);
  var premTd = document.createElement("td");
  premTd.appendChild(moneySpan(settledRowNetPremium(row)));
  tr.appendChild(premTd);
  if (hasSchema2) {
    var ifWonTd = document.createElement("td");
    if (row.book_pnl_if_won !== null && row.book_pnl_if_won !== undefined) ifWonTd.appendChild(moneySpan(row.book_pnl_if_won));
    else ifWonTd.textContent = "-";
    tr.appendChild(ifWonTd);
  }
  return tr;
}

function buildSettledSideTable(archive, r) {
  var hasSchema2 = !!archive && (archive.archive_schema || 0) >= 2;
  var allRows = (archive && archive.final_table) || [];
  var sorted = allRows.slice().sort(function (a, b) { return settledRowHeld(b) - settledRowHeld(a); });
  var shown = sorted.filter(function (row) { return (row.sell_count || 0) > 0.005 || (row.buy_count || 0) > 0.005; });
  var hidden = sorted.filter(function (row) { return !((row.sell_count || 0) > 0.005 || (row.buy_count || 0) > 0.005); });

  var wrap = document.createElement("div");
  wrap.className = "section-block";

  var heading = document.createElement("h3");
  heading.className = "settled-modal-table-heading";
  heading.textContent = "Where each side ended up";
  wrap.appendChild(heading);

  if (!hasSchema2) {
    var note = document.createElement("p");
    note.className = "settled-modal-note";
    note.textContent = "Full side-by-side details fill in after the next data refresh.";
    wrap.appendChild(note);
  }

  var tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  var table = document.createElement("table");
  var thead = document.createElement("thead");
  var headRow = document.createElement("tr");
  var headers = ["Side"];
  if (hasSchema2) headers.push("Result");
  headers.push("Sold", "Bought back", "Held at close", "Avg sale", "Premium");
  if (hasSchema2) headers.push("If this side had won");
  headers.forEach(function (h) {
    var th = document.createElement("th");
    th.setAttribute("scope", "col");
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  var tbody = document.createElement("tbody");
  if (!shown.length && !hidden.length) {
    var emptyRow = document.createElement("tr");
    var emptyCell = document.createElement("td");
    emptyCell.colSpan = headers.length;
    emptyCell.className = "state-msg";
    emptyCell.textContent = "No side details recorded for this event.";
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
  } else {
    shown.forEach(function (row) { tbody.appendChild(buildSettledSideRow(row, hasSchema2, r.winner_label)); });
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  if (hidden.length) {
    var hiddenWrap = document.createElement("div");
    hiddenWrap.className = "table-scroll";
    hiddenWrap.hidden = true;
    var hiddenTable = document.createElement("table");
    var hiddenBody = document.createElement("tbody");
    hidden.forEach(function (row) { hiddenBody.appendChild(buildSettledSideRow(row, hasSchema2, r.winner_label)); });
    hiddenTable.appendChild(hiddenBody);
    hiddenWrap.appendChild(hiddenTable);
    wrap.appendChild(hiddenWrap);

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "show-more-btn";
    var moreText = hidden.length + " more side" + (hidden.length === 1 ? "" : "s") + " with nothing sold";
    toggle.textContent = moreText;
    toggle.addEventListener("click", function () {
      hiddenWrap.hidden = !hiddenWrap.hidden;
      toggle.textContent = hiddenWrap.hidden ? moreText : "Hide those " + hidden.length + " side" + (hidden.length === 1 ? "" : "s");
    });
    wrap.appendChild(toggle);
  }

  return wrap;
}

function renderSettledModalBody(bodyEl, r) {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(buildSettledModalHeader(r));
  var loading = document.createElement("p");
  loading.className = "state-msg";
  loading.textContent = "Loading side details...";
  bodyEl.appendChild(loading);

  fetchEventArchive(r.key).then(function (archive) {
    if (!settledModal.open || settledModal.currentKey !== r.key) return; // closed or replaced while fetching
    loading.remove();
    bodyEl.appendChild(buildSettledSideTable(archive, r));
  }).catch(function () {
    if (!settledModal.open || settledModal.currentKey !== r.key) return;
    loading.className = "state-msg error";
    loading.textContent = "Side details are not available for this event.";
  });
}

function openSettledModal(r) {
  closeSettledModal();
  closeTileModal();
  settledModal.prevFocusEl = document.activeElement;
  settledModal.currentKey = r.key;

  var overlay = document.createElement("div");
  overlay.className = "tile-modal-overlay";
  overlay.addEventListener("click", function (evt) {
    if (evt.target === overlay) closeSettledModal();
  });

  var dialog = document.createElement("div");
  dialog.className = "tile-modal-dialog settled-modal-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", (r.title || r.event_ticker || "Settled event") + " side-by-side details");

  var closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tile-modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeSettledModal);
  dialog.appendChild(closeBtn);

  var body = document.createElement("div");
  body.className = "settled-modal-body";
  dialog.appendChild(body);
  renderSettledModalBody(body, r);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  settledModal.overlay = overlay;
  settledModal.open = true;
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onSettledModalKeydown);
  closeBtn.focus();
}

/* -- live book tile grid (used by sport pages and, since 2026-10-02, by
   Home too - every live book across every sport in one grid there) -- */

function buildTileOutcomeRow(o, deciCent) {
  var row = document.createElement("div");
  row.className = "book-tile-outcome-row";

  var label = document.createElement("span");
  label.className = "ol";
  label.textContent = shortOutcomeLabel(o.label);
  row.appendChild(label);

  var held = document.createElement("span");
  held.className = "oh";
  held.textContent = fmtNum(o.held);
  row.appendChild(held);

  var resting = document.createElement("span");
  resting.className = "or";
  resting.textContent = fmtNum(o.resting);
  row.appendChild(resting);

  var outcomeNow = document.createElement("span");
  outcomeNow.className = "oo " + moneyClass(o.outcome_now);
  outcomeNow.textContent = fmtMoney(o.outcome_now);
  row.appendChild(outcomeNow);

  var price = document.createElement("span");
  price.className = "op";
  price.textContent = (o.market_yes_price !== null && o.market_yes_price !== undefined) ? fmtCents(o.market_yes_price, deciCent) : "-";
  row.appendChild(price);

  return row;
}

function buildBookTile(b, opts) {
  opts = opts || {};
  var stored = getTileMinimizedPref(b.key);
  var minimized = stored !== null ? stored : false; // default expanded

  var tile = document.createElement("div");
  tile.className = "book-tile" + (b.in_play ? " in-play" : "");
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  tile.setAttribute("aria-label", "Open details for " + b.title);

  var row1 = document.createElement("div");
  row1.className = "book-tile-row1";
  var dot = document.createElement("span");
  dot.className = "hb-dot " + hbDotClass(b);
  dot.setAttribute("aria-label", "heartbeat health: " + hbDotClass(b));
  row1.appendChild(dot);
  var titleWrap = document.createElement("span");
  titleWrap.className = "book-tile-title-wrap";
  var titleSpan = document.createElement("span");
  titleSpan.className = "book-tile-title";
  titleSpan.textContent = shortTeamNicknames(b.title);
  titleWrap.appendChild(titleSpan);
  if (b.subtitle) {
    // Short secondary label (UFC: "Method of victory") - only the sports
    // whose data has one show it; everyone else's tile is unchanged.
    var subtitleSpan = document.createElement("span");
    subtitleSpan.className = "book-tile-subtitle";
    subtitleSpan.textContent = b.subtitle;
    titleWrap.appendChild(subtitleSpan);
  }
  row1.appendChild(titleWrap);
  if (opts.showSport) {
    // Home mixes every sport's live books in one grid (Blake, 2026-10-02),
    // so each tile needs its own sport tag - sport pages skip this since
    // the h2 above the grid already names the sport.
    var sportTag = document.createElement("span");
    sportTag.className = "sport-tag";
    sportTag.textContent = b.sport;
    row1.appendChild(sportTag);
  }
  var phase = document.createElement("span");
  phase.className = "phase-badge " + (b.in_play ? "in-play" : "pre-game");
  phase.textContent = phaseBadgeText(b);
  row1.appendChild(phase);

  // Minimize control (Blake 2026-10-02): collapses the tile to just this
  // header row + row2 (title/phase/floor/premium). A real <button> so
  // Enter/Space activate it natively; its own click handler stops
  // propagation so it never also opens the tile's full-card modal.
  var minBtn = document.createElement("button");
  minBtn.type = "button";
  minBtn.className = "book-tile-min-btn";
  row1.appendChild(minBtn);
  tile.appendChild(row1);

  var scoreText = gameScoreText(b);
  if (scoreText) {
    var scoreLine = document.createElement("div");
    scoreLine.className = "book-tile-score";
    scoreLine.textContent = scoreText;
    tile.appendChild(scoreLine);
  }

  var row2 = document.createElement("div");
  row2.className = "book-tile-row2";
  var floorSpan = document.createElement("span");
  floorSpan.className = "book-tile-floor " + moneyClass(b.worst_now);
  floorSpan.appendChild(document.createTextNode(fmtMoney(b.worst_now)));
  var floorLabel = document.createElement("span");
  floorLabel.className = "book-tile-floor-label";
  floorLabel.textContent = "floor";
  floorSpan.appendChild(floorLabel);
  row2.appendChild(floorSpan);
  var smallSpan = document.createElement("span");
  smallSpan.className = "book-tile-row2-small";
  smallSpan.textContent = fmtPlainDollars(b.premium_collected_dollars) + " prem / " + fmtMoney(b.best_now) + " best";
  row2.appendChild(smallSpan);
  tile.appendChild(row2);

  var strip = document.createElement("div");
  strip.className = "book-tile-outcome-strip";
  var deciCent = !!b.is_deci_cent;
  // 2026-10-03 fix (Blake): a settled-"no" outcome (missed-cut golfer,
  // eliminated driver, etc) never belongs in the homepage tile strip's
  // top 7 - skip it before taking the slice, not after, so a live
  // outcome never gets pushed out to make room for a dead one.
  likelihoodSortedOutcomes(b).filter(function (o) { return o.settled !== "no"; }).slice(0, 7).forEach(function (o) {
    strip.appendChild(buildTileOutcomeRow(o, deciCent));
  });
  tile.appendChild(strip);

  var row4 = document.createElement("div");
  row4.className = "book-tile-row4";
  var fillSpan = document.createElement("span");
  fillSpan.textContent = b.last_fill_ts ? ("fill " + timeAgoText(b.last_fill_ts)) : "no fills";
  row4.appendChild(fillSpan);
  var restingSpan = document.createElement("span");
  restingSpan.textContent = "resting " + fmtNum(b.contracts_resting_total);
  row4.appendChild(restingSpan);
  if (b.floor_mode && b.floor_mode.active) {
    var floorTag = document.createElement("span");
    floorTag.className = "floor-mode-tag";
    floorTag.textContent = "floor mode";
    row4.appendChild(floorTag);
  }
  tile.appendChild(row4);

  function applyMinimized(val) {
    tile.classList.toggle("minimized", val);
    minBtn.textContent = val ? "+" : "−"; // "+" to expand, minus sign to minimize
    minBtn.setAttribute("aria-label", (val ? "Expand " : "Minimize ") + b.title);
    minBtn.setAttribute("aria-expanded", String(!val));
  }
  applyMinimized(minimized);

  minBtn.addEventListener("click", function (evt) {
    evt.stopPropagation(); // never also opens the tile's modal
    minimized = !minimized;
    applyMinimized(minimized);
    setTileMinimizedPref(b.key, minimized);
  });

  function activate() { openTileModal(b); }
  tile.addEventListener("click", activate);
  tile.addEventListener("keydown", function (evt) {
    if (evt.target !== tile) return; // let minBtn (and any other nested control) handle its own keys
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      activate();
    }
  });

  return tile;
}

function bookStartMs(b) {
  var t = b && b.start_time ? new Date(b.start_time).getTime() : NaN;
  return isNaN(t) ? Infinity : t;
}

function renderLiveBookTileGrid(container, books, opts) {
  container.innerHTML = "";
  if (!books.length) {
    var p = document.createElement("p");
    p.className = "state-msg";
    p.textContent = "No book is live right now.";
    container.appendChild(p);
    return;
  }
  var grid = document.createElement("div");
  grid.className = "book-tile-grid";
  // Soonest event first (Blake 2026-10-08); books with no start time go last.
  var ordered = books.slice().sort(function (a, c) {
    return (bookStartMs(a) - bookStartMs(c)) || String(a.title || "").localeCompare(String(c.title || ""));
  });
  ordered.forEach(function (b) {
    grid.appendChild(buildBookTile(b, opts));
  });
  container.appendChild(grid);
}

/* remeasureTilesChrome/--tiles-chrome removed 2026-10-02 (Blake): the
   formula measured the grid's offsetTop to guess the viewport height
   available for two rows of tiles, which was wrong on Home (grid sits far
   down the page) and squeezed tiles down to their 240px floor, clipping
   the outcome strip to a tiny scrollable sliver. Tiles are auto-height
   now (see styles.css's .book-tile) - content is never clipped, and a
   short viewport scrolls a little instead. */

/* -- Calendar tab: full month sheet (Blake 2026-10-02) --------------------
   Replaces the old 7-day week row with its own tab (#calendar): a real
   month sheet, 7 columns Sun-Sat, rows = the weeks of the shown month
   (Central time), leading/trailing days from adjacent months greyed,
   today highlighted, prev/next month arrows. Four chip states: LIVE
   (solid, sport-colored, floor shown), SETTLED (muted solid, +/-$
   result, from state.results, any day in the shown month), WATCHLIST
   (dashed outline - listed on Kalshi, no book running yet), and a
   not-yet-listed event (same dashed look, ".not-listed" modifier) paired
   with a small "listing?" marker on its expected-listing day and a
   dotted connector line between the two (drawn as an SVG overlay after
   layout, since the two can land in different week rows). A multi-day
   event (golf) spans its days as one bar across a week row. Builds the
   desktop grid, the phone day list, and the connector overlay from one
   classification pass (classifyCalendarRows) so there is a single source
   of truth; clicking any chip/marker/bar opens the same detail popover. */

var SPORT_COLOR_VAR = { NFL: "--sport-nfl", NASCAR: "--sport-nascar", F1: "--sport-f1", Golf: "--sport-golf", UFC: "--sport-ufc" };
var SPORT_TO_ROUTE = {};
Object.keys(ROUTE_TO_SPORT).forEach(function (route) { SPORT_TO_ROUTE[ROUTE_TO_SPORT[route]] = route; });

// Current month being viewed (1-indexed); null until the first render,
// which defaults it to the current Central month. Deliberately NOT part
// of `state` - it must survive state.calendar being replaced wholesale
// on every 60s refresh, and reset only on a real page load.
var calendarView = { year: null, month: null };

function sportColorVar(sport) {
  return "var(" + (SPORT_COLOR_VAR[sport] || "--muted") + ")";
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function centralTodayYMD() {
  var p = centralDateParts(new Date().toISOString());
  return { y: parseInt(p.year, 10), m: parseInt(p.month, 10), d: parseInt(p.day, 10) };
}

function ymdKey(y, m, d) {
  return y + "-" + pad2(m) + "-" + pad2(d);
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of month m = last day of month m-1 (1-indexed m)
}

function buildMonthGrid(year, month) {
  /* Weeks of `month` (1-indexed) in `year`, Sunday-first, as plain
     UTC-midnight anchors - not real instants, just a clean way to walk
     whole calendar days with no DST edge cases (same trick the old
     week-row view used). Every cell also carries its own weekIdx/dayIdx
     so span bars and the phone list can find "this day's row/column"
     without a separate lookup. */
  var todayYMD = centralTodayYMD();
  var todayKey = ymdKey(todayYMD.y, todayYMD.m, todayYMD.d);
  var firstOfMonth = Date.UTC(year, month - 1, 1);
  var firstWeekday = new Date(firstOfMonth).getUTCDay(); // 0 = Sun
  var totalDaysThisMonth = daysInMonth(year, month);
  var gridStart = firstOfMonth - firstWeekday * 86400000;
  var weekCount = Math.ceil((firstWeekday + totalDaysThisMonth) / 7);
  var weeks = [];
  for (var w = 0; w < weekCount; w++) {
    var week = [];
    for (var d = 0; d < 7; d++) {
      var dt = new Date(gridStart + (w * 7 + d) * 86400000);
      var y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, dd = dt.getUTCDate();
      var key = ymdKey(y, m, dd);
      week.push({ year: y, month: m, day: dd, key: key, inMonth: m === month && y === year, isToday: key === todayKey, weekIdx: w, dayIdx: d });
    }
    weeks.push(week);
  }
  return weeks;
}

function calShortName(row) {
  /* The short, plain name a calendar chip shows (nothing else goes on a
     chip): NFL "Patriots at Bills", NASCAR "Vegas", golf "Bank of Utah",
     F1 "Azerbaijan GP". */
  var t = String(row.title || row.key || "");
  if (row.sport === "NFL") return shortTeamNicknames(t);
  if (row.sport === "NASCAR") return t.replace(/^NASCAR\s+/i, "").replace(/\s+winner$/i, "");
  if (row.sport === "F1") return t.replace(/\s+Grand Prix.*$/i, " GP").replace(/\s+winner$/i, "");
  t = t.replace(/\s+presented by.*$/i, "").replace(/\s+winner$/i, "");
  t = t.replace(/\s+(Championship|Classic|Invitational|Open)$/i, "");
  return t;
}

function classifyCalendarRows(weeks) {
  /* Buckets state.calendar by calendar day for the visible month. Every
     event has up to two chips: "posted" on the Central-time day it was
     first posted on Kalshi (row.posted_iso) and "event" on the day it takes
     place (row.event_iso, else the start / ends-by time). Returns
     dayBuckets[dayKey] = [{type, row}, ...]. */
  var allDayKeys = {};
  weeks.forEach(function (week) {
    week.forEach(function (day) { allDayKeys[day.key] = true; });
  });
  var dayBuckets = {};
  function add(iso, type, row) {
    if (!iso) return;
    var key = centralDateKey(iso);
    if (!allDayKeys[key]) return;
    if (!dayBuckets[key]) dayBuckets[key] = [];
    dayBuckets[key].push({ type: type, row: row });
  }
  var todayKey = (function () { var t = centralTodayYMD(); return ymdKey(t.y, t.m, t.d); })();
  var ours = { live_book: 1, awaiting: 1, settled: 1 };
  (state.calendar || []).forEach(function (r) {
    // Games we never traded drop off once their day has passed.
    var evIso0 = r.event_iso || r.start_iso || r.ends_by_iso;
    if (!ours[r.kind] && evIso0 && centralDateKey(evIso0) < todayKey) return;
    add(r.posted_iso, "posted", r);
    add(r.event_iso || r.start_iso || r.ends_by_iso, "event", r);
  });
  Object.keys(dayBuckets).forEach(function (k) {
    dayBuckets[k].sort(function (a, b) {
      if (a.type !== b.type) return a.type === "event" ? -1 : 1;
      return calShortName(a.row).localeCompare(calShortName(b.row));
    });
  });
  return { dayBuckets: dayBuckets };
}

function buildMonthChip(type, row, booksByKey) {
  var chip = document.createElement("div");
  chip.className = "cal-chip " + type;
  chip.setAttribute("role", "button");
  chip.setAttribute("tabindex", "0");
  var name = calShortName(row);
  chip.textContent = name;
  chip.title = name;
  chip.setAttribute("aria-label", name + (type === "posted" ? ", first posted on Kalshi" : ", event day"));
  function activate() { openCalPopover(row, booksByKey); }
  chip.addEventListener("click", activate);
  chip.addEventListener("keydown", function (evt) {
    if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); activate(); }
  });
  return chip;
}

/* -- calendar detail popover (same overlay/backdrop pattern as
   openTileModal/closeTileModal, a separate state object since a tile
   modal and a calendar popover never need to coexist but should not
   fight over the same open/close bookkeeping) -- */

var calPopover = { open: false, overlay: null, prevFocusEl: null };

function onCalPopoverKeydown(evt) {
  if (evt.key === "Escape" || evt.key === "Esc") closeCalPopover();
}

function closeCalPopover() {
  if (!calPopover.open) return;
  if (calPopover.overlay && calPopover.overlay.parentNode) {
    calPopover.overlay.parentNode.removeChild(calPopover.overlay);
  }
  calPopover.overlay = null;
  calPopover.open = false;
  document.body.classList.remove("modal-open");
  document.removeEventListener("keydown", onCalPopoverKeydown);
  if (calPopover.prevFocusEl && typeof calPopover.prevFocusEl.focus === "function") {
    try { calPopover.prevFocusEl.focus(); } catch (e) { /* element may be gone after a re-render */ }
  }
  calPopover.prevFocusEl = null;
}

function openCalPopoverShell(bodyEl, ariaLabel) {
  closeCalPopover();
  calPopover.prevFocusEl = document.activeElement;

  var overlay = document.createElement("div");
  overlay.className = "tile-modal-overlay cal-popover-overlay";
  overlay.addEventListener("click", function (evt) {
    if (evt.target === overlay) closeCalPopover();
  });

  var dialog = document.createElement("div");
  dialog.className = "tile-modal-dialog cal-popover-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", ariaLabel);

  var closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tile-modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeCalPopover);
  dialog.appendChild(closeBtn);

  dialog.appendChild(bodyEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  calPopover.overlay = overlay;
  calPopover.open = true;
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onCalPopoverKeydown);
  closeBtn.focus();
}

function calRowSourceLabel(row) {
  if (row.kind === "live_book") return "Live book - trading now";
  if (row.kind === "awaiting") return "Finished - waiting for Kalshi to settle";
  if (row.kind === "settled") return "Settled";
  if (row.kind === "candidate") return "Listed on Kalshi - no book running yet";
  if (row.kind === "schedule") return row.source === "espn" ? "From the ESPN NFL schedule" : "From the schedule";
  if (row.kind === "manual") return "From Blake's calendar list";
  return "";
}

function buildCalPopoverBody(row, booksByKey) {
  var wrap = document.createElement("div");
  wrap.className = "cal-popover-body";

  var h3 = document.createElement("h3");
  h3.className = "cal-popover-title";
  h3.textContent = (row.sport ? row.sport + " - " : "") + row.title;
  wrap.appendChild(h3);

  function line(text) {
    var p = document.createElement("p");
    p.className = "cal-popover-line";
    p.textContent = text;
    wrap.appendChild(p);
  }

  var sourceLabel = calRowSourceLabel(row);
  if (sourceLabel) line(sourceLabel);
  if (row.posted_iso) line("First posted on Kalshi " + centralDayLabel(row.posted_iso));
  var evIso = row.event_iso || row.start_iso || row.ends_by_iso;
  if (evIso) line("Event day " + centralDayLabel(evIso));
  else line("Date to be determined");

  if (row.kind === "settled") {
    var res = (state.results || []).filter(function (r) { return r.key === row.key; })[0];
    if (res) {
      var p = document.createElement("p");
      p.className = "cal-popover-line";
      p.appendChild(document.createTextNode("Result: "));
      p.appendChild(moneySpan(res.realized_pnl));
      wrap.appendChild(p);
      /* 2026-10-05 (Blake): the same per-side breakdown the sport pages
         open from their settled tables, reachable from the calendar too. */
      var sidesBtn = document.createElement("button");
      sidesBtn.type = "button";
      sidesBtn.className = "cal-popover-jump-btn";
      sidesBtn.textContent = "Where each side ended up";
      sidesBtn.addEventListener("click", function () {
        closeCalPopover();
        openSettledModal(res);
      });
      wrap.appendChild(sidesBtn);
    }
  }

  if (row.kind === "live_book") {
    var book = booksByKey[row.key];
    if (book) line("Floor right now: " + fmtMoney(book.worst_now));
    var route = SPORT_TO_ROUTE[row.sport];
    if (route) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-popover-jump-btn";
      btn.textContent = "View in " + row.sport + " →";
      btn.addEventListener("click", function () {
        closeCalPopover();
        location.hash = "#" + route;
      });
      wrap.appendChild(btn);
    }
  }

  if (row.note) line("Note: " + row.note);
  return wrap;
}

function buildCalSettledPopoverBody(dayResults) {
  var wrap = document.createElement("div");
  wrap.className = "cal-popover-body";

  var h3 = document.createElement("h3");
  h3.className = "cal-popover-title";
  h3.textContent = "Settled " + centralDayLabel(dayResults[0].settled_time);
  wrap.appendChild(h3);

  dayResults.forEach(function (r) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-popover-line cal-popover-settled-btn";
    btn.appendChild(document.createTextNode((r.title || r.event_ticker || "Event") + ": "));
    btn.appendChild(moneySpan(r.realized_pnl));
    btn.addEventListener("click", function () {
      closeCalPopover();
      openSettledModal(r);
    });
    wrap.appendChild(btn);
  });

  return wrap;
}

function openCalPopover(row, booksByKey) {
  openCalPopoverShell(buildCalPopoverBody(row, booksByKey), row.title + " details");
}

function openCalSettledPopover(dayResults) {
  openCalPopoverShell(buildCalSettledPopoverBody(dayResults), "Settled results");
}

function renderCalendarMonthList(listEl, weeks, classified, booksByKey) {
  listEl.innerHTML = "";
  var any = false;
  weeks.forEach(function (week) {
    week.forEach(function (day) {
      if (!day.inMonth) return;
      var items = classified.dayBuckets[day.key];
      if ((!items || !items.length) && !day.isToday) return; // phones skip empty days
      any = true;
      var section = document.createElement("div");
      section.className = "cal-list-day" + (day.isToday ? " today" : "");
      var head = document.createElement("div");
      head.className = "cal-list-day-head";
      head.textContent = centralDayLabel(day.key + "T12:00:00Z") + (day.isToday ? " - today" : "");
      section.appendChild(head);
      if (!items || !items.length) {
        var empty = document.createElement("p");
        empty.className = "cal-day-empty";
        empty.textContent = "Nothing today";
        section.appendChild(empty);
      } else {
        items.forEach(function (item) { section.appendChild(buildMonthChip(item.type, item.row, booksByKey)); });
      }
      listEl.appendChild(section);
    });
  });
  if (!any) {
    var none = document.createElement("p");
    none.className = "cal-day-empty";
    none.textContent = "Nothing this month";
    listEl.appendChild(none);
  }
}

function renderCalendarPage() {
  closeCalPopover(); // periodic refresh (or a month nav) rebuilds the grid - never leave a popover pointing at stale data
  closeSettledModal();
  var grid = document.getElementById("cal-month-grid");
  var listEl = document.getElementById("cal-month-list");
  var legendEl = document.getElementById("cal-month-legend");
  var labelEl = document.getElementById("cal-month-label");
  if (!grid || !state.feed) return;

  if (calendarView.year === null) {
    var t = centralTodayYMD();
    calendarView.year = t.y;
    calendarView.month = t.m;
  }

  var weeks = buildMonthGrid(calendarView.year, calendarView.month);
  var classified = classifyCalendarRows(weeks);
  var booksByKey = {};
  ((state.feed && state.feed.books) || []).forEach(function (b) { booksByKey[b.key] = b; });

  labelEl.textContent = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(calendarView.year, calendarView.month - 1, 1)));

  grid.innerHTML = "";
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(function (lbl, i) {
    var head = document.createElement("div");
    head.className = "cal-month-dow";
    head.style.gridColumn = String(i + 1);
    head.textContent = lbl;
    grid.appendChild(head);
  });

  weeks.forEach(function (week, wi) {
    week.forEach(function (day, di) {
      var cell = document.createElement("div");
      cell.className = "cal-month-cell" + (day.isToday ? " today" : "") + (day.inMonth ? "" : " outside");
      cell.style.gridColumn = String(di + 1);
      cell.style.gridRow = String(wi + 2);
      var num = document.createElement("div");
      num.className = "cal-month-cell-num";
      num.textContent = String(day.day);
      cell.appendChild(num);
      (classified.dayBuckets[day.key] || []).forEach(function (item) {
        cell.appendChild(buildMonthChip(item.type, item.row, booksByKey));
      });
      grid.appendChild(cell);
    });
  });

  renderCalendarMonthList(listEl, weeks, classified, booksByKey);

  legendEl.innerHTML = "";
  function legendItem(cls, text) {
    var sw = document.createElement("span");
    sw.className = "cal-legend-swatch " + cls;
    legendEl.appendChild(sw);
    var label = document.createElement("span");
    label.className = "cal-legend-label";
    label.textContent = text;
    legendEl.appendChild(label);
  }
  legendItem("posted", "First posted on Kalshi");
  legendItem("event", "Event day");
}

function shiftCalendarMonth(delta) {
  if (calendarView.year === null) {
    var t = centralTodayYMD();
    calendarView.year = t.y;
    calendarView.month = t.m;
  }
  var m = calendarView.month + delta;
  var y = calendarView.year;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  calendarView.year = y;
  calendarView.month = m;
  renderCalendarPage();
}

var calendarResizeTimer = null;

function initCalendarNav() {
  var prevBtn = document.getElementById("cal-prev-month");
  var nextBtn = document.getElementById("cal-next-month");
  if (prevBtn) prevBtn.addEventListener("click", function () { shiftCalendarMonth(-1); });
  if (nextBtn) nextBtn.addEventListener("click", function () { shiftCalendarMonth(1); });
  window.addEventListener("resize", function () {
    if (currentRoute() !== "calendar") return;
    if (calendarResizeTimer) clearTimeout(calendarResizeTimer);
    calendarResizeTimer = setTimeout(renderCalendarPage, 150);
  });
}

/* -- finished books waiting for Kalshi to settle (feed.awaiting) -- */

function awaitingBooks(sport) {
  var list = (state.feed && state.feed.awaiting) || [];
  return sport ? list.filter(function (b) { return b.sport === sport; }) : list;
}

function awaitingHeadline(b) {
  var info = b.awaiting_info || {};
  if (b.liveness === "stalled") return "Bot has not checked in - last result below is from its last good read";
  if (info.likely_winner && info.result_if_likely_wins !== null && info.result_if_likely_wins !== undefined) {
    return "Likely " + info.likely_winner + " (" + Math.round(info.likely_win_pct || 0) + "%)";
  }
  return "Waiting for Kalshi to pay out";
}

function renderAwaitingBlock(container, books) {
  container.innerHTML = "";
  container.hidden = !books.length;
  if (!books.length) return;
  var h2 = document.createElement("h2");
  h2.textContent = "Finished, waiting for Kalshi to settle";
  container.appendChild(h2);
  var grid = document.createElement("div");
  grid.className = "awaiting-grid";
  books.forEach(function (b) {
    var info = b.awaiting_info || {};
    var card = document.createElement("div");
    card.className = "awaiting-card";
    var title = document.createElement("div");
    title.className = "awaiting-title";
    title.textContent = (b.sport && String(b.title).indexOf(b.sport) !== 0 ? b.sport + " - " : "") + b.title;
    card.appendChild(title);
    var badge = document.createElement("span");
    badge.className = "badge awaiting-badge";
    badge.textContent = b.liveness === "stalled" ? "Not checking in" : "Awaiting settlement";
    card.appendChild(badge);
    var big = document.createElement("div");
    big.className = "awaiting-big";
    var shown = (info.result_if_likely_wins !== null && info.result_if_likely_wins !== undefined) ? info.result_if_likely_wins : b.worst_now;
    big.appendChild(moneySpan(shown));
    card.appendChild(big);
    var sub = document.createElement("div");
    sub.className = "awaiting-sub";
    sub.textContent = awaitingHeadline(b);
    card.appendChild(sub);
    var floor = document.createElement("div");
    floor.className = "awaiting-sub";
    floor.appendChild(document.createTextNode("Worst case "));
    floor.appendChild(moneySpan(b.worst_now));
    floor.appendChild(document.createTextNode(" - best case "));
    floor.appendChild(moneySpan(b.best_now));
    card.appendChild(floor);
    var note = document.createElement("div");
    note.className = "awaiting-sub";
    note.textContent = "This is what our held positions are worth now. The exact result replaces it once Kalshi settles.";
    card.appendChild(note);
    grid.appendChild(card);
  });
  container.appendChild(grid);
}

/* -- settled table (per sport page) -- */

function renderSettledTable(tbody, sport) {
  tbody.innerHTML = "";
  awaitingBooks(sport).forEach(function (b) {
    var info = b.awaiting_info || {};
    var tr0 = document.createElement("tr");
    tr0.className = "awaiting-row";
    tr0.appendChild(td("Awaiting settlement"));
    tr0.appendChild(td(b.title));
    var r0 = document.createElement("td");
    var shown = (info.result_if_likely_wins !== null && info.result_if_likely_wins !== undefined) ? info.result_if_likely_wins : b.worst_now;
    r0.appendChild(moneySpan(shown));
    r0.appendChild(document.createTextNode(" (" + awaitingHeadline(b).toLowerCase() + ")"));
    tr0.appendChild(r0);
    tr0.appendChild(td(b.contracts_sold_total !== null && b.contracts_sold_total !== undefined ? fmtNum(b.contracts_sold_total) : "-"));
    tr0.appendChild(td(b.premium_collected_dollars !== null && b.premium_collected_dollars !== undefined ? fmtMoney(b.premium_collected_dollars) : "-"));
    var c0 = document.createElement("td");
    if (b.net_collected_dollars !== null && b.net_collected_dollars !== undefined) c0.appendChild(moneySpan(b.net_collected_dollars));
    else c0.textContent = "-";
    tr0.appendChild(c0);
    tbody.appendChild(tr0);
  });
  var rows = state.results.filter(function (r) { return r.sport === sport; })
    .sort(function (a, b) { return new Date(b.settled_time || 0) - new Date(a.settled_time || 0); });
  if (!rows.length) {
    if (awaitingBooks(sport).length) return;
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
    tr2.className = "settled-row";
    tr2.setAttribute("role", "button");
    tr2.setAttribute("tabindex", "0");
    tr2.setAttribute("aria-label", "View side-by-side details for " + (r.title || r.event_ticker || "this event"));
    tr2.appendChild(td(r.settled_time ? new Date(r.settled_time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "-"));
    var eventTd = document.createElement("td");
    eventTd.appendChild(document.createTextNode(r.title || r.event_ticker));
    var chevron = document.createElement("span");
    chevron.className = "settled-row-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";
    eventTd.appendChild(chevron);
    tr2.appendChild(eventTd);
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
    tr2.addEventListener("click", function () { openSettledModal(r); });
    tr2.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter" || evt.key === " " || evt.key === "Spacebar") {
        evt.preventDefault();
        openSettledModal(r);
      }
    });
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

/* -- live fills drawer (Blake 2026-10-04) -- */

var FILLS_STORE_KEY = "kcc_fills_v1";
var FILLS_OPEN_KEY = "kcc_fills_open";
var FILLS_SPORT_KEY = "kcc_fills_sport";
var FILLS_MAX_ROWS = 300;
var FILLS_SPORT_ORDER = ["NFL", "NASCAR", "F1", "Golf", "UFC"];
var fillsState = { rows: [], keys: {}, open: false, unread: 0, loaded: false, newKeys: {}, sport: "all" };

function fillRowKey(bookKey, f) {
  return [bookKey, f.ts, f.label, f.count, f.price].join("|");
}

function fillTs(row) {
  var t = Date.parse(row.ts);
  return isNaN(t) ? 0 : t;
}

function loadFillsFromStorage() {
  fillsState.loaded = true;
  try {
    var raw = localStorage.getItem(FILLS_STORE_KEY);
    if (!raw) return;
    var arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    arr.forEach(function (r) {
      if (r && r.k && !fillsState.keys[r.k]) {
        fillsState.keys[r.k] = true;
        fillsState.rows.push(r);
      }
    });
  } catch (e) {
    /* storage blocked or corrupt - start with an empty list */
  }
}

function mergeFills(feed) {
  /* Folds every book's recent_fills into one list, newest first, deduped,
     capped. Returns how many rows were new this pass. */
  if (!fillsState.loaded) loadFillsFromStorage();
  var firstEver = fillsState.rows.length === 0;
  var added = 0;
  var newKeys = {};
  var books = (feed && Array.isArray(feed.books)) ? feed.books : [];
  books.forEach(function (b) {
    if (!b || !Array.isArray(b.recent_fills)) return;
    b.recent_fills.forEach(function (f) {
      if (!f || !f.ts) return;
      var k = fillRowKey(b.key, f);
      if (fillsState.keys[k]) return;
      fillsState.keys[k] = true;
      fillsState.rows.push({
        k: k, bk: b.key, title: b.title || "", sport: b.sport || "",
        ts: f.ts, label: f.label || "", side: f.side || "sell",
        count: f.count, price: f.price, fair: f.fair, margin_cents: f.margin_cents
      });
      newKeys[k] = true;
      added++;
    });
  });
  if (added > 0) {
    fillsState.rows.sort(function (a, b) { return fillTs(b) - fillTs(a); });
    if (fillsState.rows.length > FILLS_MAX_ROWS) {
      fillsState.rows.slice(FILLS_MAX_ROWS).forEach(function (r) { delete fillsState.keys[r.k]; });
      fillsState.rows.length = FILLS_MAX_ROWS;
    }
    try {
      localStorage.setItem(FILLS_STORE_KEY, JSON.stringify(fillsState.rows));
    } catch (e) { /* nothing to persist to */ }
  }
  // The very first load just seeds the list; it is not "new" activity.
  fillsState.newKeys = firstEver ? {} : newKeys;
  if (!firstEver && !fillsState.open) fillsState.unread += added;
  return added;
}

function fmtFillPrice(p) {
  var n = Number(p);
  if (p === null || p === undefined || isNaN(n)) return "-";
  var s = n.toFixed(3);
  if (s.charAt(s.length - 1) === "0") s = n.toFixed(2);
  return s;
}

function fmtFillCount(c) {
  var n = Number(c);
  if (c === null || c === undefined || isNaN(n)) return "-";
  return (Math.abs(n - Math.round(n)) < 1e-9) ? String(Math.round(n)) : n.toFixed(1);
}

function fillTimeCT(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "--:--:--";
  var parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
    .formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
  return (parts.hour || "") + ":" + (parts.minute || "") + ":" + (parts.second || "");
}

function fillBookName(r) {
  var t = r.title ? shortTeamNicknames(r.title) : "";
  return t || r.sport || r.bk || "";
}

function buildFillRow(r) {
  var row = document.createElement("div");
  var buyback = r.side === "buyback";
  row.className = "fill-row" + (buyback ? " buyback" : "") + (fillsState.newKeys[r.k] ? " fill-new" : "");

  var top = document.createElement("div");
  top.className = "fill-row-top";
  var time = document.createElement("span");
  time.className = "fill-time";
  time.textContent = fillTimeCT(r.ts);
  var book = document.createElement("span");
  book.className = "fill-book";
  book.textContent = fillBookName(r);
  top.appendChild(time);
  top.appendChild(book);
  var m = Number(r.margin_cents);
  if (r.margin_cents !== null && r.margin_cents !== undefined && !isNaN(m)) {
    var margin = document.createElement("span");
    margin.className = "fill-margin " + (m > 0 ? "pos" : (m < 0 ? "neg" : "zero"));
    margin.textContent = (m > 0 ? "+" : "") + (Math.round(m * 10) / 10) + "c vs fair";
    top.appendChild(margin);
  }
  row.appendChild(top);

  var main = document.createElement("div");
  main.className = "fill-row-main";
  var label = document.createElement("span");
  label.className = "fill-label";
  label.textContent = shortOutcomeLabel(r.label);
  var what = document.createElement("span");
  what.className = "fill-what";
  what.textContent = (buyback ? "bought back " : "sold ") + fmtFillCount(r.count) + " @ " + fmtFillPrice(r.price);
  main.appendChild(label);
  main.appendChild(what);
  row.appendChild(main);
  return row;
}

function fillsSportList() {
  var seen = {};
  fillsState.rows.forEach(function (r) {
    var s = r.sport;
    if (s) seen[s] = true;
  });
  var ordered = [];
  FILLS_SPORT_ORDER.forEach(function (s) {
    if (seen[s]) {
      ordered.push(s);
      delete seen[s];
    }
  });
  var rest = Object.keys(seen).sort();
  return ordered.concat(rest);
}

function fillMatchesSport(r) {
  if (fillsState.sport === "all") return true;
  return String(r.sport || "").toLowerCase() === String(fillsState.sport).toLowerCase();
}

function renderFillsFilter() {
  var el = document.getElementById("fills-filter");
  if (!el) return;
  el.textContent = "";
  if (!fillsState.rows.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  var sports = fillsSportList();
  if (fillsState.sport !== "all" && sports.indexOf(fillsState.sport) === -1) {
    sports.push(fillsState.sport);
  }
  var options = ["all"].concat(sports);
  options.forEach(function (value) {
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "fills-chip";
    chip.textContent = value === "all" ? "All" : value;
    var active = fillsState.sport === value;
    if (active) chip.classList.add("active");
    chip.setAttribute("aria-pressed", active ? "true" : "false");
    chip.addEventListener("click", function () {
      fillsState.sport = value;
      try {
        localStorage.setItem(FILLS_SPORT_KEY, value);
      } catch (e) { /* not persisted */ }
      renderFillsDrawer();
    });
    el.appendChild(chip);
  });
}

function updateFillsBubble() {
  var bubble = document.getElementById("fills-unread");
  if (!bubble) return;
  var n = fillsState.unread;
  bubble.hidden = !(n > 0 && !fillsState.open);
  bubble.textContent = n > 99 ? "99+" : String(n);
}

function renderFillsDrawer() {
  renderFillsFilter();
  var list = document.getElementById("fills-list");
  if (!list) return;
  list.textContent = "";
  if (!fillsState.rows.length) {
    var empty = document.createElement("p");
    empty.className = "fills-empty";
    empty.textContent = "No fills yet. New ones show up here as they come in.";
    list.appendChild(empty);
  } else {
    var filtered = fillsState.rows.filter(fillMatchesSport);
    if (!filtered.length) {
      var noneForSport = document.createElement("p");
      noneForSport.className = "fills-empty";
      noneForSport.textContent = "No " + fillsState.sport + " fills yet.";
      list.appendChild(noneForSport);
    } else {
      var frag = document.createDocumentFragment();
      filtered.forEach(function (r) { frag.appendChild(buildFillRow(r)); });
      list.appendChild(frag);
    }
  }
  updateFillsBubble();
}

function setFillsOpen(open) {
  fillsState.open = !!open;
  document.body.classList.toggle("fills-open", fillsState.open);
  var drawer = document.getElementById("fills-drawer");
  var btn = document.getElementById("fills-toggle");
  if (drawer) drawer.setAttribute("aria-hidden", fillsState.open ? "false" : "true");
  if (btn) btn.setAttribute("aria-expanded", fillsState.open ? "true" : "false");
  if (fillsState.open) {
    fillsState.unread = 0;
    fillsState.newKeys = {};
  }
  updateFillsBubble();
  try {
    localStorage.setItem(FILLS_OPEN_KEY, fillsState.open ? "1" : "0");
  } catch (e) { /* not persisted */ }
}

function initFillsDrawer() {
  var btn = document.getElementById("fills-toggle");
  var closeBtn = document.getElementById("fills-close");
  var backdrop = document.getElementById("fills-backdrop");
  if (!btn || !document.getElementById("fills-drawer")) return;
  btn.addEventListener("click", function () { setFillsOpen(!fillsState.open); });
  if (closeBtn) closeBtn.addEventListener("click", function () { setFillsOpen(false); });
  if (backdrop) backdrop.addEventListener("click", function () { setFillsOpen(false); });
  document.addEventListener("keydown", function (evt) {
    if ((evt.key === "Escape" || evt.key === "Esc") && fillsState.open && !tileModal.open) setFillsOpen(false);
  });
  var wasOpen = false;
  try { wasOpen = localStorage.getItem(FILLS_OPEN_KEY) === "1"; } catch (e) { wasOpen = false; }
  if (!fillsState.loaded) loadFillsFromStorage();
  try { var s = localStorage.getItem(FILLS_SPORT_KEY); if (s) fillsState.sport = s; } catch (e) {}
  setFillsOpen(wasOpen);
  renderFillsDrawer();
}

function updateFillsFromFeed() {
  try {
    mergeFills(state.feed);
    renderFillsDrawer();
  } catch (e) {
    /* the drawer is a nicety - never let it break the main refresh */
  }
}

/* -- top-level render -- */

function renderAll() {
  updateHeaderTimestamps();
  renderForRoute(currentRoute());
}

document.addEventListener("DOMContentLoaded", function () {
  applyRoute(currentRoute());
  initGlobalTooltipDismissal();
  initCalendarNav();
  initFillsDrawer();
  refresh();
  setInterval(refresh, 60000);
  setInterval(function () {
    if (state.feed) updateHeaderTimestamps();
  }, 1000);
});
