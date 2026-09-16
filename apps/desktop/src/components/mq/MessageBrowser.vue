<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy } from "@lucide/vue";
import type { MqSystemKind, PeekedMessage, PeekMessagesOptions, TopicRef } from "@/types/mq";
import { mqCloseReadSession, mqPeekMessages, mqPeekMessagesRange, mqReadSessionNext, mqStartReadSession } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { copyToClipboard } from "@/lib/common/clipboard";
import { buildKafkaMessageSearchText, kafkaMessageSearchTextMatches, normalizeKafkaMessageSearchQuery } from "@/lib/mq/kafkaMessageSearch";
import { parseNonNegativeSafeInteger } from "@/lib/mq/mqPeekFilters";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { Button } from "@/components/ui/button";
import MqSearchInput from "@/components/mq/shared/MqSearchInput.vue";

type MessageBrowserAppearance = "form" | "monitoring";

interface KafkaPartitionRange {
  partition: number;
  beginOffset: number;
  endOffset: number;
}

interface Props {
  connectionId: string;
  topic?: TopicRef | null;
  mqSystemKind?: MqSystemKind;
  /** Known Kafka partition ids, used to calculate the next page for all-partition reads. */
  kafkaPartitions?: number[];
  /** Kafka beginning/end offsets, including partitions omitted from a global first page. */
  kafkaPartitionRanges?: KafkaPartitionRange[];
  /** Flatten chrome when embedded in MonitoringPanel so it is not a second nested card. */
  appearance?: MessageBrowserAppearance;
}

const props = withDefaults(defineProps<Props>(), {
  appearance: "form",
});
const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const KAFKA_AGENT_MAX_PEEK_COUNT = 1000;

const loading = ref(false);
const error = ref<string>();
const messages = ref<PeekedMessage[]>([]);
const incomplete = ref(false);
const scanning = ref(false);
const partition = ref<string | number>("");
const offset = ref<string | number>("");
const endOffset = ref<string | number>("");
const count = ref(props.mqSystemKind === "kafka" ? 100 : 20);
const pageSizePreset = ref("100");
const currentPage = ref(1);
const advancedExpanded = ref(false);
const messageSearchQuery = ref("");
const scanStatus = ref("");
const lastAutoStartOffset = ref<number>();
const lastAutoEndOffset = ref<number>();
let messageRequestVersion = 0;
let activeReadSessionId: string | undefined;
let activeReadSessionConnectionId: string | undefined;

const isKafka = computed(() => props.mqSystemKind === "kafka");
const isMonitoring = computed(() => props.appearance === "monitoring");
const normalizedMessageSearchQuery = computed(() => normalizeKafkaMessageSearchQuery(messageSearchQuery.value));
const searchableMessages = computed(() =>
  messages.value.map((message) => ({
    message,
    searchText: buildKafkaMessageSearchText(message, formatMessageTimestamp(message.publishTime)),
  })),
);
const filteredMessages = computed(() => {
  const query = normalizedMessageSearchQuery.value;
  if (!query) return messages.value;
  return searchableMessages.value.filter(({ searchText }) => kafkaMessageSearchTextMatches(searchText, query)).map(({ message }) => message);
});
const displayMessages = computed(() => (isKafka.value ? filteredMessages.value : messages.value));
const currentRange = computed(() => {
  if (!isKafka.value) return undefined;
  const range = parseKafkaRange(false);
  if (!range) return undefined;
  const start = range.startOffset + (currentPage.value - 1) * range.pageSize;
  const end = Math.min(range.endOffset, start + range.pageSize);
  return { ...range, pageStart: start, pageEnd: end };
});
const canGoPreviousPage = computed(() => isKafka.value && currentPage.value > 1 && !loading.value && !scanning.value);
const canGoNextPage = computed(() => {
  const range = currentRange.value;
  return !!range && range.pageEnd < range.endOffset && !loading.value && !scanning.value;
});

function normalizeBrowseResult(result: Awaited<ReturnType<typeof mqPeekMessages>>) {
  return Array.isArray(result) ? { messages: result, incomplete: false } : result;
}

function messagePartition(message: PeekedMessage): number | undefined {
  const value = message.properties?.partition;
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function messageOffset(message: PeekedMessage): number | undefined {
  if (message.messageId == null || message.messageId === "") return undefined;
  const parsed = Number(message.messageId);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function messageKey(message: PeekedMessage): string {
  const messagePartitionValue = messagePartition(message);
  const messageOffsetValue = messageOffset(message);
  if (messagePartitionValue != null && messageOffsetValue != null) {
    return `${messagePartitionValue}:${messageOffsetValue}`;
  }
  return `${messagePartitionValue ?? "p"}:${message.messageId ?? message.position}`;
}

function sortKafkaMessages(values: PeekedMessage[]): PeekedMessage[] {
  return [...values].sort((left, right) => {
    const leftOffset = messageOffset(left) ?? 0;
    const rightOffset = messageOffset(right) ?? 0;
    const leftPartition = messagePartition(left) ?? 0;
    const rightPartition = messagePartition(right) ?? 0;
    return leftOffset - rightOffset || leftPartition - rightPartition;
  });
}

function normalizedCount(): number {
  // This is the page size shown in the UI. Larger Kafka pages are split into
  // multiple agent batches so the agent's per-RPC limit remains independent.
  const maxCount = isKafka.value ? 10000 : 100;
  const fallback = isKafka.value ? 100 : 20;
  const resultLimit = Math.max(1, Math.min(maxCount, Math.trunc(Number(count.value) || fallback)));
  count.value = resultLimit;
  if (["100", "500", "1000"].includes(String(resultLimit))) pageSizePreset.value = String(resultLimit);
  return resultLimit;
}

const useKafkaReadSession = computed(() => isKafka.value && settingsStore.editorSettings.kafkaUseReadSession);

function selectedKafkaPartitions(): number[] {
  const partitionText = String(partition.value).trim();
  if (partitionText !== "") {
    const parsedPartition = parseNonNegativeSafeInteger(partitionText);
    return parsedPartition == null ? [] : [parsedPartition];
  }

  const partitionIds = new Set<number>([...(props.kafkaPartitions ?? []), ...(props.kafkaPartitionRanges?.map((range) => range.partition) ?? [])]);
  for (const message of messages.value) {
    const messagePartitionValue = messagePartition(message);
    if (messagePartitionValue != null) partitionIds.add(messagePartitionValue);
  }
  return [...partitionIds].sort((left, right) => left - right);
}

function partitionRange(partitionId: number): KafkaPartitionRange | undefined {
  return props.kafkaPartitionRanges?.find((range) => range.partition === partitionId);
}

function kafkaDefaultStartOffset(): number {
  const partitions = selectedKafkaPartitions();
  const ranges = partitions.map(partitionRange).filter((range): range is KafkaPartitionRange => !!range);
  if (!ranges.length) return 0;
  return Math.min(...ranges.map((range) => range.beginOffset));
}

function kafkaDefaultEndOffset(): number {
  const partitions = selectedKafkaPartitions();
  const ranges = partitions.map(partitionRange).filter((range): range is KafkaPartitionRange => !!range);
  if (!ranges.length) return Number.MAX_SAFE_INTEGER;
  return Math.max(...ranges.map((range) => range.endOffset));
}

function syncKafkaDefaultOffsets() {
  if (!isKafka.value) return;
  const ranges = props.kafkaPartitionRanges ?? [];
  if (!ranges.length) return;

  const start = kafkaDefaultStartOffset();
  const end = kafkaDefaultEndOffset();
  const currentStart = String(offset.value).trim();
  const currentEnd = String(endOffset.value).trim();
  const previousStart = lastAutoStartOffset.value == null ? "" : String(lastAutoStartOffset.value);
  const previousEnd = lastAutoEndOffset.value == null ? "" : String(lastAutoEndOffset.value);

  if (currentStart === "" || currentStart === previousStart) {
    offset.value = String(start);
  }
  if (currentEnd === "" || currentEnd === previousEnd || currentEnd === String(Number.MAX_SAFE_INTEGER)) {
    endOffset.value = String(end);
  }
  lastAutoStartOffset.value = start;
  lastAutoEndOffset.value = end;
}

function parseKafkaRange(throwOnError = true): { startOffset: number; endOffset: number; pageSize: number; partition?: number } | undefined {
  syncKafkaDefaultOffsets();
  const pageSize = normalizedCount();
  const partitionText = String(partition.value).trim();
  const startText = String(offset.value).trim();
  const endText = String(endOffset.value).trim();
  const parsedPartition = partitionText === "" ? undefined : parseNonNegativeSafeInteger(partitionText);
  if (partitionText !== "" && parsedPartition == null) {
    if (throwOnError) throw new Error(t("mqMessages.partitionMustBeNonNegativeInt"));
    return undefined;
  }
  const start = startText === "" ? kafkaDefaultStartOffset() : parseNonNegativeSafeInteger(startText);
  const end = endText === "" ? kafkaDefaultEndOffset() : parseNonNegativeSafeInteger(endText);
  if (start == null) {
    if (throwOnError) throw new Error(t("mqMessages.startOffsetMustBeNonNegativeInt"));
    return undefined;
  }
  if (end == null) {
    if (throwOnError) throw new Error(t("mqMessages.endOffsetMustBeNonNegativeInt"));
    return undefined;
  }
  if (end <= start) {
    if (throwOnError) throw new Error(t("mqMessages.endOffsetMustBeGreaterThanStart"));
    return undefined;
  }
  if (startText === "") {
    offset.value = String(start);
    lastAutoStartOffset.value = start;
  }
  if (endText === "") {
    endOffset.value = String(end);
    lastAutoEndOffset.value = end;
  }
  if (parsedPartition != null) partition.value = String(parsedPartition);
  return { startOffset: start, endOffset: end, pageSize, partition: parsedPartition ?? undefined };
}

function peekGroupName(): string {
  if (props.mqSystemKind === "rocketmq") return "__dbx_rocketmq_viewer__";
  return "__dbx_kafka_viewer__";
}

async function loadMessages() {
  if (isKafka.value) {
    await loadKafkaPage(1);
    return;
  }
  const topic = props.topic;
  if (!topic || loading.value) return;
  const requestVersion = ++messageRequestVersion;
  loading.value = true;
  error.value = undefined;
  incomplete.value = false;
  try {
    const resultLimit = normalizedCount();
    const options: PeekMessagesOptions = {};
    const partitionText = String(partition.value).trim();
    const offsetText = String(offset.value).trim();

    if (isKafka.value) {
      if (partitionText !== "") {
        const parsedPartition = parseNonNegativeSafeInteger(partitionText);
        if (parsedPartition == null) throw new Error(t("mqMessages.partitionMustBeNonNegativeInt"));
        options.partition = parsedPartition;
        partition.value = String(parsedPartition);
      }
    } else {
      if (partitionText !== "") {
        const parsedPartition = parseNonNegativeSafeInteger(partitionText);
        if (parsedPartition == null) throw new Error(t("mqMessages.partitionMustBeNonNegativeInt"));
        options.partition = parsedPartition;
        partition.value = String(parsedPartition);
      }
      if (offsetText !== "") {
        const parsedOffset = parseNonNegativeSafeInteger(offsetText);
        if (parsedOffset == null) throw new Error(t("mqMessages.offsetMustBeNonNegativeInt"));
        options.offset = parsedOffset;
        offset.value = String(parsedOffset);
      }
    }
    const result = await mqPeekMessages(props.connectionId, topic, peekGroupName(), resultLimit, options);
    if (requestVersion === messageRequestVersion) {
      const browseResult = normalizeBrowseResult(result);
      messages.value = isKafka.value ? sortKafkaMessages(browseResult.messages) : browseResult.messages;
      incomplete.value = browseResult.incomplete;
    }
  } catch (cause: unknown) {
    if (requestVersion === messageRequestVersion) {
      error.value = formatError(cause);
    }
  } finally {
    if (requestVersion === messageRequestVersion) {
      loading.value = false;
    }
  }
}

async function loadKafkaPage(page: number) {
  const topic = props.topic;
  if (!topic || loading.value || scanning.value) return;
  const requestVersion = ++messageRequestVersion;
  loading.value = true;
  error.value = undefined;
  incomplete.value = false;
  scanStatus.value = "";
  try {
    const range = parseKafkaRange();
    if (!range) return;
    const pageStart = range.startOffset + (page - 1) * range.pageSize;
    const pageEnd = Math.min(range.endOffset, pageStart + range.pageSize);
    if (pageStart >= range.endOffset) throw new Error(t("mqMessages.pageOutOfRange"));
    scanStatus.value = t("mqMessages.readProgress");
    const result = await fetchKafkaOffsetWindow(pageStart, pageEnd, range);
    if (requestVersion !== messageRequestVersion) return;
    currentPage.value = page;
    messages.value = sortKafkaMessages(result.messages).slice(0, range.pageSize);
    incomplete.value = result.incomplete;
  } catch (cause: unknown) {
    if (requestVersion === messageRequestVersion) error.value = formatError(cause);
  } finally {
    if (requestVersion === messageRequestVersion) {
      loading.value = false;
      scanStatus.value = "";
    }
  }
}

async function fetchKafkaOffsetWindow(start: number, end: number, range: { pageSize: number; partition?: number }) {
  const topic = props.topic;
  if (!topic) return { messages: [], incomplete: false };
  if (useKafkaReadSession.value) {
    if (range.pageSize <= KAFKA_AGENT_MAX_PEEK_COUNT) {
      const result = await mqPeekMessagesRange(props.connectionId, topic, peekGroupName(), range.partition, start, end, range.pageSize);
      return normalizeBrowseResult(result);
    }
    return readKafkaOffsetWindowWithSession(start, end, range);
  }
  const windows: Array<{ start: number; end: number }> = [];
  for (let windowStart = start; windowStart < end; windowStart += KAFKA_AGENT_MAX_PEEK_COUNT) {
    windows.push({
      start: windowStart,
      end: Math.min(end, windowStart + KAFKA_AGENT_MAX_PEEK_COUNT),
    });
  }

  const partitionIds = range.partition != null ? [range.partition] : selectedKafkaPartitions();
  const targets: Array<{ start: number; end: number; partition?: number }> = [];
  for (const window of windows) {
    if (partitionIds.length) {
      for (const partitionId of partitionIds) {
        targets.push({ ...window, partition: partitionId });
      }
    } else {
      targets.push(window);
    }
  }

  const results: Array<{ messages: PeekedMessage[]; incomplete: boolean }> = [];
  for (const window of targets) {
    const batchCount = Math.min(KAFKA_AGENT_MAX_PEEK_COUNT, window.end - window.start);
    const result = await mqPeekMessages(props.connectionId, topic, peekGroupName(), batchCount, {
      startPosition: "offset",
      partition: window.partition,
      offset: window.start,
      endOffset: window.end,
    });
    results.push(normalizeBrowseResult(result));
  }

  const seen = new Set<string>();
  const messages = results
    .flatMap((result) => result.messages)
    .filter((message) => {
      const messageOffsetValue = messageOffset(message);
      if (messageOffsetValue != null && (messageOffsetValue < start || messageOffsetValue >= end)) return false;
      const key = messageKey(message);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    incomplete: results.some((result) => result.incomplete),
    messages,
  };
}

async function readKafkaOffsetWindowWithSession(start: number, end: number, range: { pageSize: number; partition?: number }) {
  const topic = props.topic;
  if (!topic) return { messages: [], incomplete: false };

  let sessionId: string | undefined;
  let remainingCount = range.pageSize;
  const batches: Array<{ messages: PeekedMessage[]; incomplete: boolean }> = [];
  try {
    const requestCount = () => Math.min(KAFKA_AGENT_MAX_PEEK_COUNT, Math.max(1, remainingCount));
    let batch = await mqStartReadSession(props.connectionId, topic, peekGroupName(), range.partition, start, end, requestCount());
    sessionId = batch.sessionId;
    if (!sessionId) throw new Error("Kafka read session did not return a sessionId");
    while (true) {
      batches.push({ messages: batch.messages, incomplete: batch.incomplete });
      remainingCount = Math.max(0, remainingCount - batch.messages.length);
      if (batch.done || remainingCount === 0) break;
      batch = await mqReadSessionNext(props.connectionId, sessionId, requestCount());
    }
  } finally {
    if (sessionId) {
      await mqCloseReadSession(props.connectionId, sessionId).catch(() => undefined);
    }
  }

  const seen = new Set<string>();
  return {
    incomplete: batches.some((batch) => batch.incomplete),
    messages: batches
      .flatMap((batch) => batch.messages)
      .filter((message) => {
        const offsetValue = messageOffset(message);
        if (offsetValue != null && (offsetValue < start || offsetValue >= end)) return false;
        const key = messageKey(message);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
  };
}

function isReadSessionNotFoundError(cause: unknown): boolean {
  return formatError(cause).toLowerCase().includes("read session not found");
}

async function closeActiveReadSession() {
  const sessionId = activeReadSessionId;
  const connectionId = activeReadSessionConnectionId;
  activeReadSessionId = undefined;
  activeReadSessionConnectionId = undefined;
  if (!sessionId || !connectionId) return;
  try {
    await mqCloseReadSession(connectionId, sessionId);
  } catch {
    // The agent may already have reclaimed the session.
  }
}

function sessionSearchMessageMatches(messagesToCheck: PeekedMessage[], query: string): PeekedMessage[] {
  return messagesToCheck.filter((message) => kafkaMessageSearchTextMatches(buildKafkaMessageSearchText(message, formatMessageTimestamp(message.publishTime)), query));
}

async function searchKafkaRangeWithSession(range: { startOffset: number; endOffset: number; pageSize: number; partition?: number }, query: string, requestVersion: number) {
  const topic = props.topic;
  if (!topic) return;

  let resumeOffset = range.startOffset;
  let restartCount = 0;
  while (requestVersion === messageRequestVersion) {
    let sessionId: string | undefined;
    activeReadSessionId = undefined;
    activeReadSessionConnectionId = undefined;
    try {
      const first = await mqStartReadSession(
        props.connectionId,
        topic,
        peekGroupName(),
        range.partition,
        resumeOffset,
        range.endOffset,
        // Range search scans many pages, so use the largest agent batch.
        KAFKA_AGENT_MAX_PEEK_COUNT,
      );
      sessionId = first.sessionId;
      if (!sessionId) throw new Error("Kafka read session did not return a sessionId");
      activeReadSessionId = sessionId;
      activeReadSessionConnectionId = props.connectionId;

      let batch = first;
      while (requestVersion === messageRequestVersion) {
        const batchMessages = batch.messages;
        if (batchMessages.length) {
          const minimumOffset = Math.min(...batchMessages.map((message) => messageOffset(message) ?? resumeOffset));
          resumeOffset = Math.max(range.startOffset, range.startOffset + Math.floor((minimumOffset - range.startOffset) / range.pageSize) * range.pageSize);
        }
        const matches = sessionSearchMessageMatches(batchMessages, query);
        if (matches.length) {
          const matchedOffset = messageOffset(matches[0]) ?? resumeOffset;
          const page = Math.floor((matchedOffset - range.startOffset) / range.pageSize) + 1;
          const pageStart = range.startOffset + (page - 1) * range.pageSize;
          const pageEnd = Math.min(range.endOffset, pageStart + range.pageSize);
          await closeActiveReadSession();
          const pageResult = await fetchKafkaOffsetWindow(pageStart, pageEnd, range);
          currentPage.value = page;
          messages.value = sortKafkaMessages(pageResult.messages).slice(0, range.pageSize);
          incomplete.value = batch.incomplete || pageResult.incomplete;
          scanStatus.value = t("mqMessages.scanMatched", { page });
          return;
        }
        if (batch.done) {
          currentPage.value = 1;
          messages.value = [];
          scanStatus.value = t("mqMessages.scanNoMatch");
          return;
        }
        batch = await mqReadSessionNext(props.connectionId, sessionId, KAFKA_AGENT_MAX_PEEK_COUNT);
      }
      return;
    } catch (cause: unknown) {
      if (requestVersion !== messageRequestVersion) return;
      if (!isReadSessionNotFoundError(cause) || restartCount >= 3) {
        throw cause;
      }
      restartCount += 1;
      await closeActiveReadSession();
      // Restart from the beginning of the current page boundary. This may
      // reread a small amount, but avoids skipping another partition.
      scanStatus.value = t("mqMessages.scanSessionRetry", { attempt: restartCount });
    } finally {
      if (sessionId) await closeActiveReadSession();
    }
  }
}

async function goToPreviousPage() {
  if (canGoPreviousPage.value) await loadKafkaPage(currentPage.value - 1);
}

async function goToNextPage() {
  if (canGoNextPage.value) await loadKafkaPage(currentPage.value + 1);
}

async function searchKafkaRange() {
  const query = normalizedMessageSearchQuery.value;
  if (!query) {
    await loadKafkaPage(1);
    return;
  }
  const topic = props.topic;
  if (!topic || loading.value || scanning.value) return;
  const requestVersion = ++messageRequestVersion;
  scanning.value = true;
  error.value = undefined;
  incomplete.value = false;
  messages.value = [];
  try {
    const range = parseKafkaRange();
    if (!range) return;
    if (useKafkaReadSession.value) {
      await searchKafkaRangeWithSession(range, query, requestVersion);
      return;
    }
    const scanBatchSize = KAFKA_AGENT_MAX_PEEK_COUNT;
    const totalBatches = Math.max(1, Math.ceil((range.endOffset - range.startOffset) / scanBatchSize));
    for (let scanBatch = 1; scanBatch <= totalBatches; scanBatch += 1) {
      if (requestVersion !== messageRequestVersion) return;
      const scanStart = range.startOffset + (scanBatch - 1) * scanBatchSize;
      const scanEnd = Math.min(range.endOffset, scanStart + scanBatchSize);
      scanStatus.value = t("mqMessages.scanProgress", { current: scanBatch, total: totalBatches });
      const result = await fetchKafkaOffsetWindow(scanStart, scanEnd, { ...range, pageSize: scanBatchSize });
      const matches = result.messages.filter((message) => kafkaMessageSearchTextMatches(buildKafkaMessageSearchText(message, formatMessageTimestamp(message.publishTime)), query));
      if (matches.length) {
        const matchedOffset = messageOffset(matches[0]) ?? scanStart;
        const page = Math.floor((matchedOffset - range.startOffset) / range.pageSize) + 1;
        const pageStart = range.startOffset + (page - 1) * range.pageSize;
        const pageEnd = Math.min(range.endOffset, pageStart + range.pageSize);
        const pageResult = await fetchKafkaOffsetWindow(pageStart, pageEnd, range);
        currentPage.value = page;
        messages.value = sortKafkaMessages(pageResult.messages).slice(0, range.pageSize);
        incomplete.value = result.incomplete || pageResult.incomplete;
        scanStatus.value = t("mqMessages.scanMatched", { page });
        return;
      }
    }
    currentPage.value = 1;
    messages.value = [];
    scanStatus.value = t("mqMessages.scanNoMatch");
  } catch (cause: unknown) {
    if (requestVersion === messageRequestVersion) error.value = formatError(cause);
  } finally {
    if (requestVersion === messageRequestVersion) scanning.value = false;
  }
}

function invalidateMessageRequest() {
  messageRequestVersion += 1;
  loading.value = false;
  error.value = undefined;
  messages.value = [];
  incomplete.value = false;
  scanStatus.value = "";
  currentPage.value = 1;
  scanning.value = false;
}

function messagePayload(message: PeekedMessage): string {
  return message.payloadText ?? message.payloadBase64;
}

async function copyMessagePayload(message: PeekedMessage) {
  await copyMessageText(messagePayload(message));
}

async function copyMessageHeaders(message: PeekedMessage) {
  await copyMessageText(JSON.stringify(message.headers, null, 2));
}

async function copyMessageText(text: string) {
  try {
    await copyToClipboard(text);
    toast(t("grid.copied"));
  } catch (cause: unknown) {
    toast(t("grid.copyFailed", { message: formatError(cause) }), 5000);
  }
}

function formatMessageTimestamp(value?: string): string {
  if (!value) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Date(numeric).toLocaleString();
}

watch([() => props.connectionId, () => props.mqSystemKind], () => {
  void closeActiveReadSession();
  messageSearchQuery.value = "";
  invalidateMessageRequest();
});

watch(
  () => JSON.stringify(props.topic ?? null),
  () => {
    void closeActiveReadSession();
    partition.value = "";
    offset.value = "";
    endOffset.value = "";
    lastAutoStartOffset.value = undefined;
    lastAutoEndOffset.value = undefined;
    messageSearchQuery.value = "";
    invalidateMessageRequest();
  },
);

watch([() => JSON.stringify(props.kafkaPartitions ?? []), () => JSON.stringify(props.kafkaPartitionRanges ?? []), partition], () => syncKafkaDefaultOffsets(), { immediate: true });

watch(pageSizePreset, (value) => {
  if (value !== "custom") count.value = Number(value);
});

watch(
  () => settingsStore.editorSettings.kafkaUseReadSession,
  () => {
    void closeActiveReadSession();
    invalidateMessageRequest();
  },
);

onUnmounted(() => {
  void closeActiveReadSession();
});
</script>

<template>
  <section v-if="topic" class="message-browser" :class="{ 'is-monitoring': isMonitoring }" data-testid="message-browser">
    <div class="message-browser-header">
      <h4>{{ t("mqMessages.messageList") }}</h4>
      <button type="button" class="btn-sm" :disabled="loading || scanning" @click="loadMessages">
        {{ loading ? t("mqMessages.loading") : t("mqMessages.loadMessages") }}
      </button>
    </div>

    <p v-if="isKafka" class="peek-default-hint">{{ t("mqMessages.kafkaOffsetRangeHint") }}</p>
    <p v-else class="peek-default-hint">{{ t("mqMessages.peekDefaultHint") }}</p>
    <p v-if="incomplete" class="peek-incomplete" role="status" data-testid="peek-incomplete">
      {{ t("mqMessages.peekIncomplete") }}
    </p>

    <div class="peek-controls">
      <label>
        <span>{{ isKafka ? t("mqMessages.pageSize") : t("mqMessages.count") }}</span>
        <select v-if="isKafka" v-model="pageSizePreset" class="message-browser-page-size" data-testid="peek-page-size-preset" :disabled="loading || scanning">
          <option value="100">100</option>
          <option value="500">500</option>
          <option value="1000">1000</option>
          <option value="custom">{{ t("mqMessages.customPageSize") }}</option>
        </select>
        <input v-if="!isKafka || pageSizePreset === 'custom'" v-model.number="count" data-testid="peek-count" type="number" min="1" :max="isKafka ? 10000 : 100" :disabled="loading || scanning" />
      </label>
      <label v-if="isKafka">
        <span>{{ t("mqMessages.startOffset") }}</span>
        <input v-model="offset" data-testid="kafka-peek-offset" type="number" min="0" :placeholder="t('mqMessages.offsetPlaceholderEarliest')" :disabled="loading || scanning" />
      </label>
      <label v-if="isKafka">
        <span>{{ t("mqMessages.endOffset") }}</span>
        <input v-model="endOffset" data-testid="kafka-peek-end-offset" type="number" min="0" :placeholder="t('mqMessages.endOffsetPlaceholder')" :disabled="loading || scanning" />
      </label>
      <label v-if="isKafka">
        <span>{{ t("mqMessages.partition") }}</span>
        <input v-model="partition" data-testid="kafka-peek-partition" type="number" min="0" :placeholder="t('mqMessages.partitionPlaceholderAll')" :disabled="loading || scanning" />
      </label>
    </div>

    <template v-if="!isKafka">
      <button type="button" class="collapse-toggle peek-advanced-toggle" @click="advancedExpanded = !advancedExpanded">
        <span class="collapse-arrow" :class="{ expanded: advancedExpanded }">&#9654;</span>
        <span>{{ t("mqMessages.advancedFilter") }}</span>
        <span v-if="(partition || offset) && !advancedExpanded" class="collapse-badge">&middot;</span>
      </button>
      <div v-if="advancedExpanded" class="peek-controls non-kafka-controls">
        <label>
          <span>{{ t("mqMessages.partition") }}</span>
          <input v-model="partition" type="number" min="0" :placeholder="t('mqMessages.partitionPlaceholderAll')" :disabled="loading" />
        </label>
        <label>
          <span>{{ t("mqMessages.offset") }}</span>
          <input v-model="offset" type="number" min="0" :placeholder="t('mqMessages.offsetPlaceholderEarliest')" :disabled="loading" />
        </label>
      </div>
    </template>

    <div v-if="isKafka" class="message-filter-row" data-testid="kafka-message-filter">
      <MqSearchInput v-model="messageSearchQuery" :placeholder="t('mqMessages.filterRangePlaceholder')" :aria-label="t('mqMessages.filterRangePlaceholder')" :disabled="loading || scanning" data-testid="kafka-message-filter-input" />
      <button type="button" class="btn-sm" data-testid="kafka-scan-range" :disabled="loading || scanning" @click="searchKafkaRange">
        {{ scanning ? t("mqMessages.scanning") : t("mqMessages.scanRange") }}
      </button>
      <span class="mq-result-count" data-testid="kafka-message-filter-count" aria-live="polite">
        {{ scanStatus || t("mqMessages.filterLoadedCount", { matched: filteredMessages.length, loaded: messages.length }) }}
      </span>
    </div>

    <div v-if="error" class="panel-error">{{ error }}</div>
    <div v-else-if="loading || scanning" class="message-empty">{{ scanStatus || (scanning ? t("mqMessages.scanning") : t("mqMessages.messagesLoading")) }}</div>
    <div v-else-if="!displayMessages.length && normalizedMessageSearchQuery" class="message-empty" data-testid="kafka-message-filter-empty">{{ t("mqMessages.noMatchingMessages") }}</div>
    <div v-else-if="!messages.length" class="message-empty">{{ t("mqMessages.noMessages") }}</div>
    <div v-else-if="!displayMessages.length" class="message-empty" data-testid="kafka-message-filter-empty">{{ t("mqMessages.noMatchingMessages") }}</div>
    <div v-else class="message-list">
      <article v-for="message in displayMessages" :key="`${message.properties?.partition ?? 'p'}-${message.messageId || message.position}`" class="message-row">
        <div class="message-meta">
          <span>#{{ message.position }}</span>
          <span v-if="message.properties?.partition != null">{{ t("mqMessages.metaPartition", { partition: message.properties.partition }) }}</span>
          <span>{{ t("mqMessages.metaOffset", { offset: message.messageId || "-" }) }}</span>
          <span v-if="message.key">{{ t("mqMessages.metaKey", { key: message.key }) }}</span>
          <span>{{ formatMessageTimestamp(message.publishTime) }}</span>
        </div>
        <div class="message-payload-section">
          <div class="message-payload-heading">
            <span>{{ t("mqMessages.messageContent") }}</span>
            <Button type="button" variant="outline" size="sm" class="message-copy-action h-7 gap-1.5 px-2 text-xs" :aria-label="`${t('grid.copy')} ${t('mqMessages.messageContent')}`" data-testid="copy-message-payload" @click="copyMessagePayload(message)">
              <Copy :size="14" aria-hidden="true" />
              {{ t("grid.copy") }}
            </Button>
          </div>
          <pre data-native-clipboard class="message-payload">{{ messagePayload(message) }}</pre>
        </div>
        <div v-if="Object.keys(message.headers || {}).length" class="message-headers">
          <div class="message-headers-heading">
            <span>{{ t("mqMessages.messageHeaders") }}</span>
            <Button type="button" variant="outline" size="sm" class="message-copy-action h-7 gap-1.5 px-2 text-xs" :aria-label="`${t('grid.copy')} ${t('mqMessages.messageHeaders')}`" data-testid="copy-message-headers" @click="copyMessageHeaders(message)">
              <Copy :size="14" aria-hidden="true" />
              {{ t("grid.copy") }}
            </Button>
          </div>
          <div class="message-headers-values">
            <span v-for="(value, key) in message.headers" :key="key">{{ key }}: {{ value }}</span>
          </div>
        </div>
      </article>
    </div>
    <div v-if="isKafka" class="message-list-actions">
      <button type="button" class="btn-sm" data-testid="previous-page-messages" :disabled="!canGoPreviousPage" @click="goToPreviousPage">
        {{ t("mqMessages.previousPage") }}
      </button>
      <span class="mq-result-count" data-testid="kafka-current-page">{{ t("mqMessages.currentPage", { page: currentPage }) }}</span>
      <button type="button" class="btn-sm" data-testid="next-page-messages" :disabled="!canGoNextPage" @click="goToNextPage">
        {{ t("mqMessages.nextPage") }}
      </button>
      <span v-if="currentRange" class="mq-result-count">
        {{ t("mqMessages.currentOffsetRange", { start: currentRange.pageStart, end: currentRange.pageEnd }) }}
      </span>
    </div>
  </section>
</template>

<style scoped>
@import "./shared/mqPanel.css";

.message-browser {
  margin-top: 4px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background-secondary);
}

/* Only flatten outer chrome when embedded in MonitoringPanel — do not restyle list rows. */
.message-browser.is-monitoring {
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.message-browser-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.message-browser-header h4 {
  margin: 0;
  color: var(--color-text);
  font-size: 14px;
  font-weight: 600;
}

.btn-sm:disabled,
.peek-controls input:disabled,
.peek-controls :deep(.message-browser-start-position[data-disabled]) {
  opacity: 0.5;
  cursor: not-allowed;
}

.peek-default-hint {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: var(--dbx-radius-fixed-6);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.peek-incomplete {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid var(--color-warning-border, #d99a22);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-warning-background, #fff6df);
  color: var(--color-warning-text, #7a4a00);
  font-size: 12px;
}

.peek-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.peek-controls label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.peek-controls input,
.peek-controls :deep(.message-browser-start-position) {
  height: 32px;
  width: 100%;
  padding: 7px 10px;
  box-sizing: border-box;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.peek-controls input:focus,
.peek-controls :deep(.message-browser-start-position:focus-visible) {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.non-kafka-controls {
  margin-top: 6px;
}

.message-filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.message-filter-row :deep(.mq-search-input) {
  width: min(420px, 100%);
  flex: 1;
}

.message-list-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 12px;
}

.message-list-actions .mq-result-count {
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.collapse-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}

.peek-advanced-toggle {
  margin-bottom: 10px;
}

.collapse-arrow {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.15s;
}

.collapse-arrow.expanded {
  transform: rotate(90deg);
}

.collapse-badge {
  color: var(--color-primary);
  font-weight: 700;
}

.panel-error {
  padding: 10px 14px;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 13px;
}

.message-empty {
  padding: 18px;
  border: 1px dashed var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  color: var(--color-text-tertiary);
  text-align: center;
  font-size: 13px;
}

.message-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 360px;
  overflow: auto;
}

/* Monitoring page already scrolls via .stats-container — avoid a second vertical bar. */
.message-browser.is-monitoring .message-list {
  max-height: none;
  overflow: visible;
}

.message-row {
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.message-meta span:first-child {
  color: var(--color-primary);
  font-weight: 700;
}

.message-copy-action {
  flex-shrink: 0;
}

.message-payload-section,
.message-headers {
  margin-top: 8px;
}

.message-payload-heading,
.message-headers-heading,
.message-headers-values {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.message-payload-heading,
.message-headers-heading {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.message-payload-heading .message-copy-action,
.message-headers-heading .message-copy-action {
  margin-left: auto;
}

.message-payload {
  margin: 6px 0 0;
  padding: 10px;
  max-height: 160px;
  overflow: auto;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background-tertiary, var(--color-background-secondary));
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-headers-heading {
  margin-bottom: 6px;
}

.message-headers-values span {
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  color: var(--color-text-secondary);
  background: var(--color-background-secondary);
  font-size: 12px;
}

@media (max-width: 720px) {
  .peek-controls {
    grid-template-columns: 1fr;
  }
}
</style>
