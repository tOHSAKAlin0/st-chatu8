const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
function actual(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `Missing distributed function: ${name}`);
  return match[0];
}

test('settings loader replaces an already cached original UI with the current main panel and LLM controls', async () => {
  const extensionFolderPath = 'https://tavern.example/scripts/extensions/third-party/st-chatu8';
  const oldCache = new Map([
    [`${extensionFolderPath}/settings.html`, '<h2>Original plugin</h2>'],
    [`${extensionFolderPath}/html/settings/llm.html`, '<label>发送历史层数</label>'],
  ]);
  const requests = [];
  const scope = {
    extensionFolderPath,
    tabIds: ['llm'],
    initHelpTipInteractions() {}, injectHelpTips() {}, console,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (options.cache !== 'no-store' && oldCache.has(url)) {
        return { ok: true, text: async () => oldCache.get(url) };
      }
      const relative = new URL(url).pathname.split('/st-chatu8/')[1];
      return { ok: true, text: async () => fs.readFileSync(path.join(root, relative), 'utf8') };
    },
  };
  vm.createContext(scope);
  vm.runInContext(actual('fetchSettingsHtml') + '\n' + actual('loadAllTabsContent'), scope);
  const old = await scope.fetch(`${extensionFolderPath}/html/settings/llm.html`);
  assert.doesNotMatch(await old.text(), /参考历史绘图楼层数/);
  requests.length = 0;
  const main = await scope.fetchSettingsHtml('settings.html');
  assert.match(main, /历史提示词版 R2/);
  const container = { innerHTML: '' };
  assert.equal(await scope.loadAllTabsContent(container), true);
  assert.match(container.innerHTML, /参考历史绘图楼层数/);
  assert.match(container.innerHTML, /id="ch-image_prompt_history_depth"/);
  assert.match(container.innerHTML, /历史提示词版 R2/);
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(options.cache, 'no-store');
    assert.equal(new URL(url).searchParams.get('chatu8_build'), manifest.version);
  }
});

test('settings fetch reports server failures instead of treating an error page as plugin HTML', async () => {
  const scope = { extensionFolderPath: '/plugin', fetch: async () => ({ ok: false, status: 404 }) };
  vm.createContext(scope);
  vm.runInContext(actual('fetchSettingsHtml'), scope);
  await assert.rejects(scope.fetchSettingsHtml('html/settings/llm.html'), /llm.html: HTTP 404/);
});

test('manifest uses a distinct entry with a versioned bundle and resolves assets from the loaded module', () => {
  assert.notEqual(manifest.js, 'index.js');
  const entry = fs.readFileSync(path.join(root, manifest.js), 'utf8');
  const imported = entry.match(/import "(.+)";/)[1];
  const moduleUrl = new URL(imported, 'https://tavern.example/host/scripts/extensions/third-party/st-chatu8/' + manifest.js);
  assert.equal(moduleUrl.searchParams.get('chatu8_build'), manifest.version);
  assert.equal(path.basename(moduleUrl.pathname), 'index.js');
  assert.ok(fs.existsSync(path.join(root, path.basename(moduleUrl.pathname))));
  const assignment = source.match(/^    extensionFolderPath = (.+);$/m)[1];
  const expression = assignment.replace('import.meta.url', JSON.stringify(moduleUrl.href));
  assert.equal(vm.runInNewContext(expression, { URL }), 'https://tavern.example/host/scripts/extensions/third-party/st-chatu8');
});
