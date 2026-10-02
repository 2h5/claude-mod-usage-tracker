// usage-dash: a live usage dashboard.
// - A one-line band above the prompt: context fill, plan limits, session cost
// - /dash opens a pane with bars, reset countdowns, a context sparkline,
//   and today's cost across every session on this machine
// - /dash band toggles the band

const PANE = 'usage-dash'
const HISTORY_MAX = 24
const KEEP_DAYS = 8

// Latest figures from $.session.usage() or session.measure
let usage = { context: { window: 0 }, rateLimits: [] }
// Context percent after each turn, oldest first
let history = []
let showBand = true
let sessionId = ''
let todayUsd = 0
let todaySessions = 0
let compacting = false

const SPARK = '▁▂▃▄▅▆▇█'

function bar(pct, width) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// A rounded, smooth bar like Claude Code's own /usage bars. Desktop only: SVG isn't drawn in the terminal.
function smoothBar(Svg, pct, width, height) {
  const p = Math.max(0, Math.min(100, pct))
  const r = height / 2
  const fill = p > 0 ? Math.max(height, (p / 100) * width) : 0
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
    '<rect width="' + width + '" height="' + height + '" rx="' + r + '" fill="#808080" fill-opacity="0.28"/>' +
    (fill ? '<rect width="' + fill + '" height="' + height + '" rx="' + r + '" fill="' + colorFor(p) + '"/>' : '') +
    '</svg>'
  return Svg({ source, alt: Math.round(p) + '% used', width, height })
}

// The smooth bar on desktop, block characters in the terminal
function meterBar(els, surface, pct, px, cols) {
  if (surface === 'desktop') return smoothBar(els.Svg, pct, px, 6)
  return els.Text({ color: colorFor(pct), children: [bar(pct, cols)] })
}

function colorFor(pct) {
  if (pct >= 85) return '#e5534b'
  if (pct >= 60) return '#d4a72c'
  // The blue Claude Code's own /usage bars use
  return '#2a78d6'
}

function sparkline(values) {
  return values.map((v) => SPARK[Math.max(0, Math.min(7, Math.floor((v / 100) * 8)))]).join('')
}

function tokens(n) {
  if (n == null) return '?'
  // Whole numbers only, rounded down: 170,500 -> 170k
  if (n >= 1_000_000) return Math.floor(n / 1_000_000) + 'M'
  if (n >= 1000) return Math.floor(n / 1000) + 'k'
  return String(n)
}

function usd(n) {
  return '$' + (n ?? 0).toFixed(2)
}

// Time left until a reset, without the "resets in" words
function timeLeft(iso) {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!(ms > 0)) return ''
  const mins = Math.floor(ms / 60000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return d + 'd ' + h + 'h'
  if (h > 0) return h + 'h ' + m + 'm'
  return m + 'm'
}

function countdown(iso) {
  if (!iso) return ''
  const left = timeLeft(iso)
  return left ? 'resets in ' + left : 'resetting'
}

// Weekly pacing: an even spread is 100% over 7 days (~14.3% a day).
// Green when at or under that pace, yellow when up to a day ahead of it, red when a day or more ahead.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
function weeklyPaceColor(percentUsed, resetsAt) {
  if (!resetsAt) return undefined
  const left = new Date(resetsAt).getTime() - Date.now()
  const elapsed = Math.min(WEEK_MS, Math.max(0, WEEK_MS - left))
  const onPace = (elapsed / WEEK_MS) * 100
  const daysAhead = (percentUsed - onPace) / (100 / 7)
  if (daysAhead <= 0) return '#3fb950'
  if (daysAhead < 1) return '#d4a72c'
  return '#e5534b'
}

function limitName(kind, short) {
  if (kind === 'five_hour') return short ? '5h' : 'Session (5h)'
  if (kind === 'seven_day') return short ? '7d' : 'Weekly (7d)'
  if (kind === 'spend_limit') return short ? 'spend' : 'Spend limit'
  return kind
}

function localDay(time) {
  const d = new Date(time)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

// Save this session's cost under its own key, so sessions don't overwrite each other
async function saveCost($) {
  if (!sessionId || usage.cost == null) return
  await $.store.set('cost:' + sessionId, { usd: usage.cost.usd, day: localDay(Date.now()), at: Date.now() })
}

// Sum the cost of every session on this machine that was active today, and prune old entries
async function refreshToday($) {
  const today = localDay(Date.now())
  const cutoff = Date.now() - KEEP_DAYS * 86400000
  let total = 0
  let count = 0
  for (const key of await $.store.keys()) {
    if (!key.startsWith('cost:')) continue
    const entry = await $.store.get(key)
    if (!entry || entry.at < cutoff) {
      await $.store.delete(key)
      continue
    }
    if (entry.day === today) {
      total += entry.usd
      count += 1
    }
  }
  todayUsd = total
  todaySessions = count
}

// Prompt-cache totals over every model request since the mod loaded, subagents included
let cacheRead = 0
let promptTokens = 0

// Share of prompt tokens served from the cache, or null before the first request
function cacheHitPct() {
  return promptTokens > 0 ? Math.round((cacheRead / promptTokens) * 100) : null
}

// Spinner frames for the band while a compaction runs
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
let spinFrame = 0
let spinTimer = null

function setCompacting($, on) {
  compacting = on
  if (spinTimer) spinTimer.cancel()
  spinTimer = on
    ? $.clock.every(100, () => {
        spinFrame = (spinFrame + 1) % SPIN.length
        $.ui.invalidate('ui.render')
      })
    : null
  $.ui.invalidate('ui.render')
}

// Band layouts, fullest first. Each step gives up one thing to keep the reset times in view:
// the "resets in" words, then the cache figure, then minutes, then the limit bars, then the ctx bar.
const BAND_LAYOUTS = [
  { resetWords: true, cache: true, exactTime: true, limitBars: true, ctxBar: true },
  { resetWords: false, cache: true, exactTime: true, limitBars: true, ctxBar: true },
  { resetWords: false, cache: false, exactTime: true, limitBars: true, ctxBar: true },
  { resetWords: false, cache: false, exactTime: false, limitBars: true, ctxBar: true },
  { resetWords: false, cache: false, exactTime: false, limitBars: false, ctxBar: true },
  { resetWords: false, cache: false, exactTime: false, limitBars: false, ctxBar: false },
]

// Time left in its largest unit only: 3h 34m -> 3h
function roughTimeLeft(iso) {
  return timeLeft(iso).split(' ')[0]
}

// The band's pieces for one layout, and roughly how many cells wide they come to
function bandParts(els, surface, layout) {
  const { Text } = els
  const parts = []
  let width = 0
  const add = (node, cells) => {
    width += (parts.length ? 1 : 0) + cells
    parts.push(node)
  }
  const text = (s, props = {}) => add(Text({ ...props, children: [s] }), s.length)
  // A desktop bar is drawn in pixels; count about 7 per cell so the estimate errs wide
  const meter = (pct, px, cols) => add(meterBar(els, surface, pct, px, cols), surface === 'desktop' ? Math.ceil(px / 7) : cols)

  const ctx = usage.context
  if (ctx.percent != null) {
    text('ctx', { dimColor: true })
    if (layout.ctxBar) meter(ctx.percent, 90, 10)
    text(tokens(ctx.tokens))
  } else {
    text('ctx —', { dimColor: true })
  }
  const hit = cacheHitPct()
  if (layout.cache && hit != null) {
    text('·', { dimColor: true })
    text('cache', { dimColor: true })
    text(hit + '%')
  }
  // Each limit as its own group: label, small bar, percent, and when it resets
  for (const limit of usage.rateLimits) {
    text('│', { dimColor: true })
    text(limitName(limit.kind, true), { dimColor: true })
    if (layout.limitBars) meter(limit.percentUsed, 40, 5)
    text(limit.percentUsed + '%')
    const left = layout.exactTime ? timeLeft(limit.resetsAt) : roughTimeLeft(limit.resetsAt)
    if (!left) {
      if (limit.resetsAt) text('resetting', { dimColor: true })
      continue
    }
    text(layout.resetWords ? 'resets in' : '↻', { dimColor: true })
    // Only the weekly time is coloured, by whether the week's usage is on pace
    if (limit.kind === 'seven_day') text(left, { color: weeklyPaceColor(limit.percentUsed, limit.resetsAt) })
    else text(left, { dimColor: true })
  }
  if (usage.cost != null) {
    text('│', { dimColor: true })
    text(usd(usage.cost.usd))
  }
  return { parts, width }
}

async function poll($) {
  usage = await $.session.usage()
  await saveCost($)
  await refreshToday($)
  $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const saved = await $.store.get('band')
    if (typeof saved === 'boolean') showBand = saved
    await poll($)
    // Keep reset countdowns and the machine-wide total current between turns
    $.clock.every(30_000, () => poll($))
    try {
      await $.command.register({
        name: 'dash',
        description: 'Open the usage dashboard, or "/dash band" to toggle the band above the prompt',
        argumentHint: '[band]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('could not register /dash: ' + err.message)
    }
    return next(e)
  })

  // Pushed after each turn and whenever a limit moves a whole point
  on('session.measure', async ($, e, next) => {
    usage = { context: e.context, rateLimits: e.rateLimits, cost: e.cost }
    if (e.changed.includes('context') && e.context.percent != null) {
      history = [...history, e.context.percent].slice(-HISTORY_MAX)
    }
    if (e.changed.includes('cost')) {
      await saveCost($)
      await refreshToday($)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Any compaction, typed, automatic or from the button: show the spinner while it runs
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute') return next(e)
    setCompacting($, true)
    try {
      return await next(e)
    } finally {
      setCompacting($, false)
    }
  })

  on('command.run', { command: 'dash' }, async ($, e) => {
    if (e.args.trim() === 'band') {
      showBand = !showBand
      await $.store.set('band', showBand)
      $.ui.invalidate('ui.render')
      return { text: 'Usage band ' + (showBand ? 'on' : 'off') }
    }
    await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true })
    return {}
  })

  // Each model request: pass the response through untouched, then add up its cache counts
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (r.usage) {
      cacheRead += r.usage.cache_read_input_tokens
      promptTokens += r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
      $.ui.invalidate('ui.render')
    }
    return r
  })

  // The one-line band above the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    // Spinner on the right edge while a compaction runs
    const spin = SPIN[spinFrame] + ' compacting…'
    const right = compacting ? Text({ color: '#2a78d6', children: [spin] }) : null

    // Pick the fullest layout that fits the window, so the reset times are never cut off
    const room = (e.viewport?.columns ?? Infinity) - 2 - (compacting ? spin.length + 3 : 0)
    let band
    for (const layout of BAND_LAYOUTS) {
      band = bandParts(els, e.surface, layout)
      if (band.width <= room) break
    }
    // Centred when it all fits, otherwise left-aligned so the end is what gets cut
    const fits = band.width <= room

    // Keep whatever other mods draw in the band
    const rest = await next(e)
    const row = Box({
      flexDirection: 'row',
      justifyContent: fits ? 'center' : 'space-between',
      columnGap: 3,
      children: [Box({ flexDirection: 'row', columnGap: 1, alignItems: 'center', children: band.parts }), ...(right ? [right] : [])],
    })
    return rest ? Box({ flexDirection: 'column', children: [row, rest] }) : row
  })

  // The /dash pane
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const width = Math.max(10, Math.min(40, (e.props.bodyColumns ?? 60) - 24))
    const ctx = usage.context
    const rows = []

    const heading = (label) => Text({ bold: true, children: [label] })
    const meter = (pct, right) =>
      Box({
        flexDirection: 'row',
        columnGap: 1,
        alignItems: 'center',
        children: [
          meterBar(els, e.surface, pct, 220, width),
          Text({ bold: true, children: [pct + '%'] }),
          Text({ dimColor: true, children: [right] }),
        ],
      })

    rows.push(heading('Context window'))
    if (ctx.percent != null) {
      rows.push(meter(ctx.percent, tokens(ctx.tokens)))
    } else {
      rows.push(Text({ dimColor: true, children: ['No reading yet: send a prompt first (' + tokens(ctx.window) + ' window)'] }))
    }
    if (history.length > 1) {
      rows.push(
        Text({ dimColor: true, children: ['Last ' + Math.min(history.length, HISTORY_MAX) + ' turns  ' + sparkline(history)] }),
      )
    }
    const hit = cacheHitPct()
    rows.push(
      Text({
        children: [
          'Cache hit       ' +
            (hit != null ? hit + '%  (' + tokens(cacheRead) + ' of ' + tokens(promptTokens) + ' prompt tokens)' : 'no requests yet'),
        ],
      }),
    )

    rows.push(Text({ children: [' '] }), heading('Plan limits (your account)'))
    if (usage.rateLimits.length === 0) {
      rows.push(Text({ dimColor: true, children: ['No reading yet, or not on a subscription plan'] }))
    }
    for (const limit of usage.rateLimits) {
      rows.push(Text({ children: [limitName(limit.kind, false)] }), meter(Math.min(100, limit.percentUsed), countdown(limit.resetsAt)))
    }

    rows.push(Text({ children: [' '] }), heading('Cost (API-equivalent)'))
    rows.push(
      Text({ children: ['This session    ' + (usage.cost != null ? usd(usage.cost.usd) : '—')] }),
      Text({
        children: ['Today, this PC  ' + usd(todayUsd) + '  (' + todaySessions + ' session' + (todaySessions === 1 ? '' : 's') + ')'],
      }),
    )

    rows.push(
      Text({ children: [' '] }),
      Box({
        flexDirection: 'row',
        columnGap: 3,
        children: [
          Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, onPress: () => poll($) }),
          Button({
            key: 'band',
            label: 'Band ' + (showBand ? 'off' : 'on'),
            hotkey: 'b',
            plain: true,
            onPress: async () => {
              showBand = !showBand
              $.ui.invalidate('ui.render')
              await $.store.set('band', showBand)
            },
          }),
        ],
      }),
    )

    return Box({ flexDirection: 'column', children: rows })
  })
}
