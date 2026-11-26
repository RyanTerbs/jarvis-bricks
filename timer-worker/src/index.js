/**
 * Derek's on-time alarm clock (Cloudflare Worker, free plan, laptop can be off).
 * GitHub's own 15-minute timer runs hours late (it fired once in 8 hours on 2026-11-26), so this worker wakes him
 * itself: every 15 minutes it starts the "tick" workflow in RyanTerbs/jarvis-bricks (workflow_dispatch).
 * Skips if a tick already started in the last 10 minutes. GitHub's own timer stays on as a backup; a double start is
 * harmless (tick.py lives whatever is due, at least 1 step).
 * Secret (wrangler secret put GH_TOKEN): fine-grained GitHub token, repo jarvis-bricks ONLY, Actions read/write.
 * No token = it does nothing. Cost $0 (Workers free plan: 100k runs/day, 5 timers per account).
 */
const REPO = 'RyanTerbs/jarvis-bricks';
const WF = 'tick.yml';
const SKIP_MIN = 10;

export async function wake(token, now, fetchFn = fetch) {
  if (!token) return 'no token';
  const h = {
    Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
    'User-Agent': 'derek-timer', 'X-GitHub-Api-Version': '2022-11-28',
  };
  const since = new Date(now.getTime() - SKIP_MIN * 60000).toISOString().slice(0, 19) + 'Z';
  const list = await fetchFn(`https://api.github.com/repos/${REPO}/actions/workflows/${WF}/runs?per_page=1&created=` +
    encodeURIComponent('>=' + since), { headers: h });
  if (list.ok && (await list.json()).total_count > 0) return 'already ticked';   // list failed = start anyway
  const r = await fetchFn(`https://api.github.com/repos/${REPO}/actions/workflows/${WF}/dispatches`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' }),
  });
  return 'dispatch ' + r.status;
}

export default {
  async scheduled(event, env, ctx) {
    console.log(await wake((env.GH_TOKEN || '').trim(), new Date(event.scheduledTime || Date.now())));
  },
};
