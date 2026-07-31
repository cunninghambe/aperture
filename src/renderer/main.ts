import type { TabInfo } from '@shared/types';
import type { ApertureApi } from '../preload/shell.js';

declare global {
  interface Window {
    aperture: ApertureApi;
  }
}

const api = window.aperture;

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const $ = el;

const tabstrip = el<HTMLDivElement>('tabstrip');
const omnibox = el<HTMLInputElement>('omnibox');
const backBtn = el<HTMLButtonElement>('back');
const forwardBtn = el<HTMLButtonElement>('forward');
const reloadBtn = el<HTMLButtonElement>('reload');
const shieldCount = el<HTMLSpanElement>('shield-count');
const agentPill = el<HTMLDivElement>('agent-pill');
const agentText = el<HTMLSpanElement>('agent-text');

let tabs: TabInfo[] = [];
let activeId: string | null = null;
/** True while the human is editing, so we don't clobber their typing. */
let omniboxDirty = false;

const CONTAINER_COLORS: Record<string, string> = {
  default: '#6aa9ff',
};

function render(): void {
  tabstrip.replaceChildren();

  for (const tab of tabs) {
    const node = document.createElement('div');
    node.className = 'tab';
    if (tab.id === activeId) node.classList.add('active');
    if (tab.agentOwned) node.classList.add('agent');
    node.title = tab.agentOwned
      ? `${tab.title} — opened by the agent`
      : tab.title;

    const dot = document.createElement('span');
    dot.className = 'tab-container';
    dot.style.background = CONTAINER_COLORS[tab.container] ?? '#8b8b8b';
    node.appendChild(dot);

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent =
      tab.title || (tab.loadState === 'loading' ? 'Loading…' : 'New tab');
    node.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.setAttribute('aria-label', `Close ${tab.title}`);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void api.tabs.close(tab.id);
    });
    node.appendChild(close);

    node.addEventListener('click', () => void api.tabs.activate(tab.id));
    tabstrip.appendChild(node);
  }

  const add = document.createElement('button');
  add.className = 'tab-new';
  add.textContent = '+';
  add.setAttribute('aria-label', 'New tab');
  add.addEventListener('click', () => void api.tabs.create());
  tabstrip.appendChild(add);

  const active = tabs.find((t) => t.id === activeId);
  if (active) {
    if (!omniboxDirty && document.activeElement !== omnibox) {
      omnibox.value = active.url === 'about:blank' ? '' : active.url;
    }
    backBtn.disabled = !active.canGoBack;
    forwardBtn.disabled = !active.canGoForward;
    shieldCount.textContent = String(active.blockedCount);
  }
}

// -- wiring -----------------------------------------------------------------

omnibox.addEventListener('input', () => {
  omniboxDirty = true;
});

omnibox.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !activeId) return;
  omniboxDirty = false;
  void api.tabs.navigate(activeId, omnibox.value);
  omnibox.blur();
});

omnibox.addEventListener('focus', () => omnibox.select());
omnibox.addEventListener('blur', () => {
  omniboxDirty = false;
  render();
});

$<HTMLButtonElement>('vault-btn').addEventListener('click', () => void api.vault.open());

$<HTMLButtonElement>('capture-btn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('capture-btn');
  btn.disabled = true;
  const res = await api.capture();
  // Confirm in place. A capture that silently succeeds leaves you wondering
  // whether it worked, and a capture that opens a dialog is worse.
  btn.textContent = res.destination === 'disk' ? '✓ saved' : '✓ Notion';
  setTimeout(() => {
    btn.textContent = '⧉';
    btn.disabled = false;
  }, 1800);
});

backBtn.addEventListener('click', () => activeId && void api.tabs.back(activeId));
forwardBtn.addEventListener('click', () => activeId && void api.tabs.forward(activeId));
reloadBtn.addEventListener('click', () => activeId && void api.tabs.reload(activeId));

api.tabs.onChanged((list, active) => {
  tabs = list;
  activeId = active;
  render();
});

/**
 * Surface agent activity. A browser an agent can drive should never leave the
 * human guessing whether something else is at the wheel.
 */
let agentIdleTimer: ReturnType<typeof setTimeout> | null = null;
api.agent.onActivity((entry) => {
  agentPill.classList.add('active');
  agentText.textContent = `${entry.tool} ${entry.detail}`.slice(0, 40);
  if (agentIdleTimer) clearTimeout(agentIdleTimer);
  agentIdleTimer = setTimeout(() => {
    agentPill.classList.remove('active');
    agentText.textContent = 'agent idle';
  }, 3000);
});

void api.tabs.list().then((list) => {
  tabs = list;
  activeId = list.find((t) => t.id)?.id ?? null;
  render();
});
