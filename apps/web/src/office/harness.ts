/** Dev tool: the office city with synthetic data, no login and no server — for screenshots and frame timing. */
import { churned, harnessAutoRef, harnessCity, jiggled } from './harness-data';
import { buildCityModel, type FocusTarget } from './model';
import { OfficeScene } from './scene/OfficeScene';

const q = new URLSearchParams(location.search);
/** `-1` when absent: `Number(null)` is 0, which would silently mean "the first one". */
const index = (name: string) => (q.get(name) === null ? -1 : Number(q.get(name)));
/** `?projects=`, `?desks=`, `?offline=i`, `?silent=i` (machine m<i>), `?activity=`, `?verb=`, `?auto=1` — see harness-data.ts */
let city = harnessCity({
  projects: Number(q.get('projects')) || 6,
  desks: Number(q.get('desks')) || 8,
  offline: index('offline'),
  silent: index('silent'),
  activity: q.get('activity'),
  verb: q.get('verb'),
  at: new Date().toISOString(),
});

const hud = document.getElementById('hud')!;
let target: FocusTarget = { kind: 'city' };
/** Every handler the scene fires, in order: what a click routed to is otherwise unscreenshotable. */
const log = (what: string) => (hud.dataset.picked = `${hud.dataset.picked ?? ''}${what};`);
const go = (t: FocusTarget) => {
  target = t;
  scene.focus(t);
};
const scene = new OfficeScene({
  onPickDesk: (id) => log(`desk:${id}`),
  onPickBuilding: (projectId) => {
    log(`building:${projectId}`);
    go({ kind: 'building', projectId });
  },
  onPickSign: (projectId) => log(`sign:${projectId}`),
  onGoUp: () => {
    log('up');
    go({ kind: 'city' });
  },
});
const autoRef = q.get('auto') ? harnessAutoRef : () => undefined;
const draw = () => scene.setModel(buildCityModel(city, () => undefined, autoRef));

// `?grow=1`: the host starts narrow and widens WITHOUT a window resize — what hiding the sidebar in focus mode does
const hostEl = document.getElementById('host')!;
if (q.get('grow')) {
  hostEl.style.width = '75%';
  setTimeout(() => (hostEl.style.width = '100%'), 800);
}
await scene.mount(hostEl);
draw();
// `?project=i` opens on that building
if (q.get('project')) {
  target = { kind: 'building', projectId: `p${Math.max(0, index('project'))}` };
  scene.focus(target, true);
}
// `?hover=<deskId>` (e.g. p2-t0) pins one desk as hovered: hover text cannot be screenshotted otherwise
if (q.get('hover')) scene.debugHover(q.get('hover'));

/**
 * `?churn=tabs`: one desk appears and disappears every second in a building OTHER than the focused
 * one — the rebuild a tab opened anywhere in the account causes. The camera framing this building
 * must not move because of it, which is what the two screenshots around it show.
 */
if (q.get('churn') === 'tabs') {
  const focused = target.kind === 'building' ? target.projectId : null;
  const other = city.projects.find((b) => b.project.id !== focused && b.tabs.length > 0)?.project.id;
  let extra = false;
  if (other)
    setInterval(() => {
      extra = !extra;
      city = churned(city, other, extra);
      draw();
      // how many rebuilds this run has caused, so a screenshot pair can say it really churned
      hud.dataset.churn = String(Number(hud.dataset.churn ?? 0) + 1);
    }, 1000);
}

if (!q.get('still')) {
  setInterval(() => {
    city = jiggled(city, new Date().toISOString());
    draw();
  }, 400);
}
setInterval(() => (hud.textContent = `${Math.round(scene.fps)} fps · ${scene.frameMs.toFixed(2)} ms/frame CPU · ${scene.rendererName}`), 500);
