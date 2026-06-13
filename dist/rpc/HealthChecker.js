import { Connection } from '@solana/web3.js';
export class HealthChecker {
    endpoints;
    health = new Map();
    timer = null;
    intervalMs;
    constructor(endpoints, intervalMs = 30_000) {
        this.endpoints = endpoints;
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
    start() {
        // Одразу перевіряємо всі ендпоінти
        void this.checkAll();
        this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    }
    stop() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    getHealth(url) {
        return this.health.get(url);
    }
    getAliveEndpoints() {
        return [...this.health.values()]
            .filter((h) => h.alive)
            .map((h) => h.url);
    }
    async checkAll() {
        await Promise.allSettled(this.endpoints.map((url) => this.checkOne(url)));
    }
    async checkOne(url) {
        const conn = new Connection(url, 'confirmed');
        const start = Date.now();
        try {
            await conn.getSlot();
            const latencyMs = Date.now() - start;
            this.health.set(url, { url, alive: true, latencyMs, lastChecked: Date.now() });
        }
        catch {
            this.health.set(url, {
                url,
                alive: false,
                latencyMs: Date.now() - start,
                lastChecked: Date.now(),
            });
        }
    }
}
//# sourceMappingURL=HealthChecker.js.map