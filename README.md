# Kalshi Command Center

A live page showing what Blake's Kalshi house books are doing right now, and
what they have done so far. Public URL:
https://bpangman.github.io/kalshi-command-center/

## What the site shows, top to bottom

1. **Header strip** - four numbers: cash sitting free, cash locked up as
   collateral in open books, total profit banked since go-live (9/15), and
   the worst-to-best range (plus expected value) across every book that is
   open right now.
2. **Purse over time** - the running total of banked profit. The line has
   one dot for every day (Central time) that had at least one settled event.
   A bigger dot means more events settled that day (4 sizes: 1, 2, 3, 4 or
   more). Green dot = that day made money, red dot = it lost money. Tap or
   hover a dot to see only that day's dollars, like `+$42` or `-$9`. No event
   names are drawn on the chart; the Settled events lists have those.
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
5. **Finished, waiting for Kalshi to settle** - a book whose event is over (or
   whose bot was stopped) but whose markets Kalshi has not paid out yet. It is
   not a live book any more. The card shows what our held positions are worth
   now (the likely winner and what we make if it wins, plus worst and best
   case) and says "Awaiting settlement". When Kalshi settles, the card
   disappears and the exact realized number takes its place in Settled events.
6. **Settled events** - every finished event, newest first, with the date,
   the result, how many contracts were sold, and how much premium was
   collected.
7. **Calendar tab** - its own tab, a full month sheet (see "The Calendar
   tab" section below).

## When is a book "live"?

One rule decides it everywhere (`book_liveness` in `tools/feed/publish.py`).
A book is **live** only if all of these are true: its bot checked in
recently, Kalshi has not settled its markets, no DONE marker exists, and the
bot's own live feed does not say the event is over. Otherwise:

- **Awaiting settlement** - finished (DONE marker, or the event is over) but
  Kalshi has not finalized the markets yet. Shown in its own section.
- **Not checking in** - the bot went quiet while the event was unfinished.
  Shown in the same section so a crashed bot is never hidden.
- **Settled** - Kalshi finalized every market. The result moves to Settled
  events. The result is only written once Kalshi has written all of our
  settlement rows and named the winner (a golf book was once booked early
  from half-written rows, see the 2026-10-04 note in publish.py).

## How the data gets here

Since 2026-10-04 a small always-on program on Blake's Mac mini, the **feed
daemon** (`tools/feed/daemon.py`, launchd job `com.kalshi.feed-daemon`), does
this job. It listens to Kalshi over one websocket for the live books' prices,
order books, our orders, fills and positions, keeps them in memory, and
publishes from that plus the bots' own heartbeat files. It only asks Kalshi's
normal API for the account balance and open positions (every 5 minutes), each
unsettled event's details (every 5 minutes, and instantly when Kalshi pushes a
change), a double-check of positions and resting orders (every 10 minutes),
and settlements once an event is finalized. That is roughly 150 requests an
hour, against about 1,500 an hour for the old once-a-minute job. If the
websocket goes quiet for over a minute the daemon falls back to the normal API
for those reads until it is back. The daemon finds new books by itself (any
folder in `tools/fleet/state/` with a heartbeat, plus slate files and loaded
book jobs), so a new event needs no code change. It logs to
`tools/fleet/state/feed/daemon.log`, including the exact request count every
hour.

### Switching back to the old once-a-minute job

The old job (`com.kalshi.feed`) is turned off but its file is kept at
`tools/feed/launchd/com.kalshi.feed.plist`. To switch back:

```
launchctl bootout gui/$(id -u)/com.kalshi.feed-daemon
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kalshi.feed.plist
```

(the `com.kalshi.feed.plist` copy in `~/Library/LaunchAgents` is the same
file). Both programs take the same lock before publishing, so they can never
overwrite each other even if both are on for a minute.

### What the old job did (still the same data)

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
- **If it ended now / Best** on a book is the range of outcomes across
  every possibility still on the board: the worst case if nothing else
  ever fills, and the best case.
- **Break glass** is not a prediction - it is what Blake could actually
  lock in this minute by trading against the real order book right now
  (buying back the worst outcome, selling more of the best one). The
  page only ever shows this number; it never places a trade itself.
- **Market-implied outcome (trend 15m)** is a probability-weighted view
  of the book using the best live odds available (the bot's own blended
  view when the game is in play, otherwise the market's own prices),
  plus how that number has moved in the last 15 minutes. We dropped the
  old "EV" figure because it was misleading - it either assumed every
  resting order fills, or was just an average of every position,
  neither of which is a real number Blake could act on.
- **Collected** is the running principal each book has taken in: premium
  from sales, minus fees, equals net - plus "margin over fair" (banked
  edge above what the bot judged fair at the time) once the bot reports
  one.
- Each recorded fill shows **Fair** (the best estimate of fair value at
  that moment - the bot's own blended odds when fresh, else the market's
  own mid price, else the last trade) and **Margin** (how much better
  than fair that fill did, in cents, green for better than fair and red
  for worse). A fill's margin is captured once and never changes later,
  even if a later, better fair-value read comes in.
- A red **Stale** badge in the header means the page has not heard from the
  publisher in over 3 minutes, or one of the live books has not checked in
  with its own heartbeat in over 2 minutes. It does not mean the bot placed
  a bad trade, just that this page's picture of it might be out of date.

## The Calendar tab

A month sheet (Sun-Sat, Central time, today highlighted, prev/next arrows).
Every event of ours gets up to two small chips showing only its short name:

- **Amber chip** - the day the event was **first posted on Kalshi** (the
  earliest order the book ever posted; if that is unknown, the day its slate
  was armed).
- **Blue chip** - the day the event **takes place** (kickoff, green flag, or
  for golf the final-round day).

A small legend under the sheet repeats the two colors. Tap a chip for more
detail (full title, both dates, and the result once it has settled). On a
phone the sheet becomes a list of days, skipping days with nothing on them.
Games we never traded drop off after their day passes; upcoming scheduled
games (from the ESPN schedule or Blake's list) show as blue event-day chips
with no amber chip, since nothing has been posted yet.

The calendar reads `data/calendar.json`; each row carries `posted_iso` and
`event_iso`. Settled events carry their `first_posted_time` in
`data/results.json`.

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
