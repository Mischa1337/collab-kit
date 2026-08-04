import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ── Metriken ──────────────────────────────────────────────
const wsErrors = new Counter('ws_errors');
const wsConnectTime = new Trend('ws_connect_time_ms');

// ── Konfiguration ─────────────────────────────────────────
// Drei Phasen:
// 1. Ramp-up: 1000 Nutzer werden über 1 Minute aufgebaut (realistischer als sofort 1000)
// 2. Sustained: 1000 Nutzer bleiben 5 Minuten verbunden — das ist der eigentliche Lasttest
// 3. Ramp-down: sauberes Herunterfahren über 30 Sekunden
export const options = {
  stages: [
    { duration: '1m', target: 1000 },
    { duration: '5m', target: 1000 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    ws_errors: ['count<50'],           // Weniger als 50 Verbindungsfehler insgesamt
    ws_connect_time_ms: ['p95<2000'],  // 95% der Verbindungen in unter 2 Sekunden
  },
};

// Session-IDs: 1000 Sessions für 1000 Verbindungen.
// Jeder virtuelle Nutzer bekommt eine eigene Session — so wird
// sowohl die WS-Last als auch die Redis/DB-Last realistisch verteilt.
const SESSION_COUNT = 1000;
const BASE_URL = 'ws://localhost:3000';

export default function () {
  const sessionId = `00000000-0000-0000-0000-${String(__VU).padStart(12, '0')}`;
  const url = `${BASE_URL}/sync/${sessionId}`;

  const start = Date.now();

  const res = ws.connect(url, {}, (socket) => {
    wsConnectTime.add(Date.now() - start);

    socket.on('open', () => {
      // Alle 1s eine minimale Yjs-kompatible Binärnachricht senden.
      // Simuliert einen Nutzer der tippt — realistischer Workload.
      socket.setInterval(() => {
        // Minimales Yjs-Update: Typ 0 (sync step 1), leerer State-Vector
        const update = new Uint8Array([0, 1, 0]);
        socket.sendBinary(update.buffer);
      }, 1000);
    });

    socket.on('error', (e) => {
      wsErrors.add(1);
    });

    // Verbindung nach 5 Minuten + etwas Puffer sauber schließen
    socket.setTimeout(() => {
      socket.close();
    }, 310_000);
  });

  check(res, {
    'Verbindung erfolgreich aufgebaut': (r) => r && r.status === 101,
  });
}