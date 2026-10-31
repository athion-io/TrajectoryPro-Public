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

// A clock for tests. No real timers: `sleep` either advances `now` and
// resolves at once (auto mode) or waits until the test calls `tick`.

/**
 * @param {{auto?: boolean, start?: number}} [options]
 * @returns {{now: () => number, sleep: (ms: number, signal?: AbortSignal) => Promise<void>, tick: (ms: number) => Promise<void>, sleeps: number[]}}
 */
export function fakeClock({ auto = false, start = 1_700_000_000_000 } = {}) {
  let now = start;
  const pending = [];
  const sleeps = [];
  const clock = {
    now: () => now,
    sleeps,
    sleep(ms, signal) {
      sleeps.push(ms);
      if (auto) {
        now += ms;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const entry = { due: now + ms, resolve };
        pending.push(entry);
        signal?.addEventListener('abort', () => {
          const i = pending.indexOf(entry);
          if (i >= 0) pending.splice(i, 1);
          resolve();
        });
      });
    },
    async tick(ms) {
      now += ms;
      const due = pending.filter((e) => e.due <= now);
      for (const entry of due) {
        pending.splice(pending.indexOf(entry), 1);
        entry.resolve();
      }
      // Let the resolved sleeps' continuations run before the test looks.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return clock;
}
