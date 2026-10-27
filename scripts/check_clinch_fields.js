// Prints the new per-row fields for secured Clinch rows; exits 1 if any are missing.
const fs = require("fs"), path = require("path");
const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "clinch.json"), "utf8"));
const rows = [];
(d.days || []).forEach(function (day) { (day.targets || []).forEach(function (t) { if (Number(t.contracts) > 0) rows.push(t); }); });
if (!rows.length) { console.log("no secured rows yet"); process.exit(0); }
let bad = 0;
rows.forEach(function (t) {
  console.log([t.player, t.stat_word, t.line, t.side_word, t.stat_now, t.cost, t.to_win, t.status].join(" | "));
  ["player", "stat_word", "line", "side_word", "to_win"].forEach(function (k) {
    if (t[k] === undefined || t[k] === null) { console.log("  MISSING " + k + " on " + t.ticker); bad = 1; }
  });
});
process.exit(bad);
