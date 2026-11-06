// The answer box, as pure functions: one box per parked question of an address, which sends the
// person's answer through the worker's `address.send` (`jig send <address> answer <key> <text>`).
// Before it sends it shows the text and the address it goes to; after, what `jig send` printed,
// as sent or not sent. The inbox and the thread draw the same box for the same question, so a
// draft typed in one is there in the other. Drafts live only in the open page.
import { esc, openableUrl } from './util.mjs'

/** A box's key across views and reads: the address and the question's key, on two lines. */
export function boxKey(address, key) {
  return `${address}\n${key}`
}

/** The line `jig send` writes for an answer, as the person reads it before sending. */
export function answerLine(key, text) {
  return `answer ${key}: ${String(text ?? '').trim()}`
}

function resultHtml(send) {
  const r = send.result ?? {}
  const printed = r.printed ? `<details class="fold"><summary class="sm">What jig send printed</summary><pre class="printed">${esc(r.printed)}</pre></details>` : ''
  if (send.stage === 'sent') {
    const url = openableUrl(r.wrote)
    return `<div class="sent sm" role="status"><b>Sent.</b>${
      r.wrote ? ` Jig wrote ${url ? `<button type="button" class="link" data-open-url="${esc(url)}">the comment ↗</button>` : `<span class="m">${esc(r.wrote)}</span>`}` : ''
    }${r.writesAs ? `<div class="mut">As ${esc(r.writesAs)}.</div>` : ''}</div>${printed}`
  }
  return `<div class="failed sm" role="alert"><b>Not sent:</b> ${esc(r.why ?? 'no reason was given.')}</div>${printed}`
}

/**
 * The box for one question of `address`. `drafts` holds what was typed, by `boxKey`, and
 * `sends` each box's step: `review` (the text, shown before it is sent), `sending`, `sent` or
 * `failed`, with the worker's `result`.
 */
export function questionBoxHtml(address, question, { drafts = new Map(), sends = new Map() } = {}) {
  const k = boxKey(address, question.key)
  const send = sends.get(k) ?? null
  const data = `data-address="${esc(address)}" data-key="${esc(question.key)}"`
  const head = `<span class="sm mut">Answer <span class="m">${esc(question.key)}</span>${
    question.question ? `: ${esc(question.question)}` : ''
  }</span>`
  if (send?.stage === 'review' || send?.stage === 'sending')
    return `<div class="box confirm" data-box="${esc(k)}">${head}
      <p class="sm">Sends to <span class="m">${esc(address)}</span>, through <span class="m">jig send</span>:</p>
      <pre class="line">${esc(answerLine(question.key, send.text))}</pre>
      <div class="acts">${
        send.stage === 'sending'
          ? '<span class="sm mut">Sending through jig send…</span>'
          : `<button type="button" class="primary" data-answer="send" ${data}>Send</button>
        <button type="button" class="ghost" data-answer="edit" ${data}>Edit</button>`
      }</div>
    </div>`
  if (send?.stage === 'sent')
    return `<div class="box" data-box="${esc(k)}">${head}<pre class="line">${esc(answerLine(question.key, send.text))}</pre>${resultHtml(send)}</div>`
  return `<div class="box" data-box="${esc(k)}">${head}
    ${send?.stage === 'failed' ? resultHtml(send) : ''}
    <textarea rows="2" data-draft="${esc(k)}" aria-label="${esc(`Answer ${question.key}`)}" placeholder="Your answer, in one line">${esc(drafts.get(k) ?? '')}</textarea>
    <div class="acts"><button type="button" data-answer="review" ${data}>Review answer</button></div>
  </div>`
}

/** Every question's box for `address`, and what an answer is. */
export function answerBoxesHtml(address, questions, options) {
  if (!address || questions.length === 0) return ''
  return `<div class="replies">${questions.map((q) => questionBoxHtml(address, q, options)).join('')}
    <p class="sm mut">Each answer is sent on its own, as a comment on the pull request. Drafts are kept only while this panel stays open.</p>
  </div>`
}
