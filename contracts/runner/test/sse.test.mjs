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

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrames, readEvents } from '../src/sse.mjs';
import { fakeClock } from './fake-clock.mjs';

const encoder = new TextEncoder();

function frame(id, event, data) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function stateChange(id, state, previous = null) {
  return frame(id, 'state_change', { instance_id: 'inst-1', state, previous_state: previous, timestamp: 't' });
}

/** A text/event-stream Response whose body delivers `chunks` in order and then closes. */
function streamResponse(chunks, { close = true } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A stream that stays open and never sends a byte. */
function silentResponse() {
  return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('parseFrames', () => {
  test('parses id, event and JSON data', () => {
    const frames = parseFrames(stateChange(17, 'EXECUTING', 'STARTING'));
    assert.deepEqual(frames, [
      { id: 17, event: 'state_change', data: { instance_id: 'inst-1', state: 'EXECUTING', previous_state: 'STARTING', timestamp: 't' } },
    ]);
  });

  test('parses a heartbeat and keeps non-JSON data as a string', () => {
    const frames = parseFrames('id: 3\nevent: heartbeat\ndata: {"timestamp":"2026-02-24T10:32:00.000Z"}\n\nevent: log\ndata: plain text\n\n');
    assert.deepEqual(frames[0], { id: 3, event: 'heartbeat', data: { timestamp: '2026-02-24T10:32:00.000Z' } });
    assert.equal(frames[1].event, 'log');
    assert.equal(frames[1].data, 'plain text');
  });

  test('joins data across lines with newlines', () => {
    const frames = parseFrames('data: {"a":\ndata: 1}\n\n');
    assert.deepEqual(frames, [{ id: null, event: 'message', data: { a: 1 } }]);
  });

  test('tolerates CRLF line ends, comments and a missing trailing blank line', () => {
    const text = ': keep-alive\r\nid: 5\r\nevent: output\r\ndata: {"outputs":[]}\r\n\r\n:ping\r\n\r\nid: 6\r\nevent: state_change\r\ndata: {"state":"COMPLETED"}';
    const frames = parseFrames(text);
    assert.deepEqual(frames.map((f) => [f.id, f.event]), [[5, 'output'], [6, 'state_change']]);
    assert.deepEqual(frames[1].data, { state: 'COMPLETED' });
  });

  test('a frame without data is not an event; id without a number is null', () => {
    assert.deepEqual(parseFrames('id: 9\nevent: nothing\n\n'), []);
    const [f] = parseFrames('id: abc\ndata: x\n\n');
    assert.equal(f.id, null);
    assert.equal(f.event, 'message');
  });

  test('a later frame keeps the last id seen when it carries none', () => {
    const frames = parseFrames('id: 1\ndata: a\n\ndata: b\n\n');
    assert.deepEqual(frames.map((f) => f.id), [1, 1]);
  });

  test('a data line with no space after the colon and a field with no colon', () => {
    const [f, g] = parseFrames('event:state_change\ndata:{"state":"HELD"}\n\ndata:plain\ndata\n\n');
    assert.equal(f.event, 'state_change');
    assert.deepEqual(f.data, { state: 'HELD' });
    assert.equal(g.data, 'plain\n', 'a bare "data" field appends an empty line');
  });
});

describe('readEvents', () => {
  test('stops at the count and cancels the body', async () => {
    const clock = fakeClock();
    const response = streamResponse([stateChange(0, 'STARTING'), stateChange(1, 'EXECUTING', 'STARTING'), stateChange(2, 'COMPLETED', 'EXECUTING')], { close: false });
    const result = await readEvents(response, { max: 2, timeoutMs: 5000, clock });
    assert.equal(result.ended, 'count');
    assert.deepEqual(result.events.map((e) => e.data.state), ['STARTING', 'EXECUTING']);
    assert.equal(response.bodyUsed, true);
    assert.equal(response.body.locked, false, 'reader released');
    const after = await response.body.getReader().read();
    assert.equal(after.done, true, 'body was cancelled: the third frame is gone');
  });

  test('stops at the terminal state even if more frames follow', async () => {
    const clock = fakeClock();
    const response = streamResponse([stateChange(0, 'EXECUTING'), stateChange(1, 'COMPLETED', 'EXECUTING'), frame(2, 'heartbeat', { timestamp: 't' })]);
    const result = await readEvents(response, { max: 10, untilState: ['COMPLETED', 'ABORTED', 'STOPPED'], timeoutMs: 5000, clock });
    assert.equal(result.ended, 'state');
    assert.deepEqual(result.events.map((e) => e.id), [0, 1]);
  });

  test('a single state string works for untilState and untilEvent stops on the event name', async () => {
    const clock = fakeClock();
    const byState = await readEvents(streamResponse([stateChange(0, 'EXECUTING'), stateChange(1, 'HELD')]), { untilState: 'HELD', timeoutMs: 5000, clock });
    assert.equal(byState.ended, 'state');
    assert.equal(byState.events.length, 2);
    const byEvent = await readEvents(streamResponse([stateChange(0, 'EXECUTING'), frame(1, 'output', { outputs: [] }), stateChange(2, 'COMPLETED')]), { untilEvent: 'output', timeoutMs: 5000, clock });
    assert.equal(byEvent.ended, 'event');
    assert.equal(byEvent.events.length, 2);
  });

  test('frames split across chunks are reassembled', async () => {
    const clock = fakeClock();
    const whole = stateChange(0, 'EXECUTING') + stateChange(1, 'COMPLETED', 'EXECUTING');
    const chunks = [whole.slice(0, 20), whole.slice(20, 61), whole.slice(61)];
    const result = await readEvents(streamResponse(chunks), { max: 2, timeoutMs: 5000, clock });
    assert.deepEqual(result.events.map((e) => [e.id, e.data.state]), [[0, 'EXECUTING'], [1, 'COMPLETED']]);
  });

  test('ends when the server closes the stream before the count', async () => {
    const clock = fakeClock();
    const result = await readEvents(streamResponse([stateChange(0, 'EXECUTING')]), { max: 5, timeoutMs: 5000, clock });
    assert.equal(result.ended, 'end');
    assert.equal(result.events.length, 1);
    assert.equal(clock.sleeps[0], 5000, 'the timeout is armed through the clock');
  });

  test('times out on a stream that never ends, using only the fake clock', async () => {
    const clock = fakeClock();
    const response = silentResponse();
    const pending = readEvents(response, { max: 1, timeoutMs: 10_000, clock });
    assert.deepEqual(clock.sleeps, [10_000]);
    await clock.tick(9_999);
    await clock.tick(1);
    const result = await pending;
    assert.equal(result.ended, 'timeout');
    assert.deepEqual(result.events, []);
    assert.equal(response.body.locked, false, 'reader released after cancel');
  });

  test('a timeout after some events keeps them', async () => {
    const clock = fakeClock();
    const response = streamResponse([stateChange(0, 'EXECUTING')], { close: false });
    const pending = readEvents(response, { max: 3, timeoutMs: 1000, clock });
    await clock.tick(1000);
    const result = await pending;
    assert.equal(result.ended, 'timeout');
    assert.equal(result.events.length, 1);
  });

  test('stops when the signal aborts', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const pending = readEvents(silentResponse(), { max: 1, timeoutMs: 10_000, signal: controller.signal, clock });
    controller.abort();
    const result = await pending;
    assert.equal(result.ended, 'abort');
  });

  test('a response without a body ends at once', async () => {
    const clock = fakeClock();
    const result = await readEvents(new Response(null, { status: 200 }), { max: 1, timeoutMs: 1000, clock });
    assert.equal(result.ended, 'end');
    assert.deepEqual(result.events, []);
  });

  test('the timeout timer is released when the read finishes early', async () => {
    const clock = fakeClock();
    const signals = [];
    const original = clock.sleep;
    clock.sleep = (ms, signal) => {
      signals.push(signal);
      return original.call(clock, ms, signal);
    };
    await readEvents(streamResponse([stateChange(0, 'COMPLETED')]), { max: 1, timeoutMs: 5000, clock });
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, true, 'sleep got a signal that was aborted when the read ended');
  });
});
