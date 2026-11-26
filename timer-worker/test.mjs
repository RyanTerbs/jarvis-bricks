// Quick check of the alarm clock's logic with a fake GitHub (node test.mjs).
import { wake } from './src/index.js';
const now = new Date('2026-11-26T14:00:00Z');
const fake = (recent, listOk = true) => {
  const calls = [];
  const f = async (url, opt = {}) => {
    calls.push([opt.method || 'GET', url]);
    if (url.includes('/runs?')) return { ok: listOk, json: async () => ({ total_count: recent }) };
    return { ok: true, status: 204 };
  };
  return { f, calls };
};
let fails = 0;
const check = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(ok ? 'OK  ' : 'FAIL', name, '->', got); };
check('no token', await wake('', now, fake(0).f), 'no token');
let a = fake(0); check('nothing recent = start him', await wake('t', now, a.f), 'dispatch 204');
check('  asks since 13:50', a.calls[0][1].includes(encodeURIComponent('>=2026-11-26T13:50:00Z')), true);
check('  POSTs the tick workflow', a.calls[1][0] + ' ' + a.calls[1][1].endsWith('/workflows/tick.yml/dispatches'), 'POST true');
let b = fake(1); check('ticked 5 min ago = skip', await wake('t', now, b.f), 'already ticked');
check('  no POST', b.calls.length, 1);
check('GitHub list down = start anyway', await wake('t', now, fake(0, false).f), 'dispatch 204');
process.exit(fails ? 1 : 0);
