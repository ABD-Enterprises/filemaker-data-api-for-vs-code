/** A sliding-window limiter: at most `max` events in any `windowMs`. */
export class RateLimiter {
  private readonly times: number[] = [];

  public constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Records an event and returns true if it is allowed. */
  public take(): boolean {
    const now = this.now();
    while (this.times.length > 0 && now - (this.times[0] as number) >= this.windowMs) {
      this.times.shift();
    }
    if (this.times.length >= this.max) {
      return false;
    }
    this.times.push(now);
    return true;
  }
}
