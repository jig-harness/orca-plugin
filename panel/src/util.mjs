// What every view of the panel shares: escaping, ages in the dashboard's words, and which links
// open. Pure functions; nothing here reaches Orca.

export const MINUTE_MS = 60_000

/** Text made safe to put in HTML, attributes included. */
export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

/** A number of whole minutes as the dashboard says it: `47 min`, `1 h 17 min`, `3 d`. */
export function span(minutes) {
  const whole = Math.max(0, Math.floor(minutes))
  if (whole < 60) return `${whole} min`
  const hours = Math.floor(whole / 60)
  const rest = whole % 60
  if (hours >= 48) return `${Math.floor(hours / 24)} d`
  return `${hours} h${rest > 0 ? ` ${rest} min` : ''}`
}

/** How long ago a time was, in whole minutes; `?` when it does not read. */
export function ago(iso, nowMs) {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? span((nowMs - at) / MINUTE_MS) : '?'
}

/** `1 session`, `3 sessions`. */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** Only the forge's or tracker's own https link opens; anything else is not a link. */
export function openableUrl(url) {
  return typeof url === 'string' && /^https:\/\/[^/\s]+\//i.test(url) ? url : null
}
