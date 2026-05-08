// src/ui/views/routing.ts
//
// YAML editor backed by config_get / config_set. We don't ship a YAML
// parser in the browser — server validates via ProjectConfigSchema and
// returns a useful error.

import type { RpcClient } from '../api.js';

interface ProjectConfigShape {
  routing: { default: string; functions: Record<string, string> };
  autonomy: { default: string; transitions: Record<string, string> };
  verify_command: string;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function configToYaml(config: ProjectConfigShape): string {
  // Hand-roll a minimal YAML dump so we don't need js-yaml in the browser.
  // The server will validate the result, so format quirks become 32602
  // errors with helpful messages.
  return [
    `routing:`,
    `  default: ${config.routing.default}`,
    `  functions:`,
    ...Object.entries(config.routing.functions).map(([k, v]) => `    ${k}: ${v}`),
    `autonomy:`,
    `  default: ${config.autonomy.default}`,
    `  transitions:`,
    ...Object.entries(config.autonomy.transitions).map(([k, v]) => `    ${k}: ${v}`),
    `verify_command: ${config.verify_command}`,
    '',
  ].join('\n');
}

function yamlToConfig(yaml: string): ProjectConfigShape {
  // Minimal parser for the shape we emit. Top-level keys followed by
  // nested 2-space indents. Falls back to throwing on anything odd.
  const lines = yaml.split('\n');
  const routing = { default: '', functions: {} as Record<string, string> };
  const autonomy = { default: '', transitions: {} as Record<string, string> };
  let verify_command = '';
  let section: 'routing' | 'routing.functions' | 'autonomy' | 'autonomy.transitions' | null = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('routing:')) { section = 'routing'; continue; }
    if (line.startsWith('autonomy:')) { section = 'autonomy'; continue; }
    if (line.startsWith('verify_command:')) {
      verify_command = line.slice('verify_command:'.length).trim();
      section = null; continue;
    }
    if (line.startsWith('  default:')) {
      const v = line.slice(line.indexOf(':') + 1).trim();
      if (section === 'routing') routing.default = v;
      else if (section === 'autonomy') autonomy.default = v;
      continue;
    }
    if (line.startsWith('  functions:')) { section = 'routing.functions'; continue; }
    if (line.startsWith('  transitions:')) { section = 'autonomy.transitions'; continue; }
    if (line.startsWith('    ')) {
      const idx = line.indexOf(':');
      if (idx === -1) throw new Error(`Malformed: ${line}`);
      const k = line.slice(4, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (section === 'routing.functions') routing.functions[k] = v;
      else if (section === 'autonomy.transitions') autonomy.transitions[k] = v;
      continue;
    }
  }
  return { routing, autonomy, verify_command };
}

export async function renderRouting(rpc: RpcClient, root: HTMLElement): Promise<void> {
  const result = await rpc.call<{ config: ProjectConfigShape }>('config_get');
  const yaml = configToYaml(result.config);
  const currentMode = result.config.autonomy.default;
  root.innerHTML = `
    <div class="routing">
      <h2>Routing</h2>
      <div class="autonomy-picker" style="margin-bottom:1rem; padding:0.5rem; border:1px solid #d0d7de; border-radius:6px;">
        <label for="autonomy-select"><strong>Autonomy mode:</strong></label>
        <select id="autonomy-select" style="margin-left:0.5rem;">
          <option value="escort">escort — every decision to user</option>
          <option value="assist">assist — auto-approve high-confidence + low-blast</option>
          <option value="auto">auto — auto-approve any high-confidence decision</option>
          <option value="critical">critical — auto, but halt queue if confidence drops</option>
        </select>
        <span id="autonomy-status" style="margin-left:0.5rem; color:#1a7f37;" hidden>Saved.</span>
      </div>
      <p>Edit <code>.conductor/config.yaml</code>. Saves are validated server-side.</p>
      <textarea id="yaml">${escape(yaml)}</textarea>
      <div class="actions" style="margin-top:0.5rem;">
        <button id="save-btn">Save</button>
        <button class="secondary" id="reload-btn">Reload</button>
      </div>
      <div class="err" id="err" hidden></div>
    </div>
  `;

  const autonomySelect = root.querySelector<HTMLSelectElement>('#autonomy-select')!;
  const autonomyStatus = root.querySelector<HTMLElement>('#autonomy-status')!;
  autonomySelect.value = currentMode;
  autonomySelect.addEventListener('change', async () => {
    autonomyStatus.hidden = true;
    try {
      await rpc.call('conductor_set_autonomy', { mode: autonomySelect.value });
      autonomyStatus.textContent = 'Saved.';
      autonomyStatus.style.color = '#1a7f37';
      autonomyStatus.hidden = false;
      // Refresh the YAML view so it reflects the change.
      const r = await rpc.call<{ config: ProjectConfigShape }>('config_get');
      ta.value = configToYaml(r.config);
    } catch (err) {
      autonomyStatus.textContent = `Failed: ${(err as Error).message}`;
      autonomyStatus.style.color = '#cf222e';
      autonomyStatus.hidden = false;
    }
  });

  const ta = root.querySelector<HTMLTextAreaElement>('#yaml')!;
  const errEl = root.querySelector<HTMLElement>('#err')!;
  const saveBtn = root.querySelector<HTMLButtonElement>('#save-btn')!;
  const reloadBtn = root.querySelector<HTMLButtonElement>('#reload-btn')!;

  saveBtn.addEventListener('click', async () => {
    errEl.hidden = true;
    let parsed: ProjectConfigShape;
    try {
      parsed = yamlToConfig(ta.value);
    } catch (err) {
      errEl.textContent = `Parse error: ${(err as Error).message}`;
      errEl.hidden = false;
      return;
    }
    try {
      await rpc.call('config_set', { config: parsed });
      errEl.textContent = 'Saved.';
      errEl.style.color = '#1a7f37';
      errEl.hidden = false;
    } catch (err) {
      errEl.textContent = `Save failed: ${(err as Error).message}`;
      errEl.style.color = '';
      errEl.hidden = false;
    }
  });

  reloadBtn.addEventListener('click', async () => {
    const r = await rpc.call<{ config: ProjectConfigShape }>('config_get');
    ta.value = configToYaml(r.config);
    errEl.hidden = true;
  });
}
