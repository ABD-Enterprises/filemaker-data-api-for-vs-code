/** Keep one dialog/request flow open; always allow another attempt once it settles. */
export function singleFlight<Args extends unknown[]>(action: (...args: Args) => Promise<unknown>): (...args: Args) => Promise<unknown> {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try { return await action(...args); }
    finally { running = false; }
  };
}
