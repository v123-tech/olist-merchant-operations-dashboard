/* Browser-local simulation only. No historical order or remote service is written. */
export const STORAGE_KEY = "olist-portfolio:actions:v1";
export const STORAGE_LIMITS = Object.freeze({actions: 500, history: 1000, characters: 900000});

const STATUSES = new Set(["pending", "processing", "resolved", "ignored"]);
const BODY_FIELDS = new Set(["order_id", "status", "note"]);
const ORDER_ID = /^[0-9a-f]{32}$/;
const fail = (message, code = "invalid_request") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const emptyStore = () => ({version: 1, nextId: 1, actions: {}, history: []});
const validRecord = record => record && typeof record.order_id === "string" &&
  ORDER_ID.test(record.order_id) && STATUSES.has(record.status) &&
  typeof record.note === "string" && [...record.note].length <= 2000 &&
  typeof record.updated_at === "string" && Number.isFinite(Date.parse(record.updated_at)) &&
  record.simulated === true;
const storeShape = store => store && typeof store === "object" && !Array.isArray(store) &&
  store.version === 1 && Number.isSafeInteger(store.nextId) && store.nextId >= 1 &&
  store.actions && typeof store.actions === "object" && !Array.isArray(store.actions) &&
  Array.isArray(store.history);
const validRecords = store => Object.entries(store.actions).every(([id, record]) =>
  id === record?.order_id && validRecord(record)) && store.history.every(record =>
  validRecord(record) && Number.isSafeInteger(record.id) && record.id > 0 && record.id < store.nextId);
const exceedsCounts = store => Object.keys(store.actions).length > STORAGE_LIMITS.actions ||
  store.history.length > STORAGE_LIMITS.history;
const invalidStore = () => fail("本浏览器的模拟记录损坏或超出限制。请使用“重置模拟记录”清除后重试；历史数据不受影响。", "storage_invalid");
const limitReached = () => fail("本次演示记录已达到浏览器存储上限。请重置模拟记录后再试；本次处置未保存。", "storage_limit");

/**
 * Dependencies are resolved only when an operation needs them. Importing this
 * module never touches localStorage or navigator, including blocked browsers.
 * `now` may return a Date, an ISO string, or a timestamp; the stored format is ISO.
 * The queue serializes this adapter's async mutations and resets. Cross-tab
 * exclusion additionally requires the browser's optional Web Locks API.
 */
export function createStorageAdapter({storage, locks, now = () => new Date()} = {}) {
  let queue = Promise.resolve();

  function getStorage() {
    return storage === undefined ? globalThis.localStorage : storage;
  }

  function read() {
    let text;
    try {
      text = getStorage().getItem(STORAGE_KEY);
    } catch {
      fail("浏览器禁止本地保存。请允许此网站使用本地存储后重试；本次处置未保存。", "storage_unavailable");
    }
    if (text === null) return emptyStore();
    try {
      if (typeof text !== "string" || text.length > STORAGE_LIMITS.characters) return invalidStore();
      const store = JSON.parse(text);
      if (!storeShape(store) || exceedsCounts(store) || !validRecords(store)) return invalidStore();
      return store;
    } catch {
      return invalidStore();
    }
  }

  function write(store) {
    // Validate before touching storage; never shorten an existing record to fit.
    if (!storeShape(store)) return invalidStore();
    if (exceedsCounts(store)) return limitReached();
    if (!validRecords(store)) return invalidStore();
    let text;
    try {
      text = JSON.stringify(store);
    } catch {
      return invalidStore();
    }
    if (text.length > STORAGE_LIMITS.characters) return limitReached();
    try {
      getStorage().setItem(STORAGE_KEY, text);
    } catch {
      fail("浏览器存储空间不足或禁止保存；本次处置未保存。请检查浏览器设置或重置模拟记录后重试。", "storage_unavailable");
    }
  }

  function inQueue(operation) {
    const result = queue.then(operation);
    // One rejected operation must not poison subsequent reset/save attempts.
    queue = result.catch(() => {});
    return result;
  }

  function withLock(commit) {
    let availableLocks = locks;
    if (availableLocks === undefined) {
      try { availableLocks = globalThis.navigator?.locks; } catch { availableLocks = undefined; }
    }
    return typeof availableLocks?.request === "function" ? availableLocks.request(STORAGE_KEY, commit) : commit();
  }

  function reset() {
    return inQueue(() => withLock(() => {
      try { getStorage().removeItem(STORAGE_KEY); } catch {
        fail("浏览器禁止清除本地存储，请检查设置后重试。", "storage_unavailable");
      }
      return {reset: true, simulated: true};
    }));
  }

  async function mutateAction(body, {hasOrder} = {}) {
    let input;
    try { input = typeof body === "string" ? JSON.parse(body) : body; } catch {
      fail("提交内容不是有效JSON。", "invalid_json");
    }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(field => !BODY_FIELDS.has(field))) {
      fail("仅支持order_id、status、note字段。", "invalid_body");
    }
    if (typeof input.order_id !== "string" || !ORDER_ID.test(input.order_id)) {
      fail("订单ID必须为32位小写十六进制字符。", "invalid_order_id");
    }
    if (!STATUSES.has(input.status)) fail("处置状态不合法。", "invalid_status");
    const note = input.note ?? "";
    if (typeof note !== "string" || [...note].length > 2000) {
      fail("备注应为文本且不超过2000字符。", "invalid_note");
    }
    const trimmed = note.trim();
    if (input.status === "ignored" && !trimmed) fail("忽略任务时必须填写原因。", "reason_required");
    // Snapshot input before awaiting existence, so callers cannot alter a save.
    const orderId = input.order_id, status = input.status;
    if (typeof hasOrder !== "function") fail("未提供订单核对方法，本次处置未保存。");
    return inQueue(async () => {
      if (!await hasOrder(orderId)) fail("订单不存在。", "order_not_found");
      return withLock(() => {
        const store = read(), previous = store.actions[orderId];
        const changed = !previous || previous.status !== status || previous.note !== trimmed;
        if (changed) {
          const record = {order_id: orderId, status, note: trimmed, updated_at: new Date(now()).toISOString(), simulated: true};
          store.actions[orderId] = record;
          store.history.push({...record, id: store.nextId++});
          write(store);
        }
        return {
          action: store.actions[orderId], changed,
          history_count: store.history.filter(record => record.order_id === orderId).length,
          simulated: true,
          note: "仅保存本地演示处置，不改变历史履约事件，也不发送真实消息。"
        };
      });
    });
  }

  return Object.freeze({read, write, reset, mutateAction, key: STORAGE_KEY, limits: STORAGE_LIMITS});
}
