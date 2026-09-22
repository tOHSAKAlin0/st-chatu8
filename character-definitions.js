// Message-owned visual definitions (characters, settings, props) plus chat-level pins.
// No global identity library: every record belongs to one message version (swipe).
export const RECORD_KEY = "st_chatu8_character_definitions";
export const PIN_KEY = "st_chatu8_pinned_definitions";
const KINDS = {
  characters: {
    item: "character", letter: "C", label: "人物", visual: ["appearance"],
    fields: ["id", "name", "basis", "appearance", "outfit", "continuity"],
    labels: { name: "人物名称", basis: "设定来源", appearance: "稳定外貌", outfit: "基准衣着", continuity: "状态与变化" },
  },
  settings: {
    item: "setting", letter: "S", label: "场景", visual: ["layout", "materials"],
    fields: ["id", "name", "basis", "layout", "materials", "lighting", "continuity"],
    labels: { name: "场景名称", basis: "设定来源", layout: "固定布局", materials: "材质与主色", lighting: "时间与光照", continuity: "环境变化" },
  },
  props: {
    item: "prop", letter: "P", label: "物件", visual: ["appearance"],
    fields: ["id", "name", "basis", "appearance", "continuity"],
    labels: { name: "物件名称", basis: "设定来源", appearance: "外观", continuity: "持有人、位置与状态" },
  },
};
const KIND_NAMES = Object.keys(KINDS);
// Share of identical visual tags from which two entries count as the same object.
const SIMILAR = 0.5;
const activeRequests = new WeakMap();
const stampCache = new WeakMap();
let saveSequence = 0;
let closeManager = null;

const clone = (value) => JSON.parse(JSON.stringify(value));

export function normalizeDepth(value) {
  if (value === undefined || value === null || value === "") return 3;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(20, Math.trunc(number))) : 3;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function narrativeText(text, tags = {}) {
  let result = typeof text === "string" ? text : "";
  // Only image markup is excluded: narrative, status blocks and names remain significant.
  result = result.replace(/<image>[\s\S]*?<\/image>/gi, "");
  for (const pair of [{ startTag: "image###", endTag: "###" }, tags]) {
    if (pair.startTag && pair.endTag) {
      result = result.replace(new RegExp(`${escapeRegex(pair.startTag)}[\\s\\S]*?${escapeRegex(pair.endTag)}`, "g"), "");
    }
  }
  return result.replace(/\s+/g, " ").trim();
}

function fingerprint(text) {
  // Two independent 32-bit lanes; works in HTTP taverns without Web Crypto.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

// Stamp v2 ignores is_system, which the host flips when a floor is hidden.
// Legacy (pre-D4) stamps included it; both variants are kept to validate old records.
function stampParts(message, tags, text = message?.mes) {
  const name = message?.name || "", user = !!message?.is_user;
  const tagKey = `${tags?.startTag || ""}\u0000${tags?.endTag || ""}`;
  const cacheable = message !== null && typeof message === "object" && text === message.mes;
  const cached = cacheable ? stampCache.get(message) : undefined;
  if (cached && cached.text === text && cached.name === name && cached.user === user && cached.tagKey === tagKey) return cached;
  const narrative = narrativeText(text, tags);
  const parts = {
    text, name, user, tagKey,
    current: fingerprint(JSON.stringify([name, user, narrative])),
    legacy: [false, true].map((system) => fingerprint(JSON.stringify([name, user, system, narrative]))),
  };
  if (cacheable) stampCache.set(message, parts);
  return parts;
}

export function timelineStamps(chat, tags) {
  let prefix = "start", legacyActual = "start", legacyVisible = "start";
  return chat.map((message) => {
    const parts = stampParts(message, tags);
    const stamps = { source: parts.current, prefix, legacy: { sources: parts.legacy, prefixes: [legacyActual, legacyVisible] } };
    prefix = fingerprint(`${prefix}\n${parts.current}`);
    // Legacy chains: hidden state as it is now, and as if nothing had been hidden.
    legacyActual = fingerprint(`${legacyActual}\n${parts.legacy[message?.is_system ? 1 : 0]}`);
    legacyVisible = fingerprint(`${legacyVisible}\n${parts.legacy[0]}`);
    return stamps;
  });
}

function swipeStamps(message, tags, text, floor) {
  const parts = stampParts(message, tags, text);
  return { source: parts.current, prefix: floor.prefix, legacy: { sources: parts.legacy, prefixes: floor.legacy.prefixes } };
}

function validEntries(kind, entries) {
  if (!Array.isArray(entries)) return false;
  const ids = new Set();
  return entries.every((entry) => {
    if (!entry || !KINDS[kind].fields.every((key) => typeof entry[key] === "string" && entry[key].trim())) return false;
    if (entry.originalId !== undefined && typeof entry.originalId !== "string") return false;
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    return true;
  });
}

// Version 1 records (D1–D3) hold characters only.
function recordLists(record) {
  if (record?.version === 1) return { characters: record.characters, settings: [], props: [] };
  return Object.fromEntries(KIND_NAMES.map((kind) => [kind, record?.[kind] ?? []]));
}

function validRecord(record) {
  if (!record || (record.version !== 1 && record.version !== 2)) return false;
  const lists = recordLists(record);
  return KIND_NAMES.every((kind) => validEntries(kind, lists[kind])) && KIND_NAMES.some((kind) => lists[kind].length > 0);
}

export function recordStatus(record, stamps) {
  if (!validRecord(record)) return "格式无效";
  if (record.stamp === 2) {
    if (record.source !== stamps?.source) return "正文已变化";
    if (record.prefix !== stamps?.prefix) return "前序剧情已变化";
    return "有效";
  }
  if (!stamps?.legacy?.sources.includes(record.source)) return "正文已变化";
  if (!stamps.legacy.prefixes.includes(record.prefix)) return "前序剧情已变化";
  return "有效";
}

function currentRecord(message) {
  // The active message's extra is authoritative; do not resurrect deleted swipe data.
  return message?.extra?.[RECORD_KEY];
}

function compact(text) {
  return text.replace(/[\s\p{P}\p{S}]/gu, "");
}

// Name keys: the whole name plus bracketed or listed aliases and the parts of dotted/spaced names.
function nameKeys(name) {
  const text = String(name || "").normalize("NFKC").toLowerCase();
  const brackets = /[(\[【「『]([^)\]】」』]*)[)\]】」』]/g;
  const aliases = [text.replace(brackets, " "), ...[...text.matchAll(brackets)].map((match) => match[1])];
  const keys = new Set();
  for (const alias of aliases.flatMap((part) => part.split(/[/|、,;]/))) {
    const cleaned = alias.trim().replace(/^(?:(?:原名|又名|别名|本名|真名)\s*:?|(?:原|即)\s*:|(?:aka|a\.k\.a\.|formerly)(?:\s*:|\s))\s*/, "");
    const key = compact(cleaned);
    if (key) keys.add(key);
    const pieces = cleaned.split(/[\s·・•]+/).map(compact).filter((piece) => piece.length >= 2);
    if (pieces.length > 1) pieces.forEach((piece) => keys.add(piece));
  }
  return keys;
}

// 2: same full name, 1: a shared alias or name part, 0: unrelated. Substrings never match.
function nameScore(a, b) {
  const whole = compact(String(a || "").normalize("NFKC").toLowerCase());
  if (whole && whole === compact(String(b || "").normalize("NFKC").toLowerCase())) return 2;
  const other = nameKeys(b);
  for (const key of nameKeys(a)) if (other.has(key)) return 1;
  return 0;
}

function visualTokens(kind, entry) {
  const text = KINDS[kind].visual.map((key) => entry?.[key] || "").join(",").normalize("NFKC").toLowerCase();
  return new Set(text.replace(/-?\d+(?:\.\d+)?::|::/g, ",").replace(/[(){}[\]]/g, ",").replace(/:\s*-?\d+(?:\.\d+)?/g, "")
    .split(/[,;|。、\n]+/).map((token) => token.trim().replace(/\s+/g, " ")).filter(Boolean));
}

function similarity(kind, a, b) {
  const left = visualTokens(kind, a), right = visualTokens(kind, b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

function sameEntity(kind, a, b) {
  return nameScore(a?.name, b?.name) > 0 || similarity(kind, a, b) >= SIMILAR;
}

export function readPins(metadata) {
  const pins = metadata?.[PIN_KEY];
  return Array.isArray(pins) ? pins.filter((pin) => pin?.kind === "characters" && typeof pin.id === "string" && pin.id && typeof pin.name === "string") : [];
}

const isPinned = (pins, entry) => pins.some((pin) => pin.id === entry.id && sameEntity("characters", pin, entry));

// Every ID stored anywhere in the chat, so new IDs never collide with objects outside the window.
function chatIndex(chat, exclude) {
  const index = Object.fromEntries(KIND_NAMES.map((kind) => [kind, new Map()]));
  for (const message of Array.isArray(chat) ? chat : []) {
    if (!message || message === exclude) continue;
    for (const record of [message.extra?.[RECORD_KEY], ...(message.swipe_info || []).map((info) => info?.extra?.[RECORD_KEY])]) {
      if (!validRecord(record)) continue;
      const lists = recordLists(record);
      for (const kind of KIND_NAMES) {
        for (const entry of lists[kind]) index[kind].set(entry.id, [...(index[kind].get(entry.id) || []), entry]);
      }
    }
  }
  return index;
}

function nextNumber(letter, ids) {
  const pattern = new RegExp(`^${letter}(\\d+)(?:@|$)`, "i");
  let max = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function collectHistory(chat, targetId, depth, tags, pins = []) {
  const result = { floors: [], selectedFloors: [], pinned: [], pinCount: pins.length, superseded: 0, conflicts: 0, skipped: [], depth: normalizeDepth(depth), next: {}, status: "empty" };
  if (!result.depth && !pins.length) return { ...result, status: "disabled" };
  if (!Array.isArray(chat) || !Number.isInteger(targetId) || !chat[targetId]) return { ...result, status: "no-target" };
  const stamps = timelineStamps(chat.slice(0, targetId), tags);
  for (let id = targetId - 1; id >= 0 && result.floors.length < result.depth; id--) {
    const record = currentRecord(chat[id]);
    if (!record) continue;
    const status = recordStatus(record, stamps[id]);
    if (status !== "有效") {
      result.skipped.push({ id, reason: status });
      continue;
    }
    result.floors.push({ id, swipe: chat[id].swipe_id ?? 0, ...clone(recordLists(record)) });
  }
  result.floors.reverse();
  // Choose the floor window first; deduplication must never pull in older floors.
  result.selectedFloors = result.floors.map(({ id, swipe }) => ({ id, swipe }));
  // Newest definition wins per ID. An older entry that is clearly another object keeps a floor-qualified ID.
  const kept = Object.fromEntries(KIND_NAMES.map((kind) => [kind, new Map()]));
  const place = (kind, floorId, entry) => {
    const base = entry.id;
    for (let attempt = 0; ; attempt++) {
      const id = attempt === 0 ? base : `${base}@${floorId}${attempt > 1 ? "." + attempt : ""}`;
      const newer = kept[kind].get(id);
      if (!newer) {
        if (id !== base) {
          entry.id = id;
          result.conflicts++;
        }
        kept[kind].set(id, entry);
        return true;
      }
      if (sameEntity(kind, newer, entry)) {
        result.superseded++;
        return false;
      }
    }
  };
  for (let index = result.floors.length - 1; index >= 0; index--) {
    const floor = result.floors[index];
    for (const kind of KIND_NAMES) floor[kind] = floor[kind].filter((entry) => place(kind, floor.id, entry));
  }
  result.floors = result.floors.filter((floor) => KIND_NAMES.some((kind) => floor[kind].length));
  // Pinned characters outside the window: latest valid definition strictly before the target.
  for (const pin of pins) {
    if ([...kept.characters.values()].some((entry) => entry.id.split("@")[0] === pin.id && sameEntity("characters", pin, entry))) continue;
    for (let id = targetId - 1; id >= 0; id--) {
      const record = currentRecord(chat[id]);
      if (!record || recordStatus(record, stamps[id]) !== "有效") continue;
      const found = recordLists(record).characters.find((entry) => entry.id === pin.id && sameEntity("characters", pin, entry));
      if (!found) continue;
      const entry = clone(found);
      if (place("characters", id, entry)) result.pinned.push({ floor: id, swipe: chat[id].swipe_id ?? 0, entry });
      break;
    }
  }
  const index = chatIndex(chat, chat[targetId]);
  for (const kind of KIND_NAMES) {
    result.next[kind] = KINDS[kind].letter + nextNumber(KINDS[kind].letter, [...index[kind].keys(), ...kept[kind].keys()]);
  }
  if (result.floors.length || result.pinned.length) result.status = "ready";
  return result;
}

export function beginRequest(context, el, document, depth, tags) {
  let id;
  try {
    const raw = el?.ownerDocument === document ? el.closest?.(".mes[mesid]")?.getAttribute("mesid") : null;
    id = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  } catch { return null; }
  if (!Number.isInteger(id) || !context?.chat?.[id]) return null;
  const message = context.chat[id];
  if (activeRequests.has(message)) return { busy: true };
  const request = {
    id, message, swipe: message.swipe_id ?? 0, chatId: context.chatId,
    characterId: context.characterId, groupId: context.groupId, metadata: context.chatMetadata,
    stamps: timelineStamps(context.chat.slice(0, id + 1), tags)[id],
    history: collectHistory(context.chat, id, depth, tags, readPins(context.chatMetadata)), cancelled: false,
  };
  activeRequests.set(message, request);
  return request;
}

export function isCurrent(request, context, tags) {
  if (!request) return true;
  if (request.cancelled || request.busy || context?.chatId !== request.chatId || context?.chatMetadata !== request.metadata ||
      context?.characterId !== request.characterId || context?.groupId !== request.groupId ||
      context?.chat?.[request.id] !== request.message || (request.message.swipe_id ?? 0) !== request.swipe) return false;
  const stamps = timelineStamps(context.chat.slice(0, request.id + 1), tags)[request.id];
  return stamps.source === request.stamps.source && stamps.prefix === request.stamps.prefix;
}

export function assertCurrent(request, context, tags) {
  if (isCurrent(request, context, tags)) return;
  const error = new Error("聊天、swipe 或正文已变化，本次绘图结果未写入，请在目标楼层重新请求。");
  error.code = "ST_CHARACTER_DEFINITIONS_STALE";
  throw error;
}

export function watchRequest(request, events, types, getContext, getTags) {
  if (!request || !events?.on) return;
  request.listeners = [];
  for (const name of ["CHAT_CHANGED", "MESSAGE_SWIPED", "MESSAGE_SWIPE_DELETED", "MESSAGE_EDITED", "MESSAGE_DELETED"]) {
    if (!types?.[name]) continue;
    const listener = (id) => {
      const messageId = typeof id === "object" ? id?.messageId : id;
      if (name === "CHAT_CHANGED" || (["MESSAGE_EDITED", "MESSAGE_SWIPED", "MESSAGE_SWIPE_DELETED"].includes(name) && Number.isInteger(Number(messageId)) && Number(messageId) <= request.id) ||
          !isCurrent(request, getContext(), getTags())) request.cancelled = true;
    };
    events.on(types[name], listener);
    request.listeners.push(() => events.removeListener(types[name], listener));
  }
}

export function endRequest(request) {
  if (!request || request.busy) return;
  for (const remove of request.listeners || []) remove();
  if (activeRequests.get(request.message) === request) activeRequests.delete(request.message);
}

// Models write prose into leaf fields; a stray "&" or "<3" must not void the whole block.
function escapeLooseMarkup(xml) {
  return xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;").replace(/<(?![A-Za-z_/!?])/g, "&lt;");
}

function readEntry(node, spec) {
  const id = node.getAttribute("id")?.trim() || "";
  if (!id) return { error: "缺少编号" };
  const entry = { id };
  for (const key of spec.fields.slice(1)) {
    const children = [...node.children].filter((child) => child.tagName === key);
    if (children.length !== 1) return { id, error: `字段 ${key} ${children.length ? "重复" : "缺失"}` };
    if (children[0].children.length) return { id, error: `字段 ${key} 包含嵌套元素` };
    const text = children[0].textContent.trim();
    if (!text) return { id, error: `字段 ${key} 为空` };
    entry[key] = text;
  }
  return { entry };
}

export function parseDefinitions(text, Parser = globalThis.DOMParser) {
  if (typeof text !== "string" || !/<definitions\b/i.test(text)) return { status: "missing", reason: "回复未包含 definitions" };
  const blocks = [...text.matchAll(/<definitions\b[^>]*>[\s\S]*?<\/definitions\s*>/gi)];
  if (blocks.length !== 1 || (text.match(/<definitions\b/gi) || []).length !== 1) return { status: "invalid", reason: "definitions 不完整或存在多个区块" };
  try {
    if (/<!DOCTYPE|<!ENTITY/i.test(blocks[0][0])) throw new Error("不支持 XML 实体声明");
    const xml = new Parser().parseFromString(escapeLooseMarkup(blocks[0][0]), "application/xml");
    if (xml.querySelector("parsererror") || xml.documentElement.tagName !== "definitions") throw new Error("definitions XML 格式无效");
    const result = { status: "ready", characters: [], settings: [], props: [], warnings: [] };
    let lists = 0;
    for (const [kind, spec] of Object.entries(KINDS)) {
      const containers = [...xml.documentElement.children].filter((node) => node.tagName === kind);
      if (containers.length > 1) throw new Error(`存在多个 ${kind} 列表`);
      if (!containers.length) continue;
      lists++;
      // One malformed entry is skipped; the rest of the definitions stay usable.
      for (const node of containers[0].children) {
        if (node.tagName !== spec.item) {
          result.warnings.push(`${spec.label}列表中的未知元素 ${node.tagName}`);
          continue;
        }
        const read = readEntry(node, spec);
        if (read.error) result.warnings.push(`${spec.label} ${read.id || "（无编号）"}：${read.error}`);
        else result[kind].push(read.entry);
      }
    }
    if (!lists) throw new Error("缺少 characters、settings 或 props 列表");
    if (KIND_NAMES.some((kind) => result[kind].length)) return result;
    return result.warnings.length ? { status: "invalid", reason: result.warnings.join("；") } : { status: "empty", reason: "定义列表为空" };
  } catch (error) {
    return { status: "invalid", reason: error.message };
  }
}

// Align model IDs with the objects it was shown. Preset examples number every reply from C1,
// so a reused ID may be a renumbered old object, a renamed one, or a new object.
function reconcile(kind, entries, shown, known, warnings) {
  const spec = KINDS[kind];
  const snapshot = new Map(shown.map((entry) => [entry.id, entry]));
  let next = nextNumber(spec.letter, [...snapshot.keys(), ...known.keys(), ...entries.map((entry) => entry.id)]);
  const fresh = () => spec.letter + next++;
  const used = new Map();
  const output = [];
  // Unique best name match among unclaimed history objects; ties never remap.
  const byName = (entry, excluded) => {
    let best = 0, found = [];
    for (const candidate of snapshot.values()) {
      if (candidate.id === excluded || used.has(candidate.id)) continue;
      const score = nameScore(candidate.name, entry.name);
      if (score > best) {
        best = score;
        found = [candidate];
      } else if (score && score === best) found.push(candidate);
    }
    return found.length === 1 ? found[0].id : null;
  };
  for (const original of entries) {
    const entry = clone(original);
    let id = entry.id;
    const same = snapshot.get(id);
    if (same && !nameScore(same.name, entry.name)) {
      id = byName(entry, id) || (similarity(kind, same, entry) >= SIMILAR ? id : fresh());
    } else if (!same) {
      const outside = known.get(id);
      id = byName(entry, id) || (outside && !outside.some((item) => sameEntity(kind, item, entry)) ? fresh() : id);
    }
    const earlier = used.get(id);
    if (earlier) {
      if (sameEntity(kind, earlier, entry)) {
        warnings.push(`${spec.label} ${entry.id} 重复定义，已保留第一份`);
        continue;
      }
      id = fresh();
    }
    if (id !== entry.id) entry.originalId = entry.id;
    entry.id = id;
    used.set(id, entry);
    output.push(entry);
  }
  return output;
}

function writeRecord(message, swipe, record) {
  message.extra ||= {};
  if (record === undefined) delete message.extra[RECORD_KEY];
  else message.extra[RECORD_KEY] = record;
  if (Array.isArray(message.swipes) && typeof message.swipes[swipe] === "string") {
    message.swipe_info ||= [];
    message.swipe_info[swipe] ||= { send_date: message.send_date, gen_started: message.gen_started, gen_finished: message.gen_finished, extra: {} };
    message.swipe_info[swipe].extra ||= {};
    if (record === undefined) delete message.swipe_info[swipe].extra[RECORD_KEY];
    else message.swipe_info[swipe].extra[RECORD_KEY] = clone(record);
  }
}

export async function saveDefinitions(request, parsed, getContext, getTags, persist) {
  if (!request || parsed?.status !== "ready") return { saved: false, warnings: [] };
  const context = getContext();
  assertCurrent(request, context, getTags());
  const message = request.message;
  const warnings = [...(parsed.warnings || [])];
  const index = chatIndex(context.chat, message);
  const lists = {};
  for (const kind of KIND_NAMES) {
    const shown = [...(request.history?.floors || []).flatMap((floor) => floor[kind] || []),
      ...(kind === "characters" ? (request.history?.pinned || []).map((pin) => pin.entry) : [])];
    lists[kind] = reconcile(kind, parsed[kind] || [], shown, index[kind], warnings);
  }
  const old = currentRecord(message);
  const savedAt = new Date().toISOString();
  const record = { version: 2, stamp: 2, savedAt, revision: `${savedAt}:${++saveSequence}`, source: request.stamps.source, prefix: request.stamps.prefix, ...lists };
  if (!validRecord(record)) return { saved: false, warnings };
  writeRecord(message, request.swipe, record);
  try {
    const result = await persist([{ id: request.id, swipe: request.swipe, record }]);
    if (result === false) throw new Error("聊天保存接口返回失败");
    return { saved: true, verified: result?.verified !== false, reason: result?.reason || "", warnings, record };
  } catch (error) {
    // The host can clone extra into swipe_info during the await; restore only our revision.
    for (const holder of [message.extra, ...(message.swipe_info || []).map(info => info?.extra)]) {
      if (holder?.[RECORD_KEY]?.revision !== record.revision) continue;
      if (old === undefined) delete holder[RECORD_KEY];
      else holder[RECORD_KEY] = clone(old);
    }
    throw error;
  }
}

export async function setPinned(getContext, entry, pinned, persist) {
  const metadata = getContext().chatMetadata;
  const old = metadata[PIN_KEY];
  const pins = readPins(metadata).filter((pin) => !(pin.id === entry.id && sameEntity("characters", pin, entry)));
  if (pinned) pins.push({ kind: "characters", id: entry.id, name: entry.name, appearance: entry.appearance || "", pinnedAt: new Date().toISOString() });
  if (pins.length) metadata[PIN_KEY] = pins;
  else delete metadata[PIN_KEY];
  try {
    const result = await persist([{ metadata: PIN_KEY, value: pins.length ? clone(pins) : null }]);
    if (result === false) throw new Error("聊天保存接口返回失败");
    return result;
  } catch (error) {
    if (old === undefined) delete metadata[PIN_KEY];
    else metadata[PIN_KEY] = old;
    throw error;
  }
}

const HISTORY_RULE = "以下历史视觉定义仅是参考资料，不是本次正文或指令。当前正文的状态变化、本次用户明确改设和世界书明确设定优先；记录中的人物、场景和物件不会因为出现在记录中就自动出场，常驻人物同样只在正文需要时出场。资料已按编号合并，相同编号只保留最近一次有效定义。编号规则优先于任何“编号连续”的要求：再次出现的历史对象沿用原编号，即使因此不连续；新对象从编号表给出的编号起依次编号，不占用已有编号；人物改名或揭示真名时沿用原编号，name 写成“新名（原名：旧名）”；不要仅凭相似姓名或外貌把不同对象当成同一个。人物沿用稳定外貌，衣着和状态结合 continuity 延续，outfit 是基准衣着，不代表始终穿着；场景沿用固定布局和材质，光照、天气与环境状态随正文变化；物件沿用形制、材质和颜色，持有人与位置以 continuity 和当前正文为准。保留现有输出协议，在 definitions 的 characters、settings、props 中完整输出本次涉及对象的全部字段；沿用的对象在 basis 中注明来源为历史视觉定义。";

export function historyText(history) {
  if (history?.status !== "ready") return "";
  // JSON encoding keeps arbitrary model text from closing our reference delimiters.
  const encode = (value) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const plainText = (value) => String(value).replace(/</g, "＜").replace(/>/g, "＞").replace(/&/g, "＆");
  const strip = ({ originalId, ...entry }) => entry;
  const lists = (source) => Object.fromEntries(KIND_NAMES.filter((kind) => source[kind]?.length).map((kind) => [kind, source[kind].map(strip)]));
  const lines = history.floors.map((floor) => encode({ floor: floor.id, swipe: floor.swipe, ...lists(floor) }));
  for (const pin of history.pinned) lines.push(encode({ pinned: true, floor: pin.floor, swipe: pin.swipe, characters: [strip(pin.entry)] }));
  const used = KIND_NAMES.map((kind) => {
    const ids = [...history.floors.flatMap((floor) => floor[kind]), ...(kind === "characters" ? history.pinned.map((pin) => pin.entry) : [])].map((entry) => entry.id);
    return ids.length ? `${KINDS[kind].label} ${ids.join("、")}` : "";
  }).filter(Boolean).join("；");
  const next = KIND_NAMES.map((kind) => `${KINDS[kind].label}从 ${history.next[kind]} 开始`).join("，");
  return `${HISTORY_RULE}\n<历史视觉定义资料>\n${lines.join("\n")}\n${plainText(`编号表：已有 ${used}。新对象编号：${next}。`)}\n</历史视觉定义资料>`;
}

// Replace both historical variables in one text-only pass, after all macro execution.
export function injectHistory(messages, imageText, characterText, replacedVariables, automatic = false) {
  let positioned = false;
  const replaceText = (text) => text.replace(/\{\{历史绘图提示词\}\}|\{\{历史人物定义\}\}/g, (match) => {
    const isCharacter = match === "{{历史人物定义}}";
    if (isCharacter) positioned = true;
    const value = isCharacter ? characterText : imageText;
    if (value) replacedVariables.add(match);
    return value || "";
  });
  let result = messages.map((message) => ({ ...message, content: typeof message.content === "string" ? replaceText(message.content) :
    Array.isArray(message.content) ? message.content.map((part) => part.type === "text" ? { ...part, text: replaceText(part.text) } : part) : message.content }));
  if (!positioned && automatic && characterText) {
    const index = result.findLastIndex((message) => message.role === "user");
    const part = { type: "text", text: characterText + "\n\n" };
    if (index < 0) result.push({ role: "user", content: part.text });
    else if (typeof result[index].content === "string") result[index].content = part.text + result[index].content;
    else result[index].content = [part, ...(Array.isArray(result[index].content) ? result[index].content : [])];
    replacedVariables.add("{{历史人物定义}}");
  }
  return { messages: result, mode: characterText ? positioned ? "预设变量" : automatic ? "自动附加" : "未注入" : "未注入" };
}

function countText(lists) {
  return [["characters", "人"], ["settings", "场景"], ["props", "物件"]]
    .map(([kind, unit]) => Array.isArray(lists?.[kind]) && lists[kind].length ? `${lists[kind].length} ${unit}` : "").filter(Boolean).join("、");
}

export function describeHistory(history, mode) {
  if (!history) return "历史视觉定义：未找到普通聊天目标楼层，未引用。\n";
  const status = { disabled: "引用已关闭（仍保存新定义）", empty: "没有有效记录", ready: mode }[history.status] || "无法定位楼层";
  const pins = history.pinCount ? `，常驻 ${history.pinCount} 人` : "";
  const window = (history.selectedFloors || history.floors).map((floor) => `#${floor.id}`).join("、");
  const conflicts = history.conflicts ? `，${history.conflicts} 处编号冲突已按楼层区分` : "";
  const merged = `；按编号保留最后一层，合并 ${history.superseded || 0} 条旧定义${conflicts}`;
  const floors = history.floors.map((floor) => `#${floor.id}/swipe ${floor.swipe}（${countText(floor)}）`).join("、");
  const pinned = (history.pinned || []).map((pin) => `${pin.entry.name}←#${pin.floor}`).join("、");
  const skipped = history.skipped.map((item) => `#${item.id} ${item.reason}`).join("、");
  return `历史视觉定义：参考 ${history.depth} 个有定义楼层${pins}；${status}${window ? "；窗口 " + window + merged : ""}${floors ? "；实际来源 " + floors : ""}${pinned ? "；常驻补入 " + pinned : ""}${skipped ? "；跳过 " + skipped : ""}。\n`;
}

export function listRecords(chat, tags) {
  const stamps = timelineStamps(chat, tags);
  const rows = [];
  chat.forEach((message, id) => {
    const active = message?.swipe_id ?? 0;
    const versions = new Set([active, ...(message?.swipe_info || []).map((_, i) => i)]);
    for (const swipe of versions) {
      const record = swipe === active ? currentRecord(message) : message.swipe_info?.[swipe]?.extra?.[RECORD_KEY];
      if (!record) continue;
      const floor = swipe === active ? stamps[id] : swipeStamps(message, tags, message.swipes?.[swipe], stamps[id]);
      rows.push({ id, swipe, record, active: swipe === active, status: recordStatus(record, floor) });
    }
  });
  return rows;
}

export async function deleteRecords(context, rows, persist) {
  // A pending request must not recreate records from a just-cleared history snapshot.
  for (const message of context.chat) {
    const pending = activeRequests.get(message);
    if (pending) pending.cancelled = true;
  }
  const undo = [];
  for (const row of rows) {
    const message = context.chat[row.id];
    if (!message) continue;
    const holders = [];
    if ((message.swipe_id ?? 0) === row.swipe && message.extra) holders.push(message.extra);
    const extra = message.swipe_info?.[row.swipe]?.extra;
    if (extra) holders.push(extra);
    for (const holder of new Set(holders)) {
      if (!(RECORD_KEY in holder)) continue;
      undo.push({ holder, record: holder[RECORD_KEY] });
      delete holder[RECORD_KEY];
    }
  }
  try {
    const result = await persist(rows.map(row => ({ id: row.id, swipe: row.swipe, record: null })));
    if (result === false) throw new Error("聊天保存接口返回失败");
    return result;
  } catch (error) {
    for (const { holder, record } of undo) if (!(RECORD_KEY in holder)) holder[RECORD_KEY] = record;
    throw error;
  }
}

// JSON objects have no meaningful key order; cloud storage may reorder every object.
function firstDifference(expected, actual, path = "记录") {
  if (expected === actual) return null;
  if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") return path;
  if (Array.isArray(expected) !== Array.isArray(actual)) return path;
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) return `${path}.length`;
    for (let index = 0; index < expected.length; index++) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) return `${path}.${key}`;
    const difference = firstDifference(expected[key], actual[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

const inconclusive = (message) => Object.assign(new Error(message), { inconclusive: true });

function verifySavedChanges(data, expected) {
  if (!Array.isArray(data)) throw inconclusive("保存后返回的聊天格式无效");
  // Chat files have a metadata header; older group chat files may omit it.
  const header = data[0] && typeof data[0].mes !== "string" ? data[0] : null;
  const saved = header ? data.slice(1) : data;
  for (const change of expected) {
    if (change.metadata) {
      if (!header?.chat_metadata || typeof header.chat_metadata !== "object") throw inconclusive("聊天文件没有元数据头，无法核对常驻设置");
      const difference = firstDifference(change.value, header.chat_metadata[change.metadata] ?? null, "常驻设置");
      if (difference) throw new Error(`常驻设置未确认：${difference} 不一致，请刷新后核对`);
      continue;
    }
    const message = saved[change.id];
    if (!message) throw new Error(`保存后未找到楼层 ${change.id}`);
    const copies = [];
    if ((message.swipe_id ?? 0) === change.swipe) copies.push(["消息主记录", message.extra?.[RECORD_KEY]]);
    if (change.mirrored || (message.swipe_id ?? 0) !== change.swipe) copies.push(["swipe 副本", message.swipe_info?.[change.swipe]?.extra?.[RECORD_KEY]]);
    for (const [label, record] of copies) {
      const difference = firstDifference(change.record, record ?? null);
      if (!difference) continue;
      const reason = record == null ? "定义记录缺失" : change.record == null ? "定义记录尚未删除" : `${difference} 不一致`;
      throw new Error(`楼层 ${change.id} / swipe ${change.swipe} 的${label}未确认：${reason}，请刷新后核对`);
    }
  }
}

// Read back up to three times for lagging cloud storage. A failed read proves nothing either way.
async function readBack(fetcher, endpoint, options, expected) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let outcome = { inconclusive: "未能读取聊天" };
  try {
    for (const delay of [0, 250, 750]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (controller.signal.aborted) return { inconclusive: "读取超时" };
      let data;
      try {
        const response = await fetcher(endpoint, { ...options, signal: controller.signal });
        if (!response.ok) {
          outcome = { inconclusive: `HTTP ${response.status}` };
          continue;
        }
        data = await response.json();
      } catch (error) {
        outcome = { inconclusive: controller.signal.aborted ? "读取超时" : error?.message || "网络错误" };
        continue;
      }
      try {
        verifySavedChanges(data, expected);
        return { verified: true };
      } catch (error) {
        outcome = error.inconclusive ? { inconclusive: error.message } : { error };
      }
    }
    return outcome;
  } finally { clearTimeout(timeout); }
}

// saveChatConditional in the host swallows errors and silently skips a save while another one
// runs for over a second. Verify through its read API and save once more if our data is missing.
export async function persistAndVerify(context, changes, persist, fetcher, headers) {
  const read = typeof context === "function" ? context : () => context;
  const start = read();
  const group = start.groupId !== undefined && start.groupId !== null && start.groupId !== "";
  const character = start.characters?.[start.characterId];
  if (!start.chatId || (!group && !character?.avatar)) throw new Error("无法确定聊天文件，未请求保存");
  const endpoint = group ? "/api/chats/group/get" : "/api/chats/get";
  const body = JSON.stringify(group ? { id: start.chatId } : { ch_name: character.name, file_name: start.chatId, avatar_url: character.avatar });
  const expected = changes.map(change => change.metadata ? { metadata: change.metadata, value: clone(change.value ?? null) } : {
    ...change, record: clone(change.record ?? null), mirrored: typeof start.chat?.[change.id]?.swipes?.[change.swipe] === "string" });
  const { chatId, chatMetadata } = start;
  const sameChat = () => read().chatId === chatId && read().chatMetadata === chatMetadata;
  for (let attempt = 0; ; attempt++) {
    if (await persist() === false) throw new Error("聊天保存接口返回失败");
    const outcome = await readBack(fetcher, endpoint, { method: "POST", headers, body, cache: "no-store" }, expected);
    if (outcome.verified) return { verified: true };
    if (outcome.inconclusive) return { verified: false, reason: outcome.inconclusive };
    // Save again only while the same chat is open: the host always writes the chat on screen.
    if (attempt > 0 || !sameChat()) throw outcome.error;
  }
}

export function openManager({ document, getContext, getTags, persist, events, types, notify }) {
  closeManager?.();
  const origin = getContext();
  const dialog = document.createElement("dialog");
  dialog.id = "ch-character-definitions-manager";
  dialog.style.cssText = "width:min(760px,94vw);max-height:85vh;overflow:auto;background:var(--st-chatu8-bg-primary,#222);color:var(--st-chatu8-text-primary,#eee);border:1px solid #777;border-radius:12px;padding:20px;";
  const title = document.createElement("h3");
  title.textContent = "当前聊天的视觉定义";
  const close = document.createElement("button");
  close.textContent = "关闭";
  const clear = document.createElement("button");
  clear.textContent = "清空当前聊天全部记录";
  clear.style.margin = "0 12px";
  const pinsBox = document.createElement("div");
  const content = document.createElement("div");
  dialog.append(title, close, clear, pinsBox, content);
  let disposed = false, saving = false;
  const listeners = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [event, handler] of listeners) events.removeListener(event, handler);
    dialog.remove();
    if (closeManager === dispose) closeManager = null;
  };
  closeManager = dispose;
  dialog.addEventListener("close", dispose);
  close.onclick = dispose;
  const sameChat = () => getContext().chatMetadata === origin.chatMetadata && getContext().chatId === origin.chatId;
  const action = (text, name, onclick) => {
    const button = document.createElement("button");
    button.textContent = text;
    button.dataset.action = name;
    button.onclick = onclick;
    return button;
  };
  const run = async (task, failure) => {
    saving = true;
    clear.disabled = true;
    dialog.querySelectorAll("button[data-action]").forEach((button) => button.disabled = true);
    try {
      const result = await task();
      if (result?.verified === false) notify(`已修改当前聊天，但服务器核对未完成（${result.reason}），刷新前请确认。`);
    } catch (error) { notify(`${failure}：${error.message}`); }
    finally { saving = false; if (!disposed) render(); }
  };
  const remove = async (rows, message) => {
    if (saving || !sameChat()) return dispose();
    if (!globalThis.confirm(message)) return;
    if (!sameChat()) return dispose();
    await run(() => deleteRecords(getContext(), rows, persist), "视觉定义删除未确认，内存记录已恢复");
  };
  const togglePin = async (entry, pinned) => {
    if (saving || !sameChat()) return dispose();
    await run(() => setPinned(getContext, entry, pinned, persist), "常驻设置未确认，已恢复原设置");
  };
  function entryBlock(kind, entry, pins) {
    const spec = KINDS[kind];
    const block = document.createElement("div");
    block.style.cssText = "margin-top:12px;padding-top:8px;border-top:1px solid #7776;";
    const heading = document.createElement("div");
    heading.style.fontWeight = "600";
    heading.textContent = `${spec.label} ${entry?.id ?? "?"}${entry?.originalId ? `（模型原编号 ${entry.originalId}）` : ""}`;
    const fields = document.createElement("dl");
    fields.style.margin = "4px 0";
    for (const key of spec.fields.slice(1)) {
      const label = document.createElement("dt");
      label.style.cssText = "font-weight:600;margin-top:8px;";
      label.textContent = spec.labels[key];
      const value = document.createElement("dd");
      value.style.cssText = "margin:2px 0 0;white-space:pre-wrap;";
      value.textContent = typeof entry?.[key] === "string" ? entry[key] : "（字段无效）";
      fields.append(label, value);
    }
    block.append(heading, fields);
    if (kind === "characters" && typeof entry?.id === "string" && typeof entry.name === "string") {
      const pinned = isPinned(pins, entry);
      block.append(action(pinned ? "取消常驻" : "设为常驻", "pin", () => togglePin(entry, !pinned)));
    }
    return block;
  }
  function render() {
    if (!sameChat()) return dispose();
    const context = getContext();
    const rows = listRecords(context.chat || [], getTags());
    const pins = readPins(context.chatMetadata);
    pinsBox.replaceChildren();
    if (pins.length) {
      const heading = document.createElement("h4");
      heading.style.margin = "14px 0 4px";
      heading.textContent = `常驻人物（${pins.length}）：不受参考楼层数限制，始终引用目标楼层之前的最新有效定义`;
      pinsBox.append(heading);
      for (const pin of pins) {
        const latest = rows.filter((row) => row.active && row.status === "有效").reverse()
          .find((row) => recordLists(row.record).characters.some((entry) => entry.id === pin.id && sameEntity("characters", pin, entry)));
        const line = document.createElement("div");
        line.style.cssText = "margin:4px 0;overflow-wrap:anywhere;";
        line.textContent = `${pin.name}（${pin.id}）· ${latest ? `最新有效定义在楼层 ${latest.id}` : "当前没有有效定义"} `;
        line.append(action("取消常驻", "unpin", () => togglePin(pin, false)));
        pinsBox.append(line);
      }
    }
    content.replaceChildren();
    clear.disabled = saving || !rows.length;
    clear.onclick = () => remove(rows, "清空当前聊天所有楼层及所有 swipe 的视觉定义记录？常驻标记保留，此操作不删除聊天或图片。");
    if (!rows.length) content.textContent = "暂无保存的视觉定义。有效绘图方案返回后将自动保存。";
    for (const row of rows) {
      const section = document.createElement("details");
      const summary = document.createElement("summary");
      const saved = row.record.savedAt ? new Date(row.record.savedAt).toLocaleString() : "";
      const lists = recordLists(row.record);
      summary.textContent = `楼层 ${row.id} · swipe ${row.swipe}${row.active ? "（当前版本）" : ""} · ${row.status} · ${countText(lists) || "无内容"} · ${saved}`;
      const text = document.createElement("div");
      text.style.cssText = "overflow-wrap:anywhere;text-align:left;font-size:14px;line-height:1.6;";
      for (const kind of KIND_NAMES) {
        for (const entry of Array.isArray(lists[kind]) ? lists[kind] : []) text.append(entryBlock(kind, entry, pins));
      }
      section.append(summary, text, action("删除此记录", "delete", () => remove([row], `删除楼层 ${row.id}、swipe ${row.swipe} 的视觉定义？`)));
      content.append(section);
    }
  }
  for (const name of ["CHAT_CHANGED", "MESSAGE_SWIPED", "MESSAGE_SWIPE_DELETED", "MESSAGE_EDITED", "MESSAGE_DELETED"]) {
    if (!events?.on || !types?.[name]) continue;
    const handler = name === "CHAT_CHANGED" ? dispose : () => { if (!saving) render(); };
    events.on(types[name], handler);
    listeners.push([types[name], handler]);
  }
  document.body.append(dialog);
  render();
  if (!disposed) dialog.showModal();
  return { close: dispose, refresh: render };
}
