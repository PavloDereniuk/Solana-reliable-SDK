import { Connection } from '@solana/web3.js';

export interface EndpointHealth {
  url: string;
  alive: boolean;
  latencyMs: number;
  lastChecked: number;
}

export class HealthChecker {
  private health: Map<string, EndpointHealth> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly endpoints: string[],
    intervalMs = 30_000,
  ) {
    this.intervalMs = intervalMs;
    for (const url of endpoints) {
      this.health.set(url, {
        url,
        alive: true,
        latencyMs: 0,
        lastChecked: 0,
      });
    }
  }

  start(): void {
    // Одразу перевіряємо всі ендпоінти
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getHealth(url: string): EndpointHealth | undefined {
    return this.health.get(url);
  }

  getAliveEndpoints(): string[] {
    return [...this.health.values()]
      .filter((h) => h.alive)
      .map((h) => h.url);
  }

  private async checkAll(): Promise<void> {
    await Promise.allSettled(this.endpoints.map((url) => this.checkOne(url)));
  }

  private async checkOne(url: string): Promise<void> {
    const conn = new Connection(url, 'confirmed');
    const start = Date.now();

    try {
      await conn.getSlot();
      const latencyMs = Date.now() - start;
      this.health.set(url, { url, alive: true, latencyMs, lastChecked: Date.now() });
    } catch {
      this.health.set(url, {
        url,
        alive: false,
        latencyMs: Date.now() - start,
        lastChecked: Date.now(),
      });
    }
  }
}
