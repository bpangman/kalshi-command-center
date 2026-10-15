"use strict";

/* LIVE tab (Blake, 2026-10-14) - vanilla JS, no build step. Loaded after
   app.js and uses its globals (state, fetchJSON, buildBookCard,
   timeAgoText). For every book in data/live/index.json it shows the
   book's numbers card (from data/feed.json), a pinned "What happens next"
   plan card, a scrollable running feed, an audit-alerts drawer behind a
   button, and a chat box that talks to the operator through ntfy.sh (see
   tools/live/README-LIVE.md section 4 in the main repo for the wire
   contract). Plain hyphens only, no em/en dashes, anywhere in this file. */

(function () {
  var POLL_MS = 30000;
  var MAX_ITEMS = 400;
  var FLEET = "_fleet";
  var LS_PASS = "kcc_live_passcode";
  var LS_PENDING = "kcc_live_pending";
  var LS_DECIDED = "kcc_live_decided";
  var LS_SEEN = "kcc_live_audit_seen_";
  var NO_ANSWER_HINT_MS = 45000;
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

  function orderedBooks(list) {
    return list.slice().sort(function (a, c) {
      var al = a.live ? 0 : 1, cl = c.live ? 0 : 1;
      if (al !== cl) return al - cl;
      if (a.live) {
        return (startMs(a) - startMs(c)) || String(a.title || a.key).localeCompare(String(c.title || c.key));
      }
      /* recently finished books: freshest activity first */
      return String(c.last_post_ts || "").localeCompare(String(a.last_post_ts || "")) || String(a.key).localeCompare(String(c.key));
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
    body.appendChild(document.createTextNode(it.text));
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

  function renderPlan(B, plan) {
    var sig = plan ? JSON.stringify(plan) : "";
    if (sig === B.planSig) return;
    B.planSig = sig;
    var box = B.planEl;
    box.innerHTML = "";
    if (!plan) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    var top = el("div", "lv-plan-top");
    top.appendChild(el("span", "lv-plan-label", "What happens next"));
    var age = el("span", "lv-age lv-plan-age", agoText(plan.ts));
    age.setAttribute("data-ago", plan.ts || "");
    top.appendChild(age);
    box.appendChild(top);
    if (plan.headline) box.appendChild(el("h3", "lv-plan-headline", plan.headline));

    var chips = el("div", "lv-plan-chips");
    if (plan.phase) chips.appendChild(el("span", "lv-chip lv-chip-phase", plan.phase));
    var conf = String(plan.confidence || "").toLowerCase();
    if (conf === "high" || conf === "medium" || conf === "low") {
      chips.appendChild(el("span", "lv-chip lv-conf lv-conf-" + conf, "Confidence: " + conf));
    }
    chips.appendChild(el("span", "lv-plan-checks", "Bot checks every " + (plan.checks_every_s || 30) + " s"));
    box.appendChild(chips);
    if (plan.confidence_note) box.appendChild(el("p", "lv-conf-note", plan.confidence_note));

    if (Array.isArray(plan.sections) && plan.sections.length) {
      var grid = el("div", "lv-sections");
      plan.sections.forEach(function (s) {
        var sec = el("div", "lv-sec");
        sec.appendChild(el("h4", null, s.title || ""));
        var ul = el("ul");
        (s.lines || []).forEach(function (ln) { ul.appendChild(el("li", null, ln)); });
        sec.appendChild(ul);
        grid.appendChild(sec);
      });
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
        what.appendChild(el("strong", null, st.label || ""));
        if (st.detail) what.appendChild(el("span", "lv-step-detail", " - " + st.detail));
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
    B.auditBtn.firstChild.textContent = "Audit alerts (" + n + ")";
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
      renderDrawer(B);
      markAuditsSeen(B.key);
      removeBanner(B.key);
    }
    renderAuditButton(B);
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
    var ta = el("textarea", "lv-chat-input");
    ta.rows = 2;
    ta.maxLength = 1000;
    ta.placeholder = "Ask the operator about this book...";
    ta.setAttribute("aria-label", "Message for " + B.key);
    chat.appendChild(ta);
    var row = el("div", "lv-chat-row");
    var send = el("button", "lv-btn", "Send");
    send.type = "button";
    row.appendChild(send);
    row.appendChild(el("span", "lv-chat-tip", "Ctrl+Enter sends. Changes always wait for your Confirm."));
    var lock = el("button", "lv-link lv-lock", "Lock");
    lock.type = "button";
    lock.hidden = !L.keys;
    lock.addEventListener("click", lockChat);
    row.appendChild(lock);
    chat.appendChild(row);

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
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
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

  /* -- blocks -- */

  function buildBlock(key) {
    var B = { key: key, cache: {}, inited: false, drawerOpen: false, planSig: null, drawerSig: null, cardGen: null, cardKey: null, newestKey: null };
    var root = el("section", "lv-block");
    root.id = "lv-" + key;
    B.el = root;

    var head = el("div", "lv-head");
    B.titleEl = el("h2", "lv-title");
    B.sportEl = el("span", "sport-tag");
    B.pillEl2 = el("span", "lv-livepill");
    B.subEl = el("span", "lv-sub");
    head.appendChild(B.titleEl);
    head.appendChild(B.sportEl);
    head.appendChild(B.pillEl2);
    head.appendChild(B.subEl);
    root.appendChild(head);
    B.headEl = head;

    B.cardSlot = el("div", "lv-card-slot");
    root.appendChild(B.cardSlot);

    B.planEl = el("div", "lv-plan");
    B.planEl.hidden = true;
    root.appendChild(B.planEl);

    var fh = el("div", "lv-feedhead");
    fh.appendChild(el("h3", null, key === FLEET ? "Fleet feed" : "Live feed"));
    var ab = el("button", "lv-btn lv-btn-ghost lv-audit-btn");
    ab.type = "button";
    ab.appendChild(document.createTextNode("Audit alerts (0)"));
    B.auditDot = el("span", "lv-reddot");
    B.auditDot.hidden = true;
    ab.appendChild(B.auditDot);
    ab.addEventListener("click", function () { setDrawer(B, !B.drawerOpen); });
    B.auditBtn = ab;
    fh.appendChild(ab);
    root.appendChild(fh);

    B.drawerEl = el("div", "lv-drawer");
    B.drawerEl.hidden = true;
    root.appendChild(B.drawerEl);

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
    root.appendChild(fw);

    if (key !== FLEET) root.appendChild(buildChat(B));
    return B;
  }

  function feedBookFor(key) {
    var list = (state.feed && state.feed.books) || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function updateBlock(B, entry, isFleet) {
    var fb = isFleet ? null : feedBookFor(B.key);
    /* header */
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
    /* numbers card */
    if (!isFleet) {
      var gen = state.feed ? state.feed.generated_at : null;
      if (fb) {
        if (B.cardGen !== gen || B.cardKey !== fb.key || !B.cardNode) {
          var card = buildBookCard(fb, { defaultCollapsed: (fb.outcomes || []).length > 12 });
          B.cardSlot.innerHTML = "";
          B.cardSlot.appendChild(card);
          B.cardNode = card;
          B.cardGen = gen;
          B.cardKey = fb.key;
        }
      } else if (B.cardNode) {
        B.cardSlot.innerHTML = "";
        B.cardNode = null;
        B.cardGen = null;
        B.cardKey = null;
      }
    }
    /* the numbers card already carries the title; keep the plain header only when there is no card */
    B.headEl.hidden = !isFleet && !!B.cardNode;
    var f = L.files[B.key];
    renderPlan(B, isFleet ? null : (f && f.plan) || null);
    renderAuditButton(B);
    if (B.drawerOpen) {
      renderDrawer(B);
      markAuditsSeen(B.key);
      renderAuditButton(B);
    }
    renderBookFeed(B);
  }

  function renderLive() {
    if (!L.root || !L.active || !L.index) return;
    var entries = orderedBooks(Array.isArray(L.index.books) ? L.index.books : []);
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
    /* the floating Live fills button would cover the chat boxes; the feeds here show fills anyway */
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
    L.root.appendChild(el("div", "lv-blocks"));
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
