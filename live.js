"use strict";

/* LIVE tab (Blake, 2026-10-14) - vanilla JS, no build step. Loaded after
   app.js and uses its globals (state, fetchJSON, buildBookTile,
   buildFillsTable, timeAgoText). Reworked 2026-10-15 (Blake): the page is
   a grid of the same small book tiles as Home; under each tile sits that
   book's live feed in a box with the same width and height as the tile.
   Clicking a tile opens a fills drop-down under it. Inside the box: a
   slim header (Plan toggle, Audits button), the scrolling feed, and a
   one-line chat row pinned at the bottom that talks to the operator
   through ntfy.sh (see tools/live/README-LIVE.md section 4 in the main
   repo for the wire contract - unchanged). Plain hyphens only, no em/en dashes, anywhere in this file. */

(function () {
  var POLL_MS = 30000;
  var MAX_ITEMS = 400;
  var FLEET = "_fleet";
  var LS_PASS = "kcc_live_passcode";
  var LS_PENDING = "kcc_live_pending";
  var LS_DECIDED = "kcc_live_decided";
  var LS_SEEN = "kcc_live_audit_seen_";
  var NO_ANSWER_HINT_MS = 45000;
  var BOX_GROW = 1.3; // the feed box is this much taller than its tile, so more of the feed and plan text shows at once
  var MIN_BOX_H = 250; // px - smallest feed box (and tile) height, so header + feed + chat row always fit
  var NTFY = "https://ntfy.sh/";
  var TERMINAL = { answer: 1, proposal: 1, done: 1, error: 1, cancelled: 1 };
  var STATUS_LABEL = { received: "Received", working: "Working", answer: "Answer", proposal: "Proposal", done: "Done", error: "Error", cancelled: "Cancelled" };

  var L = {
    active: false,
    pollTimer: null,
    tickTimer: null,
    root: null,
    index: null, // last good data/live/index.json (or an empty stand-in)
    sigs: {}, // key -> signature of the index entry the cached file was fetched for
    files: {}, // key -> parsed data/live/<key>.json
    blocks: {}, // key -> block object
    baseAudit: null, // key -> last audit_last_ts seen in the index (null until first poll)
    banners: {}, // key -> banner element
    pending: [], // commands Blake sent from this browser
    replies: {}, // reply id -> live reply from ntfy
    decided: {}, // proposal id -> "confirm" | "cancel"
    keys: null, // { cmdTopic, replyTopic, hmacKey } once a passcode exists
    es: null,
    esTopic: null,
    qIndex: null, // last good data/queue/index.json
    qFiles: {}, // key -> parsed data/queue/<key>.json
    qSigs: {}, // key -> ts of the cached file
  };

  /* -- small helpers -- */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked - the page still works */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  function lsGetJSON(k, fallback) {
    var raw = lsGet(k);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var CT_FMT = null;
  try {
    CT_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit", hour12: true });
  } catch (e) { CT_FMT = null; }

  function ctStamp(ms) {
    /* "Thu 3:42 PM" in Central time. Built from parts so a newer browser's
       narrow no-break space before PM never sneaks in. */
    if (!isFinite(ms)) return "";
    if (!CT_FMT) return new Date(ms).toLocaleString();
    var p = {};
    CT_FMT.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return p.weekday + " " + p.hour + ":" + p.minute + " " + String(p.dayPeriod || "").toUpperCase();
  }

  function parseMs(iso) {
    var t = iso ? new Date(iso).getTime() : NaN;
    return isNaN(t) ? NaN : t;
  }

  /* Actual Central clock times, never T-minus. "3:15pm CT" when the time is on
     the same Central day as now, "Sat 9:00am CT" otherwise. */
  var CT_CLOCK = null;
  var CT_DAY = null;
  try {
    CT_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit", hour12: true });
    CT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
  } catch (e) { CT_CLOCK = null; CT_DAY = null; }

  function ctClock(ms, refMs) {
    if (!isFinite(ms) || !CT_CLOCK || !CT_DAY) return "";
    var p = {};
    CT_CLOCK.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    var clock = p.hour + ":" + p.minute + String(p.dayPeriod || "").toLowerCase() + " CT";
    var sameDay = isFinite(refMs) && CT_DAY.format(new Date(ms)) === CT_DAY.format(new Date(refMs));
    return sameDay ? clock : p.weekday + " " + clock;
  }

  /* Any "T-240" that still reaches the page (older posts, auditor text) is
     shown as the clock time that many minutes before the event start. */
  function clockify(text, startMs) {
    if (typeof text !== "string" || text.indexOf("T-") < 0) return text;
    return text.replace(/\bT-(\d+)(?:\.\d+)?\b/g, function (m, n) {
      if (!isFinite(startMs) || !CT_CLOCK) return n + " min before the start";
      return ctClock(startMs - Number(n) * 60000, Date.now());
    });
  }

  function startMsFor(key) {
    var e = entryFor(key);
    return e && e.start_time ? parseMs(e.start_time) : NaN;
  }

  function countdownText(iso) {
    var ms = parseMs(iso) - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "now";
    var s = Math.floor(ms / 1000);
    if (s < 60) return "in " + s + "s";
    var m = Math.floor(s / 60);
    if (m < 10) return "in " + m + "m " + (s % 60) + "s";
    if (m < 60) return "in " + m + "m";
    var h = Math.floor(m / 60);
    if (h < 48) return "in " + h + "h " + (m % 60) + "m";
    var d = Math.floor(h / 24);
    return "in " + d + "d " + (h % 24) + "h";
  }

  function agoText(iso) {
    return "updated " + timeAgoText(iso);
  }

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function bookLabel(key) {
    return key === FLEET ? "the whole fleet" : key;
  }

  /* -- crypto (README-LIVE section 4) -- */

  var ENC = new TextEncoder();

  function toHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }

  function sha256(str) {
    return crypto.subtle.digest("SHA-256", ENC.encode(str));
  }

  function normalizePass(pass) {
    return String(pass || "").trim().toLowerCase();
  }

  function deriveKeys(pass) {
    var base = normalizePass(pass);
    return Promise.all([sha256("kcc-cmd|" + base), sha256("kcc-rep|" + base), sha256("kcc-key|" + base)]).then(function (h) {
      return crypto.subtle.importKey("raw", h[2], { name: "HMAC", hash: "SHA-256" }, false, ["sign"]).then(function (hmacKey) {
        return {
          cmdTopic: "kcc-c-" + toHex(h[0]).slice(0, 32),
          replyTopic: "kcc-r-" + toHex(h[1]).slice(0, 32),
          hmacKey: hmacKey,
        };
      });
    });
  }

  function signPayload(keys, p) {
    var msg = [1, p.id, p.ts, p.book, p.type, p.ref, p.text].join("|");
    return crypto.subtle.sign("HMAC", keys.hmacKey, ENC.encode(msg)).then(function (sig) {
      return { v: 1, id: p.id, ts: p.ts, book: p.book, type: p.type, ref: p.ref, text: p.text, sig: toHex(sig) };
    });
  }

  /* -- data fetch -- */

  function isNotFound(err) {
    return err && /returned 404/.test(String(err.message || err));
  }

  function entrySig(e) {
    return [e.plan_ts, e.last_post_ts, e.post_count, e.audit_count, e.audit_last_ts, e.live].join("|");
  }

  function poll() {
    if (!L.active || document.hidden) return Promise.resolve();
    pollQueue();
    return fetchJSON("data/live/index.json").then(function (idx) {
      return idx;
    }, function (err) {
      if (isNotFound(err)) return { books: [], fleet: null };
      throw err;
    }).then(function (idx) {
      var books = Array.isArray(idx.books) ? idx.books : [];
      var entries = books.map(function (b) { return { key: b.key, entry: b }; });
      var fleet = idx.fleet;
      if (fleet && ((fleet.post_count || 0) > 0 || (fleet.audit_count || 0) > 0)) {
        entries.push({ key: FLEET, entry: fleet });
      }
      var fetches = entries.map(function (x) {
        var sig = entrySig(x.entry);
        if (L.files[x.key] !== undefined && L.sigs[x.key] === sig) return Promise.resolve();
        return fetchJSON("data/live/" + encodeURIComponent(x.key) + ".json").then(function (data) {
          L.files[x.key] = data;
          L.sigs[x.key] = sig;
        }, function (err) {
          if (isNotFound(err) && L.files[x.key] === undefined) {
            L.files[x.key] = null;
            L.sigs[x.key] = sig;
          }
          /* any other failure: keep whatever we had */
        });
      });
      return Promise.all(fetches).then(function () {
        detectNewAudits(entries);
        L.index = idx;
        renderLive();
      });
    }).catch(function () {
      /* index unreachable: keep showing what we have; the next poll retries */
      if (!L.index) {
        L.index = { books: [], fleet: null };
        renderLive();
      }
    });
  }

  /* -- audit bookkeeping -- */

  function seenTs(key) {
    return lsGet(LS_SEEN + key) || "";
  }

  function latestAuditTs(key) {
    var f = L.files[key];
    var best = "";
    if (f && Array.isArray(f.audits) && f.audits.length) best = f.audits[f.audits.length - 1].ts || "";
    var e = entryFor(key);
    if (e && e.audit_last_ts && e.audit_last_ts > best) best = e.audit_last_ts;
    return best;
  }

  function hasUnseenAudit(key) {
    var last = latestAuditTs(key);
    return !!last && last > seenTs(key);
  }

  function markAuditsSeen(key) {
    var last = latestAuditTs(key);
    if (last) lsSet(LS_SEEN + key, last);
  }

  function entryFor(key) {
    if (!L.index) return null;
    if (key === FLEET) return L.index.fleet || null;
    var list = L.index.books || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function detectNewAudits(entries) {
    var first = L.baseAudit === null;
    if (first) L.baseAudit = {};
    entries.forEach(function (x) {
      var ts = x.entry.audit_last_ts || "";
      var prev = L.baseAudit[x.key];
      if (!first && ts && ts > (prev || "") && ts > seenTs(x.key)) {
        var b = L.blocks[x.key];
        if (!(b && b.drawerOpen)) addBanner(x.key);
      }
      L.baseAudit[x.key] = ts;
    });
  }

  function addBanner(key) {
    if (L.banners[key] || !L.root) return;
    var bar = el("div", "lv-banner");
    bar.setAttribute("role", "status");
    bar.appendChild(el("span", "lv-banner-text", "New audit alert on " + bookLabel(key)));
    var view = el("button", "lv-btn lv-btn-small", "View");
    view.type = "button";
    view.addEventListener("click", function () {
      var b = L.blocks[key];
      removeBanner(key);
      if (!b) return;
      setDrawer(b, true);
      b.el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    var close = el("button", "lv-banner-x", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", function () { removeBanner(key); });
    bar.appendChild(view);
    bar.appendChild(close);
    L.banners[key] = bar;
    var holder = L.root.querySelector(".lv-banners");
    var top = document.querySelector(".topbar");
    if (top) holder.style.top = (top.offsetHeight + 8) + "px"; // stay visible just under the sticky header
    holder.appendChild(bar);
  }

  function removeBanner(key) {
    var b = L.banners[key];
    if (b && b.parentNode) b.parentNode.removeChild(b);
    delete L.banners[key];
  }

  /* -- ordering -- */

  function startMs(b) {
    var t = b && b.start_time ? new Date(b.start_time).getTime() : NaN;
    return isNaN(t) ? Infinity : t;
  }

  function shownBooks(list) {
    /* Same rule as Home: soonest event first, no start time goes last. Only
       books that are live (or that Home would show a tile for) appear. */
    return list.filter(function (e) { return e.live || feedBookFor(e.key); }).sort(function (a, c) {
      var ta = feedBookFor(a.key) || a, tc = feedBookFor(c.key) || c;
      return (startMs(ta) - startMs(tc)) || String(a.title || a.key).localeCompare(String(c.title || c.key));
    });
  }

  /* -- feed items -- */

  function fromPost(p) {
    var d = p.data || {};
    var it = { key: "p:" + p.id, ts: parseMs(p.ts), iso: p.ts, kind: p.kind, severity: p.severity || "info", title: p.title || "", text: p.text || "" };
    if (p.kind === "chat_out") {
      it.status = d.status || "answer";
      it.proposal = d.proposal || null;
      it.inReplyTo = d.in_reply_to || "";
    }
    return it;
  }

  function fromReply(r) {
    return {
      key: "r:" + r.id, ts: r.ts, iso: new Date(r.ts).toISOString(), kind: "chat_out", severity: r.status === "error" ? "warn" : "info",
      title: "", text: r.text || "", status: r.status, proposal: r.proposal || null, inReplyTo: r.in_reply_to || "", live: true,
    };
  }

  function fromPending(c) {
    var label = c.type === "confirm" ? "Confirm" : (c.type === "cancel" ? "Cancel" : "");
    return {
      key: "c:" + c.id, ts: c.ts, iso: new Date(c.ts).toISOString(), kind: "chat_in", severity: "info", title: "",
      text: c.text || label, pending: c, id: c.id,
    };
  }

  function collectItems(key) {
    var data = L.files[key];
    var posts = (data && Array.isArray(data.posts)) ? data.posts : [];
    var cmdIds = {}, replyIds = {};
    var items = [];
    posts.forEach(function (p) {
      if (!p || p.kind === "audit") return;
      var d = p.data || {};
      if (p.kind === "chat_in" && d.cmd_id) cmdIds[d.cmd_id] = 1;
      if (p.kind === "chat_out" && d.reply_id) replyIds[d.reply_id] = 1;
      items.push(fromPost(p));
    });
    L.pending.forEach(function (c) {
      if (c.book === key && !cmdIds[c.id]) items.push(fromPending(c));
    });
    Object.keys(L.replies).forEach(function (id) {
      var r = L.replies[id];
      if (r.book === key && !replyIds[id]) items.push(fromReply(r));
    });
    /* A "received" or "working" line goes away once the same command has a
       later, more final reply. */
    var byCmd = {};
    items.forEach(function (it) {
      if (it.kind !== "chat_out" || !it.inReplyTo) return;
      var g = byCmd[it.inReplyTo] || (byCmd[it.inReplyTo] = { terminal: false, working: false });
      if (TERMINAL[it.status]) g.terminal = true;
      if (it.status === "working") g.working = true;
    });
    items = items.filter(function (it) {
      if (it.kind !== "chat_out" || !it.inReplyTo) return true;
      var g = byCmd[it.inReplyTo];
      if (it.status === "received" && (g.terminal || g.working)) return false;
      if (it.status === "working" && g.terminal) return false;
      return true;
    });
    items = items.map(function (it, i) { it.ord = i; return it; });
    items.sort(function (a, c) { return (a.ts - c.ts) || (a.ord - c.ord); });
    if (items.length > MAX_ITEMS) items = items.slice(items.length - MAX_ITEMS);
    return items;
  }

  function itemSig(it) {
    var extra = "";
    if (it.pending) extra = it.pending.state + "|" + hintDue(it.pending);
    if (it.proposal) extra += "|" + (L.decided[it.proposal.id] || "");
    return [it.kind, it.severity, it.title, it.text, it.status || "", extra].join("\u0001");
  }

  function hintDue(c) {
    if (c.state !== "sent") return "";
    if (c.type !== "msg") return "";
    if (Date.now() - c.ts < NO_ANSWER_HINT_MS) return "";
    var got = Object.keys(L.replies).some(function (id) { return L.replies[id].in_reply_to === c.id; });
    var data = L.files[c.book];
    var posts = (data && data.posts) || [];
    var inFeed = posts.some(function (p) { return p.data && p.data.in_reply_to === c.id; });
    return got || inFeed ? "" : "h";
  }

  function buildItem(B, it) {
    var kind = it.kind;
    var row;
    if (kind === "chat_in") {
      row = el("div", "lv-row lv-row-in");
      var bub = el("div", "lv-bubble lv-bubble-in");
      bub.appendChild(el("div", "lv-bubble-text", it.text));
      var meta = el("div", "lv-bubble-meta", ctStamp(it.ts));
      if (it.pending) {
        var c = it.pending;
        var st = c.state === "failed" ? "Not sent" : (c.state === "sending" ? "Sending..." : "Sent");
        var chip = el("span", "lv-chip lv-chip-" + (c.state === "failed" ? "error" : "received"), st);
        meta.appendChild(chip);
        if (c.state === "failed") {
          var retry = el("button", "lv-link", "Retry");
          retry.type = "button";
          retry.addEventListener("click", function () {
            removePending(c.id);
            runWithPass(B, function () { sendCommand(c.book, c.type, c.ref, c.text); });
            renderBookFeed(B);
          });
          meta.appendChild(retry);
        }
      }
      bub.appendChild(meta);
      if (it.pending && hintDue(it.pending)) {
        bub.appendChild(el("div", "lv-hint", "No answer yet. If this keeps happening, the passcode may be wrong: tap Lock and enter it again."));
      }
      row.appendChild(bub);
      return row;
    }
    if (kind === "chat_out") {
      row = el("div", "lv-row lv-row-out");
      var ob = el("div", "lv-bubble lv-bubble-out");
      var head = el("div", "lv-bubble-head");
      head.appendChild(el("span", "lv-who", "Operator"));
      var status = it.status || "answer";
      var sc = el("span", "lv-chip lv-chip-" + status);
      if (status === "working") sc.appendChild(el("span", "lv-spin"));
      sc.appendChild(document.createTextNode(STATUS_LABEL[status] || status));
      head.appendChild(sc);
      ob.appendChild(head);
      if (it.text) ob.appendChild(el("div", "lv-bubble-text", it.text));
      if (it.proposal) ob.appendChild(buildProposal(B, it.proposal));
      ob.appendChild(el("div", "lv-bubble-meta", ctStamp(it.ts)));
      row.appendChild(ob);
      return row;
    }
    row = el("div", "lv-row lv-item lv-k-" + kind + (it.severity === "warn" ? " lv-sev-warn" : "") + (it.severity === "critical" ? " lv-sev-critical" : ""));
    row.appendChild(el("span", "lv-time", ctStamp(it.ts)));
    var body = el("div", "lv-item-body");
    if (kind === "plan") body.appendChild(el("span", "lv-tag lv-tag-plan", "Plan changed"));
    if (kind === "action") body.appendChild(el("span", "lv-tag lv-tag-action", "Action"));
    if (it.severity === "critical") body.appendChild(el("span", "lv-tag lv-tag-critical", "Critical"));
    else if (it.severity === "warn") body.appendChild(el("span", "lv-tag lv-tag-warn", "Heads up"));
    if (it.title) body.appendChild(el("strong", "lv-item-title", it.title));
    body.appendChild(document.createTextNode(clockify(it.text, startMsFor(B.key))));
    row.appendChild(body);
    return row;
  }

  function buildProposal(B, prop) {
    var card = el("div", "lv-proposal");
    if (prop.summary) card.appendChild(el("div", "lv-prop-summary", prop.summary));
    if (Array.isArray(prop.steps) && prop.steps.length) {
      var ol = el("ol", "lv-prop-steps");
      prop.steps.forEach(function (s) { ol.appendChild(el("li", null, s)); });
      card.appendChild(ol);
    }
    if (prop.risk) {
      var risk = el("div", "lv-prop-risk");
      risk.appendChild(el("strong", null, "Risk: "));
      risk.appendChild(document.createTextNode(prop.risk));
      card.appendChild(risk);
    }
    var done = L.decided[prop.id];
    var row = el("div", "lv-prop-actions");
    var yes = el("button", "lv-btn lv-btn-go", "Confirm");
    yes.type = "button";
    var no = el("button", "lv-btn lv-btn-ghost", "Cancel");
    no.type = "button";
    if (done) {
      yes.disabled = true;
      no.disabled = true;
      row.appendChild(yes);
      row.appendChild(no);
      row.appendChild(el("span", "lv-prop-done", done === "confirm" ? "You confirmed. Waiting for the operator." : "You cancelled this."));
    } else {
      var go = function (type) {
        return function () {
          yes.disabled = true;
          no.disabled = true;
          runWithPass(B, function () {
            L.decided[prop.id] = type;
            lsSet(LS_DECIDED, JSON.stringify(L.decided));
            sendCommand(B.key, type, prop.id, "");
          }, function () {
            yes.disabled = false;
            no.disabled = false;
          });
        };
      };
      yes.addEventListener("click", go("confirm"));
      no.addEventListener("click", go("cancel"));
      row.appendChild(yes);
      row.appendChild(no);
    }
    card.appendChild(row);
    return card;
  }

  function reconcileFeed(B, items, forceBottom) {
    var box = B.feedEl;
    var atBottom = !B.inited || (box.scrollHeight - box.scrollTop - box.clientHeight < 48);
    var cursor = 0;
    var keep = {};
    if (!items.length) {
      items = [{ key: "__empty", empty: true }];
    }
    items.forEach(function (it) {
      keep[it.key] = 1;
      var sig = it.empty ? "empty" : itemSig(it);
      var c = B.cache[it.key];
      if (!c || c.sig !== sig) {
        var node = it.empty ? el("div", "lv-empty", "Nothing posted for this book yet.") : buildItem(B, it);
        if (c && c.el.parentNode) c.el.parentNode.removeChild(c.el);
        c = { el: node, sig: sig };
        B.cache[it.key] = c;
      }
      var ref = box.children[cursor] || null;
      if (c.el !== ref) box.insertBefore(c.el, ref);
      cursor++;
    });
    Object.keys(B.cache).forEach(function (k) {
      if (!keep[k]) {
        var c2 = B.cache[k];
        if (c2.el.parentNode) c2.el.parentNode.removeChild(c2.el);
        delete B.cache[k];
      }
    });
    var newest = items[items.length - 1].key;
    var changedNewest = newest !== B.newestKey;
    B.newestKey = newest;
    if (box.clientHeight > 0) {
      if (forceBottom || atBottom) {
        box.scrollTop = box.scrollHeight;
        B.pillEl.hidden = true;
      } else if (changedNewest && B.inited) {
        B.pillEl.hidden = false;
      }
      B.inited = true;
    }
  }

  function renderBookFeed(B, forceBottom) {
    reconcileFeed(B, collectItems(B.key), forceBottom);
  }

  /* -- plan card -- */

  /* Three plan sections get their own header buttons (Lag, Waves, Clamp).
     Matched by title, case-insensitive and tolerant of small wording changes. */
  var SEC_DEFS = [
    { k: "lag", label: "Lag", re: /\blag/i },
    { k: "waves", label: "Waves", re: /\bwave/i },
    { k: "clamp", label: "Clamp", re: /tighten|clamp/i },
  ];

  function splitSections(sections) {
    var found = {};
    var rest = [];
    (Array.isArray(sections) ? sections : []).forEach(function (s) {
      var title = String((s && s.title) || "");
      for (var i = 0; i < SEC_DEFS.length; i++) {
        var d = SEC_DEFS[i];
        if (!found[d.k] && d.re.test(title)) { found[d.k] = s; return; }
      }
      rest.push(s);
    });
    return { found: found, rest: rest };
  }

  function sectionCard(s, startMs) {
    var sec = el("div", "lv-sec");
    sec.appendChild(el("h4", null, s.title || ""));
    var ul = el("ul");
    (s.lines || []).forEach(function (ln) { ul.appendChild(el("li", null, clockify(ln, startMs))); });
    sec.appendChild(ul);
    return sec;
  }

  /* "Next move per side": one row per side, biggest exposure first. Built from
     plan.moves (written by the narrator from the bot's own rules and numbers). */
  function buildMoves(plan, startMs) {
    var moves = plan && plan.moves;
    if (!Array.isArray(moves) || !moves.length) return null;
    var wrap = el("div", "lv-moves");
    wrap.appendChild(el("h4", null, "Next move per side"));
    var scroll = el("div", "lv-moves-scroll");
    var tbl = el("table", "lv-moves-tbl");
    var thead = el("thead");
    var hr = el("tr");
    [["Side", ""], ["Resting", "lv-mv-rest"], ["If it wins", "lv-mv-exp num"], ["Next move", "lv-mv-move"], ["When / trigger", "lv-mv-when"]].forEach(function (h) {
      hr.appendChild(el("th", h[1], h[0]));
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = el("tbody");
    moves.forEach(function (mv) {
      var tr = el("tr", mv.stuck ? "is-stuck" : "");
      var c1 = el("td", "lv-mv-side");
      c1.setAttribute("data-label", "Side");
      c1.appendChild(el("span", "lv-mv-name", mv.side || ""));
      if (mv.stuck) {
        var tag = el("span", "lv-mv-stuck", "stuck");
        tag.title = "No fill in a long time, big exposure, and no move planned in the next 2 hours.";
        c1.appendChild(tag);
      }
      tr.appendChild(c1);
      var c2 = el("td", "lv-mv-rest", mv.resting || "none");
      c2.setAttribute("data-label", "Resting");
      tr.appendChild(c2);
      var ex = typeof mv.exposure === "number" ? mv.exposure : NaN;
      var c3 = el("td", "lv-mv-exp num" + (isFinite(ex) ? (ex < -0.5 ? " lv-mv-neg" : (ex > 0.5 ? " lv-mv-pos" : "")) : ""), mv.exposure_text || "-");
      c3.setAttribute("data-label", "If it wins");
      tr.appendChild(c3);
      var c4 = el("td", "lv-mv-move", clockify(mv.move || "", startMs));
      c4.setAttribute("data-label", "Next");
      tr.appendChild(c4);
      var c5 = el("td", "lv-mv-when");
      c5.setAttribute("data-label", "When");
      c5.appendChild(document.createTextNode(clockify(mv.when || "", startMs)));
      if (mv.also) c5.appendChild(el("span", "lv-mv-also", clockify(mv.also, startMs)));
      tr.appendChild(c5);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    scroll.appendChild(tbl);
    wrap.appendChild(scroll);
    if (plan.moves_note) wrap.appendChild(el("p", "lv-mv-note", clockify(plan.moves_note, startMs)));
    return wrap;
  }

  function renderPlan(B, plan) {
    var sig = plan ? JSON.stringify(plan) : "";
    if (sig === B.planSig) return;
    B.planSig = sig;
    var box = B.planEl;
    box.innerHTML = "";
    B.planHas = !!plan;
    var split = splitSections(plan && plan.sections);
    var startMs = startMsFor(B.key);
    SEC_DEFS.forEach(function (d) {
      var pe = B.secEls[d.k];
      pe.innerHTML = "";
      B.secHas[d.k] = !!split.found[d.k];
      if (split.found[d.k]) {
        var g = el("div", "lv-sections lv-sections-solo");
        g.appendChild(sectionCard(split.found[d.k], startMs));
        pe.appendChild(g);
      }
    });
    if (!plan) return;
    var top = el("div", "lv-plan-top");
    top.appendChild(el("span", "lv-plan-label", "What happens next"));
    var age = el("span", "lv-age lv-plan-age", agoText(plan.ts));
    age.setAttribute("data-ago", plan.ts || "");
    top.appendChild(age);
    box.appendChild(top);
    var mvBlock = buildMoves(plan, startMs);
    if (mvBlock) box.appendChild(mvBlock);
    if (plan.headline) box.appendChild(el("h3", "lv-plan-headline", clockify(plan.headline, startMs)));

    var chips = el("div", "lv-plan-chips");
    if (plan.phase) chips.appendChild(el("span", "lv-chip lv-chip-phase", plan.phase));
    var conf = String(plan.confidence || "").toLowerCase();
    if (conf === "high" || conf === "medium" || conf === "low") {
      chips.appendChild(el("span", "lv-chip lv-conf lv-conf-" + conf, "Confidence: " + conf));
    }
    chips.appendChild(el("span", "lv-plan-checks", "Bot checks every " + (plan.checks_every_s || 30) + " s"));
    box.appendChild(chips);
    if (plan.confidence_note) box.appendChild(el("p", "lv-conf-note", clockify(plan.confidence_note, startMs)));

    if (split.rest.length) {
      var grid = el("div", "lv-sections");
      split.rest.forEach(function (s) { grid.appendChild(sectionCard(s, startMs)); });
      box.appendChild(grid);
    }

    if (Array.isArray(plan.next_steps) && plan.next_steps.length) {
      var steps = plan.next_steps.slice().sort(function (a, c) { return (parseMs(a.at) || 0) - (parseMs(c.at) || 0); });
      var wrap = el("div", "lv-steps");
      wrap.appendChild(el("h4", null, "Coming up"));
      var ul2 = el("ul", "lv-steps-list");
      steps.forEach(function (st) {
        var li = el("li", "lv-step");
        var when = el("div", "lv-step-when");
        when.appendChild(el("span", "lv-step-abs", ctStamp(parseMs(st.at)) + " CT"));
        var cd = el("span", "lv-cd", countdownText(st.at));
        cd.setAttribute("data-at", st.at || "");
        when.appendChild(cd);
        li.appendChild(when);
        var what = el("div", "lv-step-what");
        what.appendChild(el("strong", null, clockify(st.label || "", startMs)));
        if (st.detail) what.appendChild(el("span", "lv-step-detail", " - " + clockify(st.detail, startMs)));
        li.appendChild(what);
        ul2.appendChild(li);
      });
      wrap.appendChild(ul2);
      box.appendChild(wrap);
    }

    if (Array.isArray(plan.sides) && plan.sides.length) {
      var scroll = el("div", "lv-sides-scroll");
      var tbl = el("table", "lv-sides");
      var thead = el("thead");
      var hr = el("tr");
      ["Side", "Held", "Resting", "Target", "Status"].forEach(function (h, i) {
        hr.appendChild(el("th", i > 0 && i < 4 ? "num" : null, h));
      });
      thead.appendChild(hr);
      tbl.appendChild(thead);
      var tb = el("tbody");
      plan.sides.forEach(function (sd) {
        var tr = el("tr");
        tr.appendChild(el("td", null, sd.label || ""));
        tr.appendChild(el("td", "num", sd.held === undefined || sd.held === null ? "-" : fmtNum(sd.held)));
        tr.appendChild(el("td", "num", sd.resting === undefined || sd.resting === null ? "-" : fmtNum(sd.resting)));
        tr.appendChild(el("td", "num", sd.target === undefined || sd.target === null ? "-" : fmtNum(sd.target)));
        var stc = el("td", "lv-side-status");
        var status = String(sd.status || "").toLowerCase();
        stc.appendChild(el("span", "lv-dot lv-dot-" + (["lagging", "even", "heavy"].indexOf(status) >= 0 ? status : "none")));
        stc.appendChild(document.createTextNode(status || "-"));
        tr.appendChild(stc);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      scroll.appendChild(tbl);
      box.appendChild(scroll);
    }
  }

  /* -- audit drawer -- */

  function auditCount(key) {
    var e = entryFor(key);
    var f = L.files[key];
    var n = f && Array.isArray(f.audits) ? f.audits.length : 0;
    if (e && typeof e.audit_count === "number") return Math.max(e.audit_count, n);
    return n;
  }

  function renderAuditButton(B) {
    var n = auditCount(B.key);
    B.auditBtn.firstChild.textContent = "Audits (" + n + ")";
    B.auditDot.hidden = !hasUnseenAudit(B.key) || B.drawerOpen;
    B.auditBtn.setAttribute("aria-expanded", String(!!B.drawerOpen));
  }

  function renderDrawer(B) {
    var f = L.files[B.key];
    var audits = (f && Array.isArray(f.audits)) ? f.audits : [];
    var sig = audits.length + "|" + (audits.length ? audits[audits.length - 1].id || audits[audits.length - 1].ts : "");
    if (sig === B.drawerSig) return;
    B.drawerSig = sig;
    var prevTop = B.drawerEl.scrollTop;
    B.drawerEl.innerHTML = "";
    if (!audits.length) {
      B.drawerEl.appendChild(el("p", "lv-empty", "No audit alerts."));
      return;
    }
    audits.slice().reverse().forEach(function (a) {
      var row = el("div", "lv-audit lv-audit-" + (a.severity || "info"));
      var head = el("div", "lv-audit-head");
      head.appendChild(el("span", "lv-time", ctStamp(parseMs(a.ts))));
      if (a.source) head.appendChild(el("span", "lv-audit-src", a.source));
      row.appendChild(head);
      var body = el("div", "lv-audit-body");
      if (a.title) body.appendChild(el("strong", null, a.title + " "));
      body.appendChild(document.createTextNode(a.text || ""));
      row.appendChild(body);
      B.drawerEl.appendChild(row);
    });
    B.drawerEl.scrollTop = prevTop;
  }

  function setDrawer(B, open) {
    B.drawerOpen = open;
    B.drawerEl.hidden = !open;
    if (open) {
      B.planOpen = false; /* plan, Lag, Waves, Clamp and audits share the same spot inside the box */
      B.secOpen = null;
      renderDrawer(B);
      markAuditsSeen(B.key);
      removeBanner(B.key);
    }
    syncPlanPanel(B);
    renderAuditButton(B);
  }

  function syncPlanPanel(B) {
    if (!B.planHas) B.planOpen = false;
    SEC_DEFS.forEach(function (d) {
      if (!B.secHas[d.k] && B.secOpen === d.k) B.secOpen = null;
      var on = B.secOpen === d.k;
      B.secBtns[d.k].hidden = !B.secHas[d.k];
      B.secEls[d.k].hidden = !on;
      B.secBtns[d.k].setAttribute("aria-expanded", String(on));
      B.secBtns[d.k].classList.toggle("is-on", on);
    });
    B.planBtn.hidden = !B.planHas;
    B.planEl.hidden = !B.planOpen;
    B.planBtn.setAttribute("aria-expanded", String(!!B.planOpen));
    B.planBtn.classList.toggle("is-on", !!B.planOpen);
  }

  function setPlan(B, open) {
    B.planOpen = open && B.planHas;
    if (B.planOpen) B.secOpen = null;
    if (B.planOpen && B.drawerOpen) {
      B.drawerOpen = false;
      B.drawerEl.hidden = true;
      renderAuditButton(B);
    }
    syncPlanPanel(B);
  }

  function setSec(B, k, open) {
    B.secOpen = open && B.secHas[k] ? k : null;
    if (B.secOpen) {
      B.planOpen = false;
      if (B.drawerOpen) {
        B.drawerOpen = false;
        B.drawerEl.hidden = true;
        renderAuditButton(B);
      }
    }
    syncPlanPanel(B);
  }

  /* -- chat -- */

  function persistPending() {
    var keep = L.pending.filter(function (c) { return Date.now() - c.ts < 24 * 3600 * 1000; });
    L.pending = keep;
    lsSet(LS_PENDING, JSON.stringify(keep));
  }

  function removePending(id) {
    L.pending = L.pending.filter(function (c) { return c.id !== id; });
    persistPending();
  }

  function sendCommand(book, type, ref, text) {
    if (!L.keys) return Promise.resolve();
    var cmd = { id: uuid(), ts: Date.now(), book: book, type: type, ref: ref || "", text: text || "", state: "sending" };
    L.pending.push(cmd);
    persistPending();
    var B = L.blocks[book];
    if (B) renderBookFeed(B, true);
    var topic = L.keys.cmdTopic;
    return signPayload(L.keys, cmd).then(function (payload) {
      return fetch(NTFY + topic, { method: "POST", body: JSON.stringify(payload) });
    }).then(function (res) {
      if (!res.ok) throw new Error("ntfy " + res.status);
      cmd.state = "sent";
    }).catch(function () {
      cmd.state = "failed";
    }).then(function () {
      persistPending();
      var B2 = L.blocks[book];
      if (B2) renderBookFeed(B2);
      setTimeout(function () {
        var B3 = L.blocks[book];
        if (B3 && L.active) renderBookFeed(B3);
      }, NO_ANSWER_HINT_MS + 500);
    });
  }

  function runWithPass(B, thunk, onCancel) {
    if (L.keys) {
      thunk();
      return;
    }
    B.passThunk = thunk;
    B.passCancel = onCancel || null;
    B.passForm.hidden = false;
    B.passInput.focus();
  }

  function savePass(B) {
    var val = B.passInput.value;
    if (!normalizePass(val)) {
      B.passMsg.textContent = "Type the passcode first.";
      return;
    }
    B.passMsg.textContent = "";
    deriveKeys(val).then(function (keys) {
      L.keys = keys;
      lsSet(LS_PASS, val);
      B.passInput.value = "";
      ensureSubscription();
      refreshChatChrome();
      var t = B.passThunk;
      B.passThunk = null;
      B.passCancel = null;
      if (t) t();
    }).catch(function () {
      B.passMsg.textContent = "This browser could not use that passcode.";
    });
  }

  function lockChat() {
    lsDel(LS_PASS);
    L.keys = null;
    if (L.es) {
      try { L.es.close(); } catch (e) { /* already closed */ }
      L.es = null;
      L.esTopic = null;
    }
    refreshChatChrome();
  }

  function refreshChatChrome() {
    Object.keys(L.blocks).forEach(function (k) {
      var B = L.blocks[k];
      if (!B.lockEl) return;
      B.lockEl.hidden = !L.keys;
      if (L.keys) B.passForm.hidden = true;
    });
  }

  function ensureSubscription() {
    if (!L.keys || L.es) return;
    if (typeof EventSource === "undefined") return;
    var topic = L.keys.replyTopic;
    var es;
    try {
      es = new EventSource(NTFY + topic + "/sse?since=2h");
    } catch (e) {
      return;
    }
    L.es = es;
    L.esTopic = topic;
    es.onmessage = function (ev) {
      var outer;
      try { outer = JSON.parse(ev.data); } catch (e) { return; }
      if (!outer || (outer.event && outer.event !== "message")) return;
      var r;
      try { r = JSON.parse(outer.message); } catch (e) { return; }
      onReply(r);
    };
  }

  function onReply(r) {
    if (!r || typeof r !== "object" || !r.id || !r.book) return;
    if (L.replies[r.id]) return;
    var rep = {
      id: String(r.id), book: String(r.book), in_reply_to: String(r.in_reply_to || ""), status: String(r.status || "answer"),
      text: String(r.text || ""), proposal: r.proposal && typeof r.proposal === "object" ? r.proposal : null,
      ts: typeof r.ts === "number" ? r.ts : Date.now(),
    };
    L.replies[rep.id] = rep;
    var B = L.blocks[rep.book];
    if (B && L.active) renderBookFeed(B);
  }

  function buildChat(B) {
    var chat = el("div", "lv-chat");
    var line = el("div", "lv-chat-line");
    var ta = el("textarea", "lv-chat-input");
    ta.rows = 1;
    ta.maxLength = 1000;
    ta.placeholder = "Ask the operator...";
    ta.title = "Enter sends. Changes always wait for your Confirm.";
    ta.setAttribute("aria-label", "Message for " + B.key);
    line.appendChild(ta);
    var send = el("button", "lv-btn lv-btn-small", "Send");
    send.type = "button";
    line.appendChild(send);
    var lock = el("button", "lv-link lv-lock", "Lock");
    lock.type = "button";
    lock.hidden = !L.keys;
    lock.addEventListener("click", lockChat);
    line.appendChild(lock);

    var form = el("form", "lv-pass");
    form.hidden = true;
    var lab = el("label", null, "Enter your passcode once. It stays on this device until you tap Lock.");
    var pw = el("input");
    pw.type = "password";
    pw.autocomplete = "off";
    pw.setAttribute("aria-label", "Passcode");
    lab.appendChild(pw);
    form.appendChild(lab);
    var save = el("button", "lv-btn", "Save and send");
    save.type = "submit";
    form.appendChild(save);
    var msg = el("span", "lv-pass-msg");
    form.appendChild(msg);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      savePass(B);
    });
    chat.appendChild(form);
    chat.appendChild(line);

    function doSend() {
      var text = ta.value.trim();
      if (!text) return;
      runWithPass(B, function () {
        ta.value = "";
        sendCommand(B.key, "msg", "", text);
      });
    }
    send.addEventListener("click", doSend);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    });
    B.lockEl = lock;
    B.passForm = form;
    B.passInput = pw;
    B.passMsg = msg;
    B.chatInput = ta;
    return chat;
  }


  /* -- queue view (where our resting contracts sit in line) -- */

  var VERDICT_RANK = { unlikely: 0, maybe: 1, likely: 2, none: 3 };
  var VERDICT_MARK = { likely: "✓", maybe: "●", unlikely: "✕", none: "-" };
  var VERDICT_WORD = { likely: "Likely to fill", maybe: "Maybe", unlikely: "Unlikely", none: "Nothing resting" };

  function fmtPx(p) {
    if (p === null || p === undefined || isNaN(Number(p))) return "-";
    var v = Number(p);
    var d = Math.abs(v * 100 - Math.round(v * 100)) > 0.001 ? 3 : 2;
    return v.toFixed(d).replace(/^0\./, ".");
  }

  function fmtTraded(n, avg) {
    if (n === null || n === undefined) return "-";
    if (!n) return "0";
    return fmtNum(n) + " @ " + fmtPx(avg);
  }

  function pollQueue() {
    return fetchJSON("data/queue/index.json").then(function (idx) {
      var books = (idx && Array.isArray(idx.books)) ? idx.books : [];
      var fetches = books.map(function (b) {
        if (L.qFiles[b.key] && L.qSigs[b.key] === b.ts) return Promise.resolve();
        return fetchJSON("data/queue/" + encodeURIComponent(b.key) + ".json").then(function (data) {
          L.qFiles[b.key] = data;
          L.qSigs[b.key] = b.ts;
        }, function () { /* keep what we had */ });
      });
      return Promise.all(fetches).then(function () {
        L.qIndex = idx;
        Object.keys(L.blocks).forEach(function (k) { if (L.blocks[k].queueEl) renderQueue(L.blocks[k]); });
      });
    }).catch(function () { /* queue files not there yet: the card says so */ });
  }

  function sortQueueRows(rows, mode) {
    var out = rows.slice();
    var num = function (v) { return (v === null || v === undefined) ? Infinity : Number(v); };
    out.sort(function (a, c) {
      var an = a.verdict === "none", cn = c.verdict === "none";
      if (an !== cn) return an ? 1 : -1;
      if (mode === "ahead") {
        return (num(a.ahead) - num(c.ahead)) || (VERDICT_RANK[a.verdict] - VERDICT_RANK[c.verdict]);
      }
      return (VERDICT_RANK[a.verdict] - VERDICT_RANK[c.verdict]) || (num(a.ahead) - num(c.ahead));
    });
    return out;
  }

  var VERDICT_PILL = { likely: "Likely to sell", maybe: "Might sell", unlikely: "Not selling at this price", none: "Nothing posted" };

  function cents(p) {
    if (p === null || p === undefined || isNaN(Number(p))) return "none";
    var c = Number(p) * 100;
    var r = Math.round(c);
    return (Math.abs(c - r) > 0.05 ? c.toFixed(1) : String(r)) + "¢";
  }

  function plural(n, w) { return fmtNum(n) + " " + w + (Number(n) === 1 ? "" : "s"); }

  function qRow(label, value) {
    var r = el("div", "lv-qc-row");
    r.appendChild(el("span", "lv-qc-label", label));
    r.appendChild(el("span", "lv-qc-value", value));
    return r;
  }

  function buildOutcomeCard(o, readOk, compact) {
    var v = o.verdict || "none";
    var card = el("div", "lv-qc lv-q-" + v + (compact ? " lv-qc-compact" : ""));
    var hd = el("div", "lv-qc-head");
    hd.appendChild(el("span", "lv-qc-name", o.label));
    hd.appendChild(el("span", "lv-qc-pill lv-qp-" + v, VERDICT_PILL[v] || v));
    card.appendChild(hd);
    if (compact) return card;
    var hasAsk = o.our_ask !== null && o.our_ask !== undefined;
    var ours = "none posted";
    if (hasAsk) {
      ours = cents(o.our_ask) + " for " + plural(o.our_size_at_ask || 0, "contract");
      if (o.our_resting_total > o.our_size_at_ask) ours += " (+" + fmtNum(o.our_resting_total - o.our_size_at_ask) + " more at higher prices)";
    }
    card.appendChild(qRow("Our price", ours));
    var ahead = "-";
    if (v !== "none" && readOk !== false && o.ahead !== null && o.ahead !== undefined) {
      ahead = Number(o.ahead) === 0 ? "0 contracts (we're first)" : plural(o.ahead, "contract");
    }
    card.appendChild(qRow("Ahead of us in line", ahead));
    card.appendChild(qRow("Crowd's prices", "buyers will pay " + cents(o.crowd_bid) + " · cheapest other seller " + cents(o.crowd_ask) + " · last sale " + cents(o.last_price)));
    var act;
    if (o.traded_24h === null || o.traded_24h === undefined) act = "not available";
    else if (!o.traded_24h) act = "nothing in the last 24h";
    else {
      act = plural(o.traded_24h, "contract") + " in the last 24h" + (o.traded_24h_avg ? " (avg " + cents(o.traded_24h_avg) + ")" : "");
      if (o.traded_1h) act += " · " + fmtNum(o.traded_1h) + " in the last hour";
    }
    card.appendChild(qRow("Buying activity", act));
    card.appendChild(qRow("Already sold", o.held ? fmtNum(o.held) + (o.avg_sale_price ? " at " + cents(o.avg_sale_price) + " avg" : "") : "none yet"));
    if (v !== "none" && o.verdict_why) card.appendChild(el("div", "lv-qc-why", o.verdict_why));
    return card;
  }

  function renderQueue(B) {
    var q = L.qFiles[B.key];
    var box = B.queueEl;
    var sig = (q ? q.ts : "none") + "|" + B.qSort + "|" + (B.qNoneOpen ? 1 : 0) + "|" + (B.qHelpOpen ? 1 : 0);
    if (sig === B.queueSig) return;
    B.queueSig = sig;
    var top = box.scrollTop;
    box.innerHTML = "";
    if (!q) {
      box.appendChild(el("div", "lv-q-empty", "Queue numbers have not arrived for this book yet."));
      return;
    }
    var head = el("div", "lv-q-head");
    var cd = el("span", "lv-cd");
    cd.setAttribute("data-at", q.start_time || "");
    head.appendChild(cd);
    var age = el("span", "lv-age");
    age.setAttribute("data-ago", q.ts || "");
    head.appendChild(age);
    var src = q.trades_src === "rest" ? "Trades: last 24h tape" : "Trades: not available";
    head.appendChild(el("span", "lv-q-src", src));
    box.appendChild(head);
    box.appendChild(el("div", "lv-q-explain", "We're selling a contract on every outcome. Each card shows our price, our place in line, and whether buyers are likely to take it."));

    var help = el("details", "lv-q-help");
    help.open = !!B.qHelpOpen;
    help.appendChild(el("summary", null, "How to read this"));
    var ul = el("ul");
    [
      ["Our price: ", "what we're asking for one contract on this outcome, and how many we're offering."],
      ["Ahead of us in line: ", "contracts at our price that were posted before ours. Cheaper offers sell first; at equal prices, earlier ones go first."],
      ["Crowd's prices: ", "what buyers will pay right now, and the cheapest price any other seller is asking."],
      ["Buying activity: ", "how many contracts people actually bought recently."],
      ["Status colours: ", "green means likely to sell, yellow means might sell, red means not selling at this price, grey means we have nothing posted."]
    ].forEach(function (p) {
      var li = el("li");
      li.appendChild(el("strong", null, p[0]));
      li.appendChild(document.createTextNode(p[1]));
      ul.appendChild(li);
    });
    help.appendChild(ul);
    help.addEventListener("toggle", function () { B.qHelpOpen = help.open; });
    box.appendChild(help);

    if (q.queue_read_ok === false) {
      box.appendChild(el("div", "lv-q-warn", "Line position could not be read this pass, so place in line shows a dash."));
    }

    var sorter = el("div", "lv-q-sort");
    [["verdict", "By likelihood"], ["ahead", "By place in line"]].forEach(function (m) {
      var b = el("button", "lv-btn lv-btn-ghost lv-btn-tiny" + (B.qSort === m[0] ? " active" : ""), m[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", String(B.qSort === m[0]));
      b.addEventListener("click", function () { B.qSort = m[0]; renderQueue(B); });
      sorter.appendChild(b);
    });
    box.appendChild(sorter);

    var rows = sortQueueRows(q.outcomes || [], B.qSort);
    var active = rows.filter(function (o) { return o.verdict !== "none"; });
    var none = rows.filter(function (o) { return o.verdict === "none"; });
    var list = el("div", "lv-qc-list");
    active.forEach(function (o) { list.appendChild(buildOutcomeCard(o, q.queue_read_ok, false)); });
    box.appendChild(list);
    if (none.length) {
      var tg = el("button", "lv-qc-nonebtn", "Nothing posted on " + none.length + " outcome" + (none.length === 1 ? "" : "s") + (B.qNoneOpen ? " (hide)" : " (show)"));
      tg.type = "button";
      tg.setAttribute("aria-expanded", String(!!B.qNoneOpen));
      tg.addEventListener("click", function () { B.qNoneOpen = !B.qNoneOpen; renderQueue(B); });
      box.appendChild(tg);
      if (B.qNoneOpen) {
        var nl = el("div", "lv-qc-list");
        none.forEach(function (o) { nl.appendChild(buildOutcomeCard(o, q.queue_read_ok, true)); });
        box.appendChild(nl);
      }
    }
    box.scrollTop = top;
    tick();
  }

  function setFeedOpen(B, open) {
    B.feedOpen = !!open;
    B.boxEl.classList.toggle("feed-open", B.feedOpen);
    if (B.feedBtn) B.feedBtn.setAttribute("aria-expanded", String(B.feedOpen));
    if (B.feedOpen) renderBookFeed(B, true);
  }

  /* -- blocks (one unit per book: tile, fills drop-down, feed box) -- */

  function buildBlock(key) {
    var B = {
      key: key, cache: {}, inited: false, drawerOpen: false, planOpen: false, planHas: false, secOpen: null, secHas: {}, secEls: {}, secBtns: {}, fillsOpen: false,
      feedOpen: key === FLEET, qSort: "verdict", queueSig: null, planSig: null, drawerSig: null, tileGen: null, tileKey: null, tileNode: null, fillsSig: null, newestKey: null,
    };
    var root = el("section", "lv-unit");
    root.id = "lv-" + key;
    B.el = root;

    /* tile slot: the Home tile when the book has one, else a plain title bar */
    B.tileSlot = el("div", "lv-tile-slot");
    var head = el("div", "lv-head");
    B.titleEl = el("h2", "lv-title");
    B.sportEl = el("span", "sport-tag");
    B.pillEl2 = el("span", "lv-livepill");
    B.subEl = el("span", "lv-sub");
    head.appendChild(B.titleEl);
    head.appendChild(B.sportEl);
    head.appendChild(B.pillEl2);
    head.appendChild(B.subEl);
    B.headEl = head;
    B.tileSlot.appendChild(head);
    root.appendChild(B.tileSlot);

    /* fills drop-down (closed until the tile is clicked) */
    B.fillsEl = el("div", "lv-fills");
    B.fillsEl.hidden = true;
    root.appendChild(B.fillsEl);

    /* feed box: same width as the tile, height set by layoutUnits() */
    var box = el("div", "lv-box");
    B.boxEl = box;
    var bar = el("div", "lv-bar");
    bar.appendChild(el("span", "lv-bar-title", key === FLEET ? "Fleet feed" : "Live feed"));
    if (key !== FLEET) {
      B.feedBtn = el("button", "lv-btn lv-btn-ghost lv-btn-tiny lv-feed-btn", "Feed");
      B.feedBtn.type = "button";
      B.feedBtn.setAttribute("aria-expanded", "false");
      B.feedBtn.addEventListener("click", function () { setFeedOpen(B, !B.feedOpen); });
      bar.appendChild(B.feedBtn);
    }
    B.planBtn = el("button", "lv-btn lv-btn-ghost lv-btn-tiny", "Plan");
    B.planBtn.type = "button";
    B.planBtn.hidden = true;
    B.planBtn.setAttribute("aria-expanded", "false");
    B.planBtn.addEventListener("click", function () { setPlan(B, !B.planOpen); });
    bar.appendChild(B.planBtn);
    SEC_DEFS.forEach(function (d) {
      var sb = el("button", "lv-btn lv-btn-ghost lv-btn-tiny", d.label);
      sb.type = "button";
      sb.hidden = true;
      sb.setAttribute("aria-expanded", "false");
      sb.addEventListener("click", function () { setSec(B, d.k, B.secOpen !== d.k); });
      B.secBtns[d.k] = sb;
      bar.appendChild(sb);
    });
    var ab = el("button", "lv-btn lv-btn-ghost lv-btn-tiny lv-audit-btn");
    ab.type = "button";
    ab.appendChild(document.createTextNode("Audits (0)"));
    B.auditDot = el("span", "lv-reddot");
    B.auditDot.hidden = true;
    ab.appendChild(B.auditDot);
    ab.addEventListener("click", function () { setDrawer(B, !B.drawerOpen); });
    B.auditBtn = ab;
    bar.appendChild(ab);
    box.appendChild(bar);

    var body = el("div", "lv-box-body");
    var fw = el("div", "lv-feedwrap");
    B.feedEl = el("div", "lv-feed");
    B.feedEl.setAttribute("role", "log");
    B.feedEl.setAttribute("aria-label", "Live feed for " + bookLabel(key));
    B.feedEl.tabIndex = 0;
    fw.appendChild(B.feedEl);
    B.pillEl = el("button", "lv-newpill", "New updates");
    B.pillEl.type = "button";
    B.pillEl.hidden = true;
    B.pillEl.addEventListener("click", function () {
      B.feedEl.scrollTop = B.feedEl.scrollHeight;
      B.pillEl.hidden = true;
    });
    fw.appendChild(B.pillEl);
    B.feedEl.addEventListener("scroll", function () {
      if (B.feedEl.scrollHeight - B.feedEl.scrollTop - B.feedEl.clientHeight < 48) B.pillEl.hidden = true;
    });
    body.appendChild(fw);
    if (key !== FLEET) {
      B.queueEl = el("div", "lv-queue");
      body.appendChild(B.queueEl);
    }
    /* plan text and audit alerts open as panels over the feed, inside the box */
    B.planEl = el("div", "lv-plan");
    B.planEl.hidden = true;
    body.appendChild(B.planEl);
    SEC_DEFS.forEach(function (d) {
      var pe = el("div", "lv-plan");
      pe.hidden = true;
      B.secEls[d.k] = pe;
      body.appendChild(pe);
    });
    B.drawerEl = el("div", "lv-drawer");
    B.drawerEl.hidden = true;
    body.appendChild(B.drawerEl);
    box.appendChild(body);

    if (key !== FLEET) box.appendChild(buildChat(B));
    if (key === FLEET) box.classList.add("feed-open");
    root.appendChild(box);
    return B;
  }

  function feedBookFor(key) {
    var list = (state.feed && state.feed.books) || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function tileLike(B) {
    return B.tileNode || B.headEl;
  }

  function toggleFills(B) {
    B.fillsOpen = !B.fillsOpen;
    renderFills(B, true);
  }

  function renderFills(B, force) {
    var fb = feedBookFor(B.key);
    var open = !!(B.fillsOpen && fb);
    if (B.tileNode) {
      B.tileNode.setAttribute("aria-expanded", String(open));
      B.tileNode.classList.toggle("lv-tile-open", open);
    }
    B.fillsEl.hidden = !open;
    if (!open) return;
    var gen = state.feed ? state.feed.generated_at : "";
    var sig = fb.key + "|" + gen;
    if (!force && sig === B.fillsSig && B.fillsEl.firstChild) return;
    B.fillsSig = sig;
    var prevTop = B.fillsEl.scrollTop;
    B.fillsEl.innerHTML = "";
    var fills = fb.recent_fills || [];
    B.fillsEl.appendChild(el("div", "lv-fills-head", "Recent fills (" + fills.length + ")"));
    B.fillsEl.appendChild(buildFillsTable(fills, !!fb.is_deci_cent));
    B.fillsEl.appendChild(buildFillsSummaryLine(fb.fills_summary));
    B.fillsEl.scrollTop = prevTop;
  }

  function updateBlock(B, entry, isFleet) {
    var fb = isFleet ? null : feedBookFor(B.key);
    /* plain title bar (used by the fleet unit, or a book with no tile data yet) */
    B.titleEl.textContent = isFleet ? "Whole fleet" : (entry.title || (fb && fb.title) || B.key);
    B.sportEl.textContent = isFleet ? "" : (entry.sport || (fb && fb.sport) || "");
    B.sportEl.hidden = !B.sportEl.textContent;
    if (isFleet) {
      B.pillEl2.hidden = true;
      B.subEl.textContent = "Notes that are not tied to one book";
    } else {
      B.pillEl2.hidden = false;
      B.pillEl2.textContent = entry.live ? "Live" : "Recent";
      B.pillEl2.className = "lv-livepill " + (entry.live ? "is-live" : "is-recent");
      var sm = parseMs(entry.start_time);
      B.subEl.textContent = isNaN(sm) ? "" : ((sm > Date.now() ? "Starts " : "Started ") + ctStamp(sm) + " CT");
    }
    /* the same small tile Home shows (rebuilt only when feed.json changed) */
    if (!isFleet && fb) {
      var gen = state.feed ? state.feed.generated_at : null;
      if (B.tileGen !== gen || B.tileKey !== fb.key || !B.tileNode) {
        var tile = buildBookTile(fb, { showSport: true, onActivate: function () { toggleFills(B); } });
        tile.setAttribute("aria-label", "Show or hide fills for " + (fb.title || B.key));
        if (B.tileNode && B.tileNode.parentNode) B.tileNode.parentNode.removeChild(B.tileNode);
        B.tileSlot.appendChild(tile);
        B.tileNode = tile;
        B.tileGen = gen;
        B.tileKey = fb.key;
      }
    } else if (B.tileNode) {
      if (B.tileNode.parentNode) B.tileNode.parentNode.removeChild(B.tileNode);
      B.tileNode = null;
      B.tileGen = null;
      B.tileKey = null;
    }
    B.headEl.hidden = !!B.tileNode;
    renderFills(B, false);
    var f = L.files[B.key];
    renderPlan(B, isFleet ? null : (f && f.plan) || null);
    syncPlanPanel(B);
    renderAuditButton(B);
    if (B.drawerOpen) {
      renderDrawer(B);
      markAuditsSeen(B.key);
      renderAuditButton(B);
    }
    if (B.queueEl) renderQueue(B);
    renderBookFeed(B);
  }

  function layoutUnits() {
    /* Every tile gets the height of the tallest one, and every feed box is
       then given exactly its tile's height (and, being in the same column,
       its width) - so tiles and feeds line up across the grid. */
    var grid = L.root && L.root.querySelector(".lv-blocks");
    if (!grid || grid.offsetParent === null) return; // LIVE tab not showing: measured on the next render
    var list = Object.keys(L.blocks).map(function (k) { return L.blocks[k]; });
    list.forEach(function (B) { tileLike(B).style.minHeight = ""; });
    var h = MIN_BOX_H;
    list.forEach(function (B) { h = Math.max(h, tileLike(B).offsetHeight); });
    var boxH = Math.round(h * BOX_GROW);
    list.forEach(function (B) {
      tileLike(B).style.minHeight = h + "px";
      var want = boxH + "px";
      if (B.boxEl.style.height === want) return;
      var feed = B.feedEl;
      var atBottom = !B.inited || (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48);
      B.boxEl.style.height = want;
      if (atBottom && feed.clientHeight > 0) {
        feed.scrollTop = feed.scrollHeight;
        B.inited = true;
      }
    });
  }

  function renderLive() {
    if (!L.root || !L.active || !L.index) return;
    var entries = shownBooks(Array.isArray(L.index.books) ? L.index.books : []);
    var fleet = L.index.fleet;
    var fleetShown = !!(fleet && ((fleet.post_count || 0) > 0 || (fleet.audit_count || 0) > 0));
    var list = entries.map(function (e) { return { key: e.key, entry: e, fleet: false }; });
    if (fleetShown) list.push({ key: FLEET, entry: fleet, fleet: true });

    var empty = L.root.querySelector(".lv-empty-state");
    empty.hidden = entries.length > 0;

    var holder = L.root.querySelector(".lv-blocks");
    var wanted = {};
    var cursor = 0;
    list.forEach(function (x) {
      wanted[x.key] = 1;
      var B = L.blocks[x.key];
      if (!B) {
        B = buildBlock(x.key);
        L.blocks[x.key] = B;
      }
      var ref = holder.children[cursor] || null;
      if (B.el !== ref) holder.insertBefore(B.el, ref);
      cursor++;
      updateBlock(B, x.entry, x.fleet);
    });
    Object.keys(L.blocks).forEach(function (k) {
      if (!wanted[k]) {
        var B = L.blocks[k];
        if (B.el.parentNode) B.el.parentNode.removeChild(B.el);
        removeBanner(k);
        delete L.blocks[k];
      }
    });
    layoutUnits();
    tick();
  }

  function tick() {
    if (!L.root) return;
    var cds = L.root.querySelectorAll(".lv-cd");
    for (var i = 0; i < cds.length; i++) {
      var t = countdownText(cds[i].getAttribute("data-at"));
      if (cds[i].textContent !== t) cds[i].textContent = t;
    }
    var ages = L.root.querySelectorAll(".lv-age");
    for (var j = 0; j < ages.length; j++) {
      var a = agoText(ages[j].getAttribute("data-ago"));
      if (ages[j].textContent !== a) ages[j].textContent = a;
    }
  }

  /* -- lifecycle -- */

  function setActive(on) {
    /* the floating Live fills button would cover the chat rows; tiles here open their own fills */
    try { document.body.classList.toggle("on-live", !!on); } catch (e) { /* ignore */ }
    if (on === L.active) return;
    L.active = on;
    if (on) {
      poll();
      L.pollTimer = setInterval(poll, POLL_MS);
      L.tickTimer = setInterval(tick, 1000);
    } else {
      clearInterval(L.pollTimer);
      clearInterval(L.tickTimer);
      L.pollTimer = null;
      L.tickTimer = null;
    }
  }

  function render() {
    /* called by app.js after each feed.json refresh and on tab entry */
    if (!L.root) return;
    if (L.index) renderLive();
  }

  function init() {
    L.root = document.getElementById("page-live");
    if (!L.root) return;
    L.root.innerHTML = "";
    L.root.appendChild(el("div", "lv-banners"));
    var intro = el("p", "lv-empty-state", "No live books right now.");
    intro.hidden = true;
    L.root.appendChild(intro);
    L.root.appendChild(el("div", "book-tile-grid lv-blocks"));
    L.pending = lsGetJSON(LS_PENDING, []);
    if (!Array.isArray(L.pending)) L.pending = [];
    L.pending = L.pending.filter(function (c) { return c && c.id && Date.now() - c.ts < 24 * 3600 * 1000; });
    L.pending.forEach(function (c) { if (c.state === "sending") c.state = "failed"; });
    L.decided = lsGetJSON(LS_DECIDED, {});
    if (!L.decided || typeof L.decided !== "object") L.decided = {};
    var pass = lsGet(LS_PASS);
    if (pass && window.crypto && crypto.subtle) {
      deriveKeys(pass).then(function (keys) {
        L.keys = keys;
        ensureSubscription();
        refreshChatChrome();
      }).catch(function () { /* unusable passcode: stay locked */ });
    }
    var lastW = window.innerWidth;
    window.addEventListener("resize", function () {
      if (!L.active || window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      requestAnimationFrame(layoutUnits); // tile text wraps differently at a new width
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && L.active) poll();
    });
    if (typeof currentRoute === "function" && currentRoute() === "live") setActive(true);
  }

  window.LiveTab = {
    render: render,
    setActive: setActive,
    _test: { deriveKeys: deriveKeys, signPayload: signPayload, state: L },
  };

  document.addEventListener("DOMContentLoaded", init);
})();
