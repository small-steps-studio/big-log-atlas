'use strict';
// Short sample logs for "Open Sample Log" and the walkthrough. Everything is invented: the services,
// users, orders and addresses do not exist. The content is built by a fixed formula, so the same
// text is written every time.

function lcg(seed) {
  let s = seed >>> 0;
  return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function pad(n, w) { return String(n).padStart(w || 2, '0'); }

function stamp(ms, sep) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + (sep || ' ') + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3);
}

/** A text log in the usual "time level [thread] logger - message" layout, with a burst of errors and stack traces. */
function appLog() {
  const r = lcg(2026);
  const lines = [];
  let t = Date.UTC(2026, 2, 2, 9, 15, 0, 120);
  const push = function (level, thread, logger, msg) {
    t += 200 + Math.floor(r() * 2400);
    lines.push(stamp(t) + ' ' + level.padEnd(5) + ' [' + thread + '] ' + logger + ' - ' + msg);
  };
  push('INFO', 'main', 'c.example.shop.Application', 'Starting harbour-shop 4.2.1 with 4 worker threads');
  push('INFO', 'main', 'c.example.shop.Config', 'Loaded 37 settings from the default profile');
  push('WARN', 'main', 'c.example.shop.Config', 'Setting cache.ttl is missing; using 300 seconds');
  push('INFO', 'main', 'c.example.shop.Application', 'Listening on port 8080');
  const customers = ['Marlo', 'Ines', 'Tobias', 'Wren', 'Odile', 'Kasper'];
  for (let i = 0; i < 150; i++) {
    const order = 18400 + i;
    const th = 'http-' + (1 + (i % 4));
    push('INFO', th, 'c.example.shop.OrderController', 'Order ' + order + ' accepted for ' + customers[i % customers.length] + ' (' + (1 + (i % 5)) + (i % 5 === 0 ? ' item' : ' items') + ', total ' + (20 + (i * 7) % 90) + '.' + pad((i * 13) % 100) + ' EUR)');
    if (i % 17 === 5) push('DEBUG', th, 'c.example.shop.Cache', 'Cache miss for key order:' + order + ', loading from store');
    if (i % 23 === 11) push('WARN', th, 'c.example.shop.Store', 'Slow query for order ' + order + ': ' + (1200 + (i * 37) % 1500) + ' ms');
    if (i === 90) {
      for (let k = 0; k < 7; k++) {
        push('ERROR', 'pay-' + (1 + (k % 2)), 'c.example.shop.PaymentClient', 'Payment gateway did not answer for order ' + (order + k) + ' within 5000 ms');
        if (k % 3 === 0) {
          lines.push('java.util.concurrent.TimeoutException: gateway timeout');
          lines.push('\tat c.example.shop.PaymentClient.charge(PaymentClient.java:118)');
          lines.push('\tat c.example.shop.OrderService.settle(OrderService.java:76)');
          lines.push('\tat c.example.shop.OrderController.accept(OrderController.java:41)');
        }
      }
      push('WARN', 'pay-1', 'c.example.shop.PaymentClient', 'Circuit opened after 7 failures; retrying in 30 seconds');
    }
    if (i === 120) push('INFO', 'pay-1', 'c.example.shop.PaymentClient', 'Circuit closed; the gateway answers again');
  }
  push('INFO', 'main', 'c.example.shop.Application', 'Shutdown requested; draining 0 requests');
  return lines.join('\n') + '\n';
}

/** JSON lines, one object per line, with an exact 20-digit identifier and a few fields to filter and sort on. */
function jsonLog() {
  const r = lcg(77);
  const lines = [];
  let t = Date.UTC(2026, 2, 2, 14, 0, 0, 0);
  const services = ['cart', 'checkout', 'catalog', 'search'];
  const paths = ['/api/items', '/api/cart', '/api/checkout', '/api/search', '/health'];
  for (let i = 0; i < 180; i++) {
    t += 300 + Math.floor(r() * 1700);
    const service = services[i % services.length];
    const status = i % 29 === 7 ? 503 : i % 13 === 4 ? 404 : 200;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const latency = 8 + Math.floor(r() * (status >= 500 ? 4000 : 220));
    const trace = '1844674407370955' + pad(1000 + i, 4);
    lines.push(JSON.stringify({ ts: new Date(t).toISOString(), level: level, service: service, msg: status >= 500 ? 'upstream unavailable' : 'request handled', method: i % 6 === 0 ? 'POST' : 'GET', path: paths[i % paths.length], status: status, latency_ms: latency, user: 'u-' + (1000 + (i * 7) % 40), trace_id: trace }));
  }
  return lines.join('\n') + '\n';
}

const SAMPLES = {
  app: { fileName: 'sample-app.log', title: 'sample application log', make: appLog },
  json: { fileName: 'sample-requests.jsonl', title: 'sample JSON Lines log', make: jsonLog }
};

function sampleFor(kind) {
  const s = SAMPLES[kind];
  return s ? { fileName: s.fileName, title: s.title, text: s.make() } : null;
}

module.exports = { sampleFor, appLog, jsonLog };
