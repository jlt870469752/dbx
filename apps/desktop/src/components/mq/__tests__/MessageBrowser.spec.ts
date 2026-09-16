// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useSettingsStore } from "@/stores/settingsStore";

const backend = vi.hoisted(() => ({
  mqPeekMessages: vi.fn(),
  mqPeekMessagesRange: vi.fn(),
  mqStartReadSession: vi.fn(),
  mqReadSessionNext: vi.fn(),
  mqCloseReadSession: vi.fn(),
}));

const clipboard = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}));

vi.mock("@/lib/backend/api", () => ({
  mqPeekMessages: backend.mqPeekMessages,
  mqPeekMessagesRange: backend.mqPeekMessagesRange,
  mqStartReadSession: backend.mqStartReadSession,
  mqReadSessionNext: backend.mqReadSessionNext,
  mqCloseReadSession: backend.mqCloseReadSession,
}));

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: clipboard.copyToClipboard,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => toast,
}));

import MessageBrowser from "@/components/mq/MessageBrowser.vue";

const TOPIC = {
  tenant: "_kafka",
  namespace: "default",
  topic: "events",
  persistent: true,
  partitioned: false,
};

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function waitForExpectation(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushUi();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

async function setPageSizePreset(container: ParentNode, value: string) {
  const select = container.querySelector<HTMLSelectElement>('[data-testid="peek-page-size-preset"]');
  if (!select) throw new Error("Kafka page size selector not found");
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await flushUi();
}

async function mountBrowser(
  mqSystemKind: "kafka" | "rabbitmq" = "kafka",
  options: {
    ranges?: Array<{ partition: number; beginOffset: number; endOffset: number }>;
  } = {},
) {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(MessageBrowser, {
    connectionId: "mq-1",
    topic: { ...TOPIC, tenant: mqSystemKind === "rabbitmq" ? "_rabbitmq" : "_kafka" },
    mqSystemKind,
    kafkaPartitionRanges: options.ranges,
  });
  app.mount(root);
  await flushUi();
  return root;
}

async function loadMessages(container: ParentNode) {
  buttonByText(container, "mqMessages.loadMessages").click();
  await flushUi();
}

function message(offset: number, payload = `message-${offset}`) {
  return {
    position: offset + 1,
    messageId: String(offset),
    payloadBase64: "",
    payloadText: payload,
    properties: { partition: "0" },
    headers: {},
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  backend.mqPeekMessages.mockReset();
  backend.mqPeekMessagesRange.mockReset();
  backend.mqStartReadSession.mockReset();
  backend.mqReadSessionNext.mockReset();
  backend.mqCloseReadSession.mockReset();
  clipboard.copyToClipboard.mockReset().mockResolvedValue(undefined);
  toast.toast.mockReset();
  backend.mqPeekMessages.mockResolvedValue([message(0, "existing message")]);
  backend.mqPeekMessagesRange.mockResolvedValue({ messages: [message(0, "range message")], incomplete: false });
  backend.mqStartReadSession.mockResolvedValue({ sessionId: "session-1", messages: [], incomplete: false, done: true });
  backend.mqReadSessionNext.mockResolvedValue({ sessionId: "session-1", messages: [], incomplete: false, done: true });
  backend.mqCloseReadSession.mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("MessageBrowser", () => {
  it("uses the selected page size as the Kafka request count", async () => {
    const browser = await mountBrowser();
    await setPageSizePreset(browser, "custom");
    const countInput = browser.querySelector<HTMLInputElement>('[data-testid="peek-count"]');
    if (!countInput) throw new Error("Custom page size input not found");
    await setInputValue(countInput, "1000");

    const start = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    const end = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]');
    if (!start || !end) throw new Error("Kafka offset inputs not found");
    await setInputValue(start, "0");
    await setInputValue(end, "1000");
    await loadMessages(browser);

    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 1000, expect.objectContaining({ startPosition: "offset", offset: 0, endOffset: 1000 }));
  });

  it("uses Kafka range reads when the read-session setting is enabled", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.kafkaUseReadSession = true;
    backend.mqPeekMessagesRange.mockResolvedValueOnce({ messages: [message(500, "range payload")], incomplete: false });
    const browser = await mountBrowser();
    await setPageSizePreset(browser, "500");
    const start = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    const end = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]');
    if (!start || !end) throw new Error("Kafka offset inputs not found");
    await setInputValue(start, "500");
    await setInputValue(end, "1000");

    await loadMessages(browser);

    expect(backend.mqPeekMessagesRange).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", undefined, 500, 1000, 500);
    expect(backend.mqPeekMessages).not.toHaveBeenCalled();
    expect(browser.textContent).toContain("range payload");
  });

  it("uses the current page size for enabled Kafka browsing", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.kafkaUseReadSession = true;
    backend.mqPeekMessagesRange.mockResolvedValueOnce({ messages: [message(0, "page payload")], incomplete: false });
    const browser = await mountBrowser();
    await loadMessages(browser);

    expect(backend.mqPeekMessagesRange).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", undefined, 0, 100, 100);
    expect(backend.mqStartReadSession).not.toHaveBeenCalled();
  });

  it("splits a large legacy Kafka page into agent-sized requests", async () => {
    backend.mqPeekMessages
      .mockResolvedValueOnce([message(0)])
      .mockResolvedValueOnce([message(1000)])
      .mockResolvedValueOnce([message(2000)]);
    const browser = await mountBrowser();
    await setPageSizePreset(browser, "custom");
    const countInput = browser.querySelector<HTMLInputElement>('[data-testid="peek-count"]');
    const start = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    const end = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]');
    if (!countInput || !start || !end) throw new Error("Kafka page controls not found");
    await setInputValue(countInput, "2500");
    await setInputValue(start, "0");
    await setInputValue(end, "2500");

    await loadMessages(browser);

    expect(backend.mqPeekMessages).toHaveBeenNthCalledWith(1, "mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 1000, expect.objectContaining({ offset: 0, endOffset: 1000 }));
    expect(backend.mqPeekMessages).toHaveBeenNthCalledWith(2, "mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 1000, expect.objectContaining({ offset: 1000, endOffset: 2000 }));
    expect(backend.mqPeekMessages).toHaveBeenNthCalledWith(3, "mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 500, expect.objectContaining({ offset: 2000, endOffset: 2500 }));
  });

  it("reads a large enabled Kafka page through session next batches", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.kafkaUseReadSession = true;
    const firstBatch = Array.from({ length: 1000 }, (_, index) => message(index));
    const secondBatch = Array.from({ length: 500 }, (_, index) => message(1000 + index));
    backend.mqStartReadSession.mockResolvedValueOnce({
      sessionId: "session-1",
      messages: firstBatch,
      incomplete: false,
      done: false,
    });
    backend.mqReadSessionNext.mockResolvedValueOnce({ sessionId: "session-1", messages: secondBatch, incomplete: false, done: true });
    const browser = await mountBrowser();
    await setPageSizePreset(browser, "custom");
    const countInput = browser.querySelector<HTMLInputElement>('[data-testid="peek-count"]');
    const start = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    const end = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]');
    if (!countInput || !start || !end) throw new Error("Kafka page controls not found");
    await setInputValue(countInput, "1500");
    await setInputValue(start, "0");
    await setInputValue(end, "1500");

    await loadMessages(browser);

    expect(backend.mqStartReadSession).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", undefined, 0, 1500, 1000);
    expect(backend.mqReadSessionNext).toHaveBeenCalledTimes(1);
    expect(backend.mqReadSessionNext).toHaveBeenCalledWith("mq-1", "session-1", 500);
    expect(backend.mqCloseReadSession).toHaveBeenCalledWith("mq-1", "session-1");
  });

  it("searches Kafka with a read session when the setting is enabled", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.kafkaUseReadSession = true;
    backend.mqStartReadSession.mockResolvedValueOnce({ sessionId: "session-1", messages: [message(0)], incomplete: false, done: false });
    backend.mqReadSessionNext.mockResolvedValueOnce({ sessionId: "session-1", messages: [message(100)], incomplete: false, done: false }).mockResolvedValueOnce({ sessionId: "session-1", messages: [message(250, "needle payload")], incomplete: false, done: false });
    backend.mqPeekMessagesRange.mockResolvedValueOnce({ messages: [message(200), message(250, "needle payload")], incomplete: false });
    const browser = await mountBrowser();
    const start = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    const end = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]');
    const filter = browser.querySelector<HTMLInputElement>('[data-testid="kafka-message-filter-input"]');
    if (!start || !end || !filter) throw new Error("Kafka search inputs not found");
    await setInputValue(start, "0");
    await setInputValue(end, "400");
    await setInputValue(filter, "needle");

    buttonByText(browser, "mqMessages.scanRange").click();
    await waitForExpectation(() => {
      expect(browser.querySelector('[data-testid="kafka-current-page"]')?.textContent).toContain('{"page":3}');
    });

    expect(backend.mqStartReadSession).toHaveBeenCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", undefined, 0, 400, 1000);
    expect(backend.mqReadSessionNext).toHaveBeenCalledWith("mq-1", "session-1", 1000);
    expect(backend.mqCloseReadSession).toHaveBeenCalledWith("mq-1", "session-1");
    expect(browser.textContent).toContain("needle payload");
  });

  it("restarts Kafka read-session search when the session expires", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.kafkaUseReadSession = true;
    backend.mqStartReadSession.mockResolvedValueOnce({ sessionId: "expired-session", messages: [message(0)], incomplete: false, done: false }).mockResolvedValueOnce({ sessionId: "session-2", messages: [message(0)], incomplete: false, done: false });
    backend.mqReadSessionNext.mockRejectedValueOnce(new Error("Kafka read session not found: expired-session")).mockResolvedValueOnce({ sessionId: "session-2", messages: [message(150, "needle payload")], incomplete: false, done: false });
    backend.mqPeekMessagesRange.mockResolvedValueOnce({ messages: [message(100), message(150, "needle payload")], incomplete: false });
    const browser = await mountBrowser();
    const end = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]');
    const filter = browser.querySelector<HTMLInputElement>('[data-testid="kafka-message-filter-input"]');
    if (!end || !filter) throw new Error("Kafka search inputs not found");
    await setInputValue(end, "300");
    await setInputValue(filter, "needle");

    buttonByText(browser, "mqMessages.scanRange").click();
    await waitForExpectation(() => {
      expect(backend.mqStartReadSession).toHaveBeenCalledTimes(2);
      expect(browser.textContent).toContain("needle payload");
    });

    expect(backend.mqCloseReadSession).toHaveBeenCalledWith("mq-1", "expired-session");
    expect(backend.mqCloseReadSession).toHaveBeenCalledWith("mq-1", "session-2");
  });

  it("uses Kafka partition begin and end offsets as the default range", async () => {
    const browser = await mountBrowser("kafka", {
      ranges: [{ partition: 0, beginOffset: 902, endOffset: 2818 }],
    });

    expect(browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]')?.value).toBe("902");
    expect(browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]')?.value).toBe("2818");
  });

  it("navigates Kafka pages using the configured offset range", async () => {
    backend.mqPeekMessages.mockResolvedValueOnce([message(0)]).mockResolvedValueOnce([message(100)]);
    const browser = await mountBrowser();
    const start = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    const end = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]');
    if (!start || !end) throw new Error("Kafka offset inputs not found");
    await setInputValue(start, "0");
    await setInputValue(end, "200");

    await loadMessages(browser);
    expect(browser.querySelector('[data-testid="kafka-current-page"]')?.textContent).toContain('{"page":1}');
    buttonByText(browser, "mqMessages.nextPage").click();
    await flushUi();

    expect(backend.mqPeekMessages).toHaveBeenLastCalledWith("mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 100, expect.objectContaining({ offset: 100, endOffset: 200 }));
    expect(browser.querySelector('[data-testid="kafka-current-page"]')?.textContent).toContain('{"page":2}');
  });

  it("searches the configured range and navigates to the matching page", async () => {
    backend.mqPeekMessages.mockResolvedValueOnce([message(450, "needle payload")]).mockResolvedValueOnce([message(400), message(450, "needle payload")]);
    const browser = await mountBrowser();
    const start = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-offset"]');
    const end = browser.querySelector<HTMLInputElement>('[data-testid="kafka-peek-end-offset"]');
    const filter = browser.querySelector<HTMLInputElement>('[data-testid="kafka-message-filter-input"]');
    if (!start || !end || !filter) throw new Error("Kafka search inputs not found");
    await setInputValue(start, "0");
    await setInputValue(end, "500");
    await setInputValue(filter, "needle");

    buttonByText(browser, "mqMessages.scanRange").click();
    await waitForExpectation(() => {
      expect(browser.querySelector('[data-testid="kafka-current-page"]')?.textContent).toContain('{"page":5}');
    });

    expect(backend.mqPeekMessages).toHaveBeenNthCalledWith(1, "mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 500, expect.objectContaining({ offset: 0, endOffset: 500 }));
    expect(backend.mqPeekMessages).toHaveBeenNthCalledWith(2, "mq-1", expect.objectContaining({ topic: "events" }), "__dbx_kafka_viewer__", 100, expect.objectContaining({ offset: 400, endOffset: 500 }));
    expect(browser.textContent).toContain("needle payload");
  });

  it("keeps non-Kafka message peeking on its existing request shape", async () => {
    const browser = await mountBrowser("rabbitmq");
    await loadMessages(browser);

    expect(backend.mqPeekMessages).toHaveBeenCalledWith("mq-1", expect.objectContaining({ tenant: "_rabbitmq", topic: "events" }), "__dbx_kafka_viewer__", 20, {});
  });
});
