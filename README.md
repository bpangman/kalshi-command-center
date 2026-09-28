# Kalshi Command Center

A live page showing what Blake's Kalshi house books are doing right now, and
what they have done so far. Public URL:
https://bpangman.github.io/kalshi-command-center/

## What the site shows, top to bottom

1. **Header strip** - four numbers: cash sitting free, cash locked up as
   collateral in open books, total profit banked since go-live (9/15), and
   the worst-to-best range (plus expected value) across every book that is
   open right now.
2. **Purse over time** - a running total of banked profit, one step up or
   down for each settled event. The dashed line, when there is enough
   history, adds back the current value of whatever is still open, so you
   can see the difference between "money in the bank" and "money on the
   table."
3. **One card per sport** (NFL, NASCAR, F1, Golf) - that sport's own running
   total, a quick stat line (events, total, best, worst), and a "How the
   strategy works" dropdown written in plain English.
4. **Live books** - the main event. One card per book that is currently
   trading: what it is, whether it is pre-game or in play, a colored dot for
   whether the bot is still checking in on schedule, how much cash is
   allocated to it, a full table of every outcome (how many contracts we are
   holding, how many more are resting in the order book, the current price,
   and what we would make or lose if that exact outcome happened right
   now), and the most recent fills. 2026-09-28: a green banner ("Floor
   mode: guaranteed +$96") appears once the bot has locked in a guaranteed
   minimum and switched to only-raise-it mode; right below that, a small
   line shows how much the bot has posted/filled in the last 10-30
   minutes, with an amber "Inactive" note (and which of its own safety
   causes/remedies is at play) if the bot's own activity watchdog has
   flagged itself as stuck. Both are a straight read of the bot's own
   heartbeat.json, never re-derived here.
5. **Settled events** - every finished event, newest first, with the date,
   the result, how many contracts were sold, and how much premium was
   collected.

## How the data gets here

A small Python program (`tools/feed/publish.py` in the main `kalshi` repo on
Blake's Mac mini) runs once a minute. It reads Blake's own account (balance,
positions, resting orders, fills) straight from Kalshi using the same
read-only functions the trading bots' own auditors use, so the math here
matches the math the bots trust. It never places, changes, or cancels a
single order - it only reads.

Every run it writes fresh JSON files into this repo's `data/` folder and
pushes them to GitHub. GitHub Pages serves this same repo as a website, so a
few seconds after the publisher pushes, this page's next 60-second refresh
picks up the new numbers. There is no server behind this site other than
GitHub Pages itself - it is a plain, static page that reads a few JSON files.

The publisher pushes more often while something is actually happening
(every 2 minutes if a book is in play or about to start, every 5 minutes if
a book is sitting pre-game, every 30 minutes otherwise), and it always
pushes right away if a new event just settled.

## How to read the numbers

- **Money** is always shown as `+$1,234` or `-$56`. Green is money we would
  make, red is money we would lose. The sign is always there too, so the
  color is never the only way to tell.
- **Prices** are shown in cents, like `7c` for 7 cents. A Kalshi contract is
  worth $1 if it wins and $0 if it loses, so a price of 7c means the market
  thinks that outcome is unlikely (roughly a 7% chance), and it only cost 7
  cents to take the other side of it.
- **"If this wins"** is the number that matters most on a live book: if that
  exact outcome happened right now, with no more trading, this is what we
  would make or lose, counting only the contracts we already hold (not the
  ones still resting, unfilled, in the order book).
- **Worst / EV / Best** on a book is the range of outcomes across every
  possibility still on the board (worst case, an average weighted by how
  likely each outcome looks, and best case).
- A red **Stale** badge in the header means the page has not heard from the
  publisher in over 3 minutes, or one of the live books has not checked in
  with its own heartbeat in over 2 minutes. It does not mean the bot placed
  a bad trade, just that this page's picture of it might be out of date.

## Adding a new sport or a new book

Nothing on this site needs to change for a new event of a sport it already
knows (a new NASCAR race, a new NFL game, and so on) - the publisher
discovers live books automatically from `tools/fleet/state/` on the Mac
mini and this page renders whatever it finds. Adding a genuinely new sport
(one whose ticker prefix isn't already NFL/NASCAR/F1/Golf) means two small
edits on the publisher side (`tools/feed/publish.py`'s `SPORT_PREFIXES`
list) and adding that sport's name to `app.js`'s `SPORTS` list and
`STRATEGY_BULLETS` object, then letting the next publish push the change.

## What this site will never do

It cannot place, cancel, or change a Kalshi order, and it has no access to
do so - it is a read-only display of data the publisher already wrote to
files. It also never texts or emails Blake; it is purely something to look
at when he wants to check in.
