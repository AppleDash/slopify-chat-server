export class RateLimiter {
  constructor(limit, timeWindow, burstAllowance) {
    this.limit = limit; // Max requests per timeWindow
    this.timeWindow = timeWindow; // Time window in milliseconds
    this.burstAllowance = burstAllowance; // Extra burst requests allowed
    this.requests = new Map(); // Stores request data for each key
  }

  hit(key) {
    const now = Date.now();
    
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
      return true;
    }

    const timestamps = this.requests.get(key);

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
