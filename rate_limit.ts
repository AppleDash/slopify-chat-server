export class RateLimiter {
  limit: number;
  timeWindow: number;
  burstAllowance: number;
  requests: Map<string, number[]>;

  constructor(limit: number, timeWindow: number, burstAllowance: number) {
    this.limit = limit; // Max requests per timeWindow
    this.timeWindow = timeWindow; // Time window in milliseconds
    this.burstAllowance = burstAllowance; // Extra burst requests allowed
    this.requests = new Map(); // Stores request data for each key
  }

  hit(key: string) {
    const now = Date.now();
    const timestamps = this.requests.get(key);

    if (!timestamps) {
      this.requests.set(key, []);
      return true;
    }

    while (timestamps.length > 0 && timestamps[0] <= now - this.timeWindow) {
      timestamps.shift();
    }

    // Check if the current request fits within the rate limit
    if (timestamps.length < this.limit + this.burstAllowance) {
      timestamps.push(now);
      return true; // Request is allowed
    }

    return false; // Request exceeds rate limit
  }
}
