const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Execute actual distributed functions; do not load the bundle's UI/network startup.
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
function actual(name) {
  const found = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(found, `Missing actual function ${name}`);
  return found[0];
}
function fixture() {
  const noop = () => {};
  const settings = { imagePromptHistoryDepth: 1, regexTestMode: true, startTag: 'image###', endTag: '###' };
  const host = { chat: [], chatMetadata: { variables: {} }, chatId: 'chat-a' };
  const document = {};
  const scope = {
    document, console: { log: noop, warn: noop, error: noop, group: noop, groupEnd: noop },
    extensionName: 'st-chatu8', extension_settings10: { 'st-chatu8': settings },
    extension_settings13: { 'st-chatu8': settings }, extension_settings35: { 'st-chatu8': settings },
    getContext4: () => host, getContext12: () => host,
    setNestedVariable: (object, name, value) => { object[name] = value; },
    resolveNestedVariable: (object, name) => object[name] || '',
    setglobalvar: () => { throw new Error('Historical text must not execute'); },
    resolveGlobalVariable: () => '', getworldvar: () => '',
    debugTimer: () => ({ end: noop }), debugLog: noop, debugBranch: noop, debugContent: noop,
    debugMilestone: noop, debugError: noop, addLog: noop, toastr: { info: noop, warning: noop, error: noop },
    applyWordReplacement: (text) => text, processRollPlaceholders: (messages) => messages,
    normalizeImagesReply: (text) => ({ output: text, changed: false }),
    getMergeOptionsForRequestType: () => ({}),
    getElContext: async () => ['以前的正文', '当前正文。'],
    processWorldBooksWithTrigger: async () => '',
    generateCharacterListText: () => '', generateOutfitEnableListText: () => '', generateCommonCharacterListText: () => '',
    getEnabledCharacterImages: async () => [], getEnabledOutfitImages: async () => [], getCommonCharacterImages: async () => [],
    updateCombinedPrompt: (messages, diagnostic) => { scope.sent = messages; scope.diagnostic = diagnostic; },
    $: () => ({ prop: noop }),
  };
  vm.createContext(scope);
  const functions = [
    'normalizeImagePromptHistoryDepth', 'extractHistoricalImagePrompts', 'collectHistoricalImagePrompts',
    'getImagePromptHistoryForElement', 'describeImagePromptHistory', 'getImageTags',
    'replacePlaceholder', 'replaceAllPlaceholders', 'processVariablePlaceholdersInMessages', 'processContentVariables', 'processStringVariables',
    'mergeAdjacentMessages', 'mergeContent', 'normalizeToArray', 'buildPromptForRequestType', 'checkTriggerWords',
    'convertNewXmlFormatToOld', 'removeThinkingTextOnly', 'parseImagesFromPrompt', 'detectImportFormat',
    'handlePromptRequest', 'deduplicateTags', 'centersToCoordinates', 'getBaseTag', 'hasWeight',
  ];
  vm.runInContext(functions.map(actual).join('\n'), scope);
  const tags = { startTag: 'image###', endTag: '###' };
  return { scope, settings, host, tags, el: (id) => ({ ownerDocument: document, closest: () => ({ getAttribute: () => String(id) }) }) };
}
const wrap = (prompt) => `image###${prompt}###`;
const message = (...prompts) => ({ mes: '正文', extra: { images: { 0: prompts.map((prompt) => ({ tag: wrap(prompt) })) } } });
const plain = (value) => JSON.parse(JSON.stringify(value));

test('counts drawing floors, skips empty floors, excludes current/future, orders chronologically', () => {
  const { scope, tags } = fixture();
  const chat = [message('older'), {}, message('recent-a', 'recent-b'), {}, message('current'), message('future')];
  const one = scope.collectHistoricalImagePrompts(chat, 4, 1, tags);
  assert.deepEqual(plain(one.floors.map((f) => f.mesId)), [2]);
  assert.deepEqual(plain(one.floors[0].prompts), ['recent-a', 'recent-b']);
  assert.doesNotMatch(one.text, /current|future|older/);
  assert.deepEqual(plain(scope.collectHistoricalImagePrompts(chat, 4, 2, tags).floors.map((f) => f.mesId)), [0, 2]);
  assert.equal(scope.collectHistoricalImagePrompts(chat, 0, 1, tags).text, '');
});

test('reads selected swipe and body tags, deduplicates without mutating messages', () => {
  const { scope, tags } = fixture();
  const chat = [{ swipe_id: 1, mes: `<image>${wrap('chosen')}</image>\n${wrap('body-only')}`, extra: { images: { 0: [{ tag: wrap('wrong-swipe') }], 1: [{ tag: wrap('chosen') }] } } }, {}];
  const original = JSON.stringify(chat);
  assert.deepEqual(plain(scope.collectHistoricalImagePrompts(chat, 1, 1, tags).floors[0].prompts), ['chosen', 'body-only']);
  assert.equal(JSON.stringify(chat), original);
  chat[0].swipe_id = 0;
  chat[0].mes = '另一版本正文';
  assert.deepEqual(plain(scope.collectHistoricalImagePrompts(chat, 1, 1, tags).floors[0].prompts), ['wrong-swipe']);
});

test('message record edits are used, global cache and metadata image groups are not read', () => {
  const { scope, host, el } = fixture();
  host.chat = [message('original'), {}];
  host.chat[0].extra.images[0][0].tag = wrap('edited-in-message');
  host.chatMetadata['st-chatu8'] = { data: { image_groups: { unrelated: [{ tag: wrap('unrelated') }] } } };
  assert.match(scope.getImagePromptHistoryForElement(el(1), host, 1).text, /edited-in-message/);
  const otherChat = { chat: [message('other-chat'), {}] };
  assert.doesNotMatch(scope.getImagePromptHistoryForElement(el(1), otherChat, 1).text, /edited-in-message|unrelated/);
});

test('custom markers, thought echo, HTML, positioning and data URLs', () => {
  const { scope } = fixture();
  const tags = { startTag: '[paint(', endTag: ')]' };
  const text = '<think>[paint(fake)]</think><Tag_think>[paint(fake2)]</Tag_think><!--[paint(fake3)]--><font color="red">title</font>\nregex: old line\n[paint(Scene Composition: room;\nCharacter 1 Prompt: silver hair, 1.5::sitting::;\nCharacter 1 UC: red hair;<img src="data:image/png;base64,AAAA">)]';
  const prompts = scope.extractHistoricalImagePrompts(text, tags);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Character 1 UC: red hair/);
  assert.match(prompts[0], /1\.5::sitting::/);
  assert.doesNotMatch(prompts[0], /fake|title|regex:|old line|<img|base64/);
  assert.deepEqual(plain(scope.extractHistoricalImagePrompts('[paint(unclosed', tags)), []);
  assert.deepEqual(plain(scope.extractHistoricalImagePrompts('[paint(broken [paint(valid)]', tags)), ['valid']);
  assert.deepEqual(plain(scope.extractHistoricalImagePrompts('<think>[paint(fake)]', tags)), []);
});

test('invalid data, disabled limits, missing target and iframe fail without breaking requests', () => {
  const { scope, host, tags } = fixture();
  assert.equal(scope.normalizeImagePromptHistoryDepth(undefined), 1);
  assert.equal(scope.normalizeImagePromptHistoryDepth('invalid'), 1);
  assert.equal(scope.normalizeImagePromptHistoryDepth(-4), 0);
  assert.equal(scope.normalizeImagePromptHistoryDepth(500), 20);
  assert.equal(scope.normalizeImagePromptHistoryDepth(2.9), 2);
  assert.equal(scope.collectHistoricalImagePrompts(null, NaN, 0, tags).status, 'disabled');
  assert.equal(scope.collectHistoricalImagePrompts([], NaN, 1, tags).status, 'no-target');
  const broken = { get extra() { throw new Error('broken record'); } };
  const result = scope.collectHistoricalImagePrompts([message('good'), broken, {}], 2, 1, tags);
  assert.match(result.text, /good/);
  assert.equal(result.skippedRecords, 1);
  assert.equal(scope.getImagePromptHistoryForElement({ ownerDocument: {} }, host, 1).status, 'no-target');
  assert.equal(scope.getImagePromptHistoryForElement(null, host, 1).status, 'no-target');
  const brokenElement = { ownerDocument: scope.document, closest: () => { throw new Error('unavailable DOM'); } };
  assert.equal(scope.getImagePromptHistoryForElement(brokenElement, host, 1).status, 'error');
});

test('history is inserted literally after macros and preserves multimodal messages', async () => {
  const { scope, host } = fixture();
  const history = '$& $$ $` {{正文}} {@setvar::hijack::yes@} {@setglobalvar::hijack::yes@}';
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,example' } };
  const input = [{ role: 'user', content: [{ type: 'text', text: '{{正文}}\n{{历史绘图提示词}}' }, image] }];
  const result = await scope.replaceAllPlaceholders(input, { body: '当前正文', imagePromptHistory: history });
  assert.equal(result.messages[0].content[0].text, `当前正文\n${history}`);
  assert.deepEqual(plain(result.messages[0].content[1]), image);
  assert.deepEqual(host.chatMetadata.variables, {});
  assert.ok(result.replacedVariables.has('{{历史绘图提示词}}'));
  const disabled = await scope.replaceAllPlaceholders([{ role: 'user', content: 'a{{历史绘图提示词}}b' }], {});
  assert.equal(disabled.messages[0].content, 'ab');
  const oldPreset = [{ role: 'user', content: '{{正文}}' }];
  assert.equal((await scope.replaceAllPlaceholders(oldPreset, { body: '正文', imagePromptHistory: history })).messages[0].content, '正文');
});

function loadPreset(file) { return JSON.parse(fs.readFileSync(path.join(root, 'presets', file), 'utf8')); }
test('original preset unchanged; new preset preserves current camera rules and original examples', () => {
  const bytes = fs.readFileSync(path.join(root, 'presets/novelai-v5-story-agent.json'));
  // Git may convert line endings when the release is installed on Linux.
  assert.equal(crypto.createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex'), '6b62c2290bc84c5a51873f449a98814f4dcec597a5de36f157624f9b4f0c63ae');
  const oldEntries = Object.values(loadPreset('novelai-v5-story-agent.json'))[0].entries;
  const newEntries = Object.values(loadPreset('novelai-v5-story-agent-history.json'))[0].entries;
  assert.equal(newEntries.length, 17);
  assert.equal(new Set(newEntries.map((e) => e.id)).size, 17);
  for (const old of oldEntries) {
    if (!['nai_v5_story_01', 'nai_v5_story_02', 'nai_v5_story_background', 'nai_v5_story_10'].includes(old.id)) {
      assert.equal(newEntries.find((e) => e.id === old.id).content, old.content, old.id);
    }
  }
});

test('actual import, assembly, XML conversion and role parser handle both presets', async () => {
  const { scope, settings } = fixture();
  // Role parsing has optional vocabulary dependencies; bypass replacements only, not the parser.
  vm.runInContext(actual('parsePromptStringWithCoordinates'), scope);
  for (const file of ['novelai-v5-story-agent.json', 'novelai-v5-story-agent-history.json']) {
    const presets = loadPreset(file);
    assert.equal(scope.detectImportFormat(presets), 'standard');
    const [name, profile] = Object.entries(presets)[0];
    settings.llm_request_type_configs = { image_gen: { context_profile: name } };
    settings.test_context_profiles = presets;
    const messages = scope.buildPromptForRequestType('image_gen');
    assert.equal(messages.length, file.includes('history') ? 10 : 8);
    const filled = await scope.replaceAllPlaceholders(messages, { body: '当前正文', context: '历史', worldBookContent: '世界书', userDemand: '画一张', imagePromptHistory: '历史绘图数据' });
    assert.doesNotMatch(JSON.stringify(filled.messages), /\{\{(?:正文|上下文|世界书触发|用户需求|历史绘图提示词)\}\}/);
    let images = 0;
    for (let i = 0; i < profile.entries.length; i++) {
      const entry = profile.entries[i];
      if (entry.role !== 'assistant') continue;
      const parsed = scope.parseImagesFromPrompt(entry.content);
      const imageOnly = scope.parseImagesFromPrompt(entry.content.slice(entry.content.indexOf('<images>')));
      assert.deepEqual(plain(parsed), plain(imageOnly));
      const body = profile.entries[i - 1].content.match(/<当前正文>([^]*?)<\/当前正文>/)[1];
      let previous = -1;
      for (const image of parsed) {
        const offset = body.indexOf(image.regex);
        assert.ok(offset >= 0 && offset >= previous);
        previous = offset;
        assert.match(image.tag, /Scene Composition:/);
        const roles = scope.parsePromptStringWithCoordinates(image.tag.slice(8, -3));
        assert.ok(roles['Scene Composition']);
        assert.ok(roles['Character 1 Prompt']);
        assert.match(roles['Character 1 Prompt'], /1\.5::/);
      }
      images += parsed.length;
    }
    assert.equal(images, file.includes('history') ? 6 : 5);
    assert.deepEqual(plain(scope.parseImagesFromPrompt('<definitions></definitions><images></images>')), []);
  }
});

test('actual request integration includes history diagnostics and snapshots before async processing', async () => {
  const { scope, settings, host, el } = fixture();
  const presets = loadPreset('novelai-v5-story-agent-history.json');
  settings.test_context_profiles = presets;
  settings.llm_request_type_configs = { image_gen: { context_profile: Object.keys(presets)[0] } };
  host.chat = [message('snapshot-original'), {}];
  scope.getElContext = async () => {
    host.chat = [message('later-chat'), {}];
    host.chatId = 'chat-b';
    return ['历史正文', '当前正文。'];
  };
  await scope.handlePromptRequest(el(1), 'gesture1');
  assert.match(JSON.stringify(scope.sent), /snapshot-original/);
  assert.doesNotMatch(JSON.stringify(scope.sent), /later-chat/);
  assert.match(scope.diagnostic, /已注入.*#0\/swipe 0（1 张）/);
});

test('actual requests with disabled/empty history and original preset continue with current body', async () => {
  for (const scenario of ['disabled', 'empty', 'old-preset', 'read-error']) {
    const { scope, settings, host, el } = fixture();
    const presets = loadPreset(scenario === 'old-preset' ? 'novelai-v5-story-agent.json' : 'novelai-v5-story-agent-history.json');
    settings.test_context_profiles = presets;
    settings.llm_request_type_configs = { image_gen: { context_profile: Object.keys(presets)[0] } };
    settings.imagePromptHistoryDepth = scenario === 'disabled' ? 0 : 1;
    host.chat = [scenario === 'empty' ? {} : message('historical-test-marker'), {}];
    const target = el(1);
    if (scenario === 'read-error') target.closest = () => { throw new Error('unavailable element'); };
    await scope.handlePromptRequest(target, 'gesture1');
    assert.match(JSON.stringify(scope.sent), /当前正文。/);
    assert.doesNotMatch(JSON.stringify(scope.sent), /historical-test-marker|\{\{历史绘图提示词\}\}/);
    assert.match(scope.diagnostic, new RegExp({ disabled: '已关闭', empty: '没有可用', 'old-preset': '未注入', 'read-error': '读取失败' }[scenario]));
  }
});
