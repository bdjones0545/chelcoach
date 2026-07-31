/** Clock abstraction — tests use FakeClock; no long sleeps in CI. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  private ms: number;
  constructor(start: Date | number = Date.parse("2026-07-31T12:00:00.000Z")) {
    this.ms = typeof start === "number" ? start : start.getTime();
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(date: Date): void {
    this.ms = date.getTime();
  }
}
