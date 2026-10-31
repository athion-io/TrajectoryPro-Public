// Copyright 2026 Athion, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Server-sent events: a frame parser and a bounded reader. The reader never
// waits on a real timer itself; every wait goes through the injected clock so
// tests can drive it deterministically.

/**
 * @typedef {object} SseEvent
 * @property {number | null} id  last numeric `id:` seen, or null
 * @property {string} event  `event:` field, `message` when absent
 * @property {unknown} data  parsed JSON when the data is JSON, else the raw string
 */

/**
 * @typedef {{now: () => number, sleep: (ms: number, signal?: AbortSignal) => Promise<void>}} Clock
 */

/** @type {Clock} The real clock. An aborted signal clears the timer so the process can exit. */
export const systemClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Incremental parser following the WHATWG event-stream grammar. */
class FrameParser {
  #buffer = '';
  #lastId = null;
  #event = '';
  #data = '';

  /** Feeds text and returns the events completed by it. */
  push(text) {
    this.#buffer += text;
    const events = [];
    // A trailing CR may be the first half of a CRLF; hold it until the next chunk.
    const stop = this.#buffer.endsWith('\r') ? this.#buffer.length - 1 : this.#buffer.length;
    let start = 0;
    const re = /\r\n|\r|\n/g;
    let match;
    while ((match = re.exec(this.#buffer)) && match.index < stop) {
      const line = this.#buffer.slice(start, match.index);
      start = match.index + match[0].length;
      const event = this.#line(line);
      if (event) events.push(event);
    }
    this.#buffer = this.#buffer.slice(start);
    return events;
  }

  /** Flushes a final frame that had no trailing blank line. */
  end() {
    const events = this.#buffer === '' ? [] : this.push('\n\n');
    this.#buffer = '';
    return events;
  }

  #line(line) {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.#event = value;
        break;
      case 'data':
        this.#data += value + '\n';
        break;
      case 'id':
        if (!value.includes('\0')) this.#lastId = /^\d+$/.test(value) ? Number(value) : null;
        break;
      default:
        break;
    }
    return null;
  }

  #dispatch() {
    const data = this.#data;
    const event = this.#event;
    this.#data = '';
    this.#event = '';
    if (data === '') return null;
    const text = data.endsWith('\n') ? data.slice(0, -1) : data;
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { id: this.#lastId, event: event === '' ? 'message' : event, data: parsed };
  }
}

/**
 * Parses a whole text/event-stream body.
 * @param {string} text
 * @returns {SseEvent[]}
 */
export function parseFrames(text) {
  const parser = new FrameParser();
  return [...parser.push(text), ...parser.end()];
}

/**
 * @typedef {object} ReadOptions
 * @property {number} [max]  stop after this many events (default: unbounded)
 * @property {string} [untilEvent]  stop after an event with this `event` name
 * @property {string | string[]} [untilState]  stop after a `state_change` whose `data.state` is one of these
 * @property {number} timeoutMs  overall bound, waited through `clock.sleep`
 * @property {AbortSignal} [signal]  external cancel
 * @property {Clock} [clock]
 */

/**
 * @typedef {object} ReadResult
 * @property {SseEvent[]} events
 * @property {'count' | 'state' | 'event' | 'timeout' | 'abort' | 'end'} ended  why reading stopped
 */

/**
 * Reads events from a streaming Response until a stop condition, then cancels
 * the body so the connection is released. Never throws on timeout or abort.
 * @param {Response} response
 * @param {ReadOptions} options
 * @returns {Promise<ReadResult>}
 */
export async function readEvents(response, { max = Infinity, untilEvent, untilState, timeoutMs, signal, clock = systemClock } = {}) {
  const states = untilState === undefined ? null : new Set([].concat(untilState));
  const events = [];
  if (!response.body) return { events, ended: 'end' };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new FrameParser();
  let ended = null;

  const stop = (why) => {
    if (ended) return;
    ended = why;
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) stop('abort');
  const onAbort = () => stop('abort');
  signal?.addEventListener('abort', onAbort, { once: true });

  // Armed synchronously so a caller can observe the wait before the first read.
  const timer = new AbortController();
  clock.sleep(timeoutMs, timer.signal).then(() => {
    if (!timer.signal.aborted) stop('timeout');
  });

  const stopsOn = (event) => {
    if (untilEvent !== undefined && event.event === untilEvent) return 'event';
    if (states && event.event === 'state_change' && event.data && typeof event.data === 'object' && states.has(event.data.state)) return 'state';
    return null;
  };

  try {
    while (!ended) {
      if (events.length >= max) {
        stop('count');
        break;
      }
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (ended) break;
        throw err;
      }
      if (ended) break;
      if (chunk.done) {
        ended = 'end';
        for (const event of parser.end()) {
          events.push(event);
          const why = stopsOn(event) ?? (events.length >= max ? 'count' : null);
          if (why) {
            ended = why;
            break;
          }
        }
        break;
      }
      for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        events.push(event);
        const why = stopsOn(event);
        if (why) {
          stop(why);
          break;
        }
        if (events.length >= max) {
          stop('count');
          break;
        }
      }
    }
  } finally {
    timer.abort();
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return { events, ended };
}
