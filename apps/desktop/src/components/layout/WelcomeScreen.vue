<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { FilePlus2, Plus, History, Download, Database, Search, ShieldCheck, Sparkles, Keyboard } from "@lucide/vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import TruncatedTextTooltip from "@/components/ui/TruncatedTextTooltip.vue";
import { connectionDriverLabel, connectionIconType, connectionRedactedNameLabel, connectionRedactedOptionSubtitle } from "@/lib/connection/connectionPresentation";
import { shortcutDisplayStrokes, shortcutKeyLabel } from "@/lib/editor/shortcutDisplay";
import { normalizeShortcutSettings, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";
import type { ConnectionConfig } from "@/types/database";

export interface WelcomeSavedSqlHistoryItem {
  id: string;
  name: string;
  connectionName: string;
  database?: string;
  folderName?: string;
  openCount?: number;
}

interface WelcomeShortcutRow {
  id: string;
  title: string;
  description: string;
  shortcuts: Array<{ id: string; strokes: string[][] }>;
}

const props = defineProps<{
  connectionStats: { total: number; connected: number; types: number };
  recentConnections: ConnectionConfig[];
  savedSqlHistoryItems: WelcomeSavedSqlHistoryItem[];
  appVersion: string;
  hasConnections: boolean;
  shortcuts: Partial<ShortcutSettings>;
}>();

const emit = defineEmits<{
  "open-connection-query": [connectionId: string];
  "open-saved-sql": [fileId: string];
  "new-connection": [];
  "new-query": [];
  "show-history": [];
  "import-config": [];
  "open-github": [];
  "open-mcp-guide": [];
}>();

const { t } = useI18n();
const normalizedShortcuts = computed(() => normalizeShortcutSettings(props.shortcuts));

const shortcutRows = computed<WelcomeShortcutRow[]>(() => [
  {
    id: "quick-open",
    title: t("welcome.shortcutQuickOpen"),
    description: t("welcome.shortcutQuickOpenDescription"),
    shortcuts: [
      { id: "double-shift", strokes: shortcutStrokeLabels("Shift Shift") },
      { id: normalizedShortcuts.value.quickOpen, strokes: shortcutStrokeLabels(normalizedShortcuts.value.quickOpen) },
    ],
  },
  {
    id: "quick-open-category",
    title: t("welcome.shortcutQuickOpenCategory"),
    description: t("welcome.shortcutQuickOpenCategoryDescription"),
    shortcuts: [
      { id: "Tab", strokes: shortcutStrokeLabels("Tab") },
      { id: "Shift+Tab", strokes: shortcutStrokeLabels("Shift+Tab") },
    ],
  },
  {
    id: "new-query",
    title: t("welcome.shortcutNewQuery"),
    description: t("welcome.shortcutNewQueryDescription"),
    shortcuts: [{ id: normalizedShortcuts.value.newQuery, strokes: shortcutStrokeLabels(normalizedShortcuts.value.newQuery) }],
  },
  {
    id: "execute-sql",
    title: t("welcome.shortcutExecuteSql"),
    description: t("welcome.shortcutExecuteSqlDescription"),
    shortcuts: [{ id: normalizedShortcuts.value.executeSql, strokes: shortcutStrokeLabels(normalizedShortcuts.value.executeSql) }],
  },
  {
    id: "focus-table-where",
    title: t("welcome.shortcutFocusTableWhere"),
    description: t("welcome.shortcutFocusTableWhereDescription"),
    shortcuts: [{ id: normalizedShortcuts.value.focusTableWhere, strokes: shortcutStrokeLabels(normalizedShortcuts.value.focusTableWhere) }],
  },
  {
    id: "switch-tab",
    title: t("welcome.shortcutSwitchTab"),
    description: t("welcome.shortcutSwitchTabDescription"),
    shortcuts: [
      { id: normalizedShortcuts.value.switchToPreviousTab, strokes: shortcutStrokeLabels(normalizedShortcuts.value.switchToPreviousTab) },
      { id: normalizedShortcuts.value.switchToNextTab, strokes: shortcutStrokeLabels(normalizedShortcuts.value.switchToNextTab) },
    ],
  },
  {
    id: "open-settings",
    title: t("welcome.shortcutOpenSettings"),
    description: t("welcome.shortcutOpenSettingsDescription"),
    shortcuts: [{ id: normalizedShortcuts.value.openSettings, strokes: shortcutStrokeLabels(normalizedShortcuts.value.openSettings) }],
  },
]);

function welcomeConnectionSubtitle(connection: ConnectionConfig): string {
  return connectionRedactedOptionSubtitle(connection) || connectionDriverLabel(connection);
}

function shortcutStrokeLabels(shortcut: string): string[][] {
  return shortcutDisplayStrokes(shortcut).map((stroke) => stroke.map((part) => shortcutKeyLabel(part)));
}
</script>

<template>
  <div class="min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-background">
    <div class="welcome-content mx-auto flex min-h-full w-full min-w-0 max-w-5xl flex-col justify-center gap-6 px-8 py-10">
      <div class="welcome-stats-grid grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="min-w-0 overflow-hidden rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <Database class="h-3.5 w-3.5 shrink-0" /> <span class="min-w-0 truncate">{{ t("welcome.connections") }}</span>
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.total }}</div>
        </div>
        <div class="min-w-0 overflow-hidden rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck class="h-3.5 w-3.5 shrink-0" /> <span class="min-w-0 truncate">{{ t("welcome.connected") }}</span>
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.connected }}</div>
        </div>
        <div class="min-w-0 overflow-hidden rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <Sparkles class="h-3.5 w-3.5 shrink-0" /> <span class="min-w-0 truncate">{{ t("welcome.databaseTypes") }}</span>
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.types }}</div>
        </div>
      </div>

      <div class="welcome-main-grid grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div class="min-w-0 overflow-hidden rounded-lg border">
          <div class="flex items-center justify-between border-b px-4 py-3">
            <div class="text-sm font-medium">{{ t("welcome.quickConnections") }}</div>
          </div>
          <div class="divide-y">
            <button v-for="connection in recentConnections" :key="connection.id" class="flex w-full min-w-0 items-center gap-3 overflow-hidden px-4 py-3 text-left hover:bg-muted/40" @click="emit('open-connection-query', connection.id)">
              <DatabaseIcon :db-type="connectionIconType(connection)" class="h-4 w-4 shrink-0" />
              <span class="h-5 w-1 rounded-full shrink-0" :style="{ backgroundColor: connection.color || '#9ca3af' }" />
              <div class="min-w-0 flex-1">
                <TruncatedTextTooltip :text="connectionRedactedNameLabel(connection)" class="block text-sm font-medium" />
                <TruncatedTextTooltip :text="welcomeConnectionSubtitle(connection)" class="block text-xs text-muted-foreground" tooltip-class="max-w-[min(42rem,calc(100vw-2rem))] whitespace-pre-wrap break-all px-3 py-2 text-left leading-5" />
              </div>
              <FilePlus2 class="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
            <div v-if="recentConnections.length === 0" class="px-4 py-8 text-sm text-muted-foreground">
              {{ t("sidebar.noConnections") }}
            </div>
          </div>
        </div>

        <div class="min-w-0 overflow-hidden rounded-lg border">
          <div class="border-b px-4 py-3">
            <div class="text-sm font-medium">{{ t("welcome.actions") }}</div>
          </div>
          <div class="grid min-w-0 gap-1 p-2">
            <button class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('new-connection')">
              <Plus class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("toolbar.newConnection") }}</span>
            </button>
            <button class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" :disabled="!hasConnections" @click="emit('new-query')">
              <FilePlus2 class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("toolbar.newQuery") }}</span>
            </button>
            <button class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('show-history')">
              <History class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("history.title") }}</span>
            </button>
            <button class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('import-config')">
              <Download class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("sidebar.import") }}</span>
            </button>
            <div class="mt-2 min-w-0 overflow-hidden rounded-md bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
              <Search class="mr-1 inline h-3.5 w-3.5 shrink-0" />
              {{ t("welcome.tip") }}
            </div>
          </div>
        </div>
      </div>

      <div class="min-w-0 overflow-hidden rounded-lg border">
        <div class="flex items-center justify-between border-b px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Keyboard class="h-4 w-4 shrink-0" />
            <span class="min-w-0 truncate">{{ t("welcome.keyboardShortcuts") }}</span>
          </div>
          <div class="text-xs text-muted-foreground">{{ t("welcome.keyboardShortcutsHint") }}</div>
        </div>
        <div class="grid gap-1 p-2">
          <div v-for="row in shortcutRows" :key="row.id" class="flex min-w-0 flex-col gap-3 rounded-md px-3 py-3 transition-colors hover:bg-muted/30 md:flex-row md:items-center md:justify-between">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">{{ row.title }}</div>
              <div class="mt-1 text-xs leading-5 text-muted-foreground">{{ row.description }}</div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              <div v-for="shortcut in row.shortcuts" :key="shortcut.id" class="flex items-center gap-2">
                <div class="flex items-center gap-1.5">
                  <template v-for="(stroke, strokeIndex) in shortcut.strokes" :key="`${shortcut.id}-${strokeIndex}`">
                    <div class="flex items-center gap-1">
                      <kbd v-for="(keyLabel, keyIndex) in stroke" :key="`${shortcut.id}-${strokeIndex}-${keyIndex}`" class="inline-flex min-h-7 min-w-7 items-center justify-center rounded-md border border-border/70 bg-muted/40 px-2 text-[11px] font-medium text-foreground shadow-sm">
                        {{ keyLabel }}
                      </kbd>
                    </div>
                    <span v-if="strokeIndex < shortcut.strokes.length - 1" class="text-xs text-muted-foreground">{{ t("welcome.shortcutThen") }}</span>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="min-w-0 overflow-hidden rounded-lg border">
        <div class="flex items-center justify-between border-b px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-sm font-medium">
            <History class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("welcome.sqlHistory") }}</span>
          </div>
        </div>
        <div class="divide-y">
          <button v-for="item in savedSqlHistoryItems" :key="item.id" class="flex w-full min-w-0 items-center gap-3 overflow-hidden px-4 py-3 text-left hover:bg-muted/40" @click="emit('open-saved-sql', item.id)">
            <History class="h-4 w-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ item.name }}</div>
              <div class="truncate text-xs text-muted-foreground">
                <span>{{ item.connectionName }}</span>
                <span v-if="item.database"> · {{ item.database }}</span>
                <span v-if="item.folderName"> · {{ item.folderName }}</span>
                <span v-if="item.openCount"> · {{ t("welcome.sqlHistoryOpenCount", { count: item.openCount }) }}</span>
              </div>
            </div>
            <FilePlus2 class="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <div v-if="savedSqlHistoryItems.length === 0" class="px-4 py-8 text-sm text-muted-foreground">
            {{ t("welcome.sqlHistoryEmpty") }}
          </div>
        </div>
      </div>

      <!-- MCP Integration Hint -->
      <div class="min-w-0 overflow-hidden rounded-lg border bg-muted/10 px-5 py-4">
        <div class="flex min-w-0 items-start gap-3">
          <Sparkles class="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ t("welcome.mcpTitle") }}</div>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">
              {{ t("welcome.mcpDescription") }}
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <code class="max-w-full break-all rounded bg-muted px-2 py-0.5 text-[11px] select-all">npx @dbx-app/mcp-server</code>
              <a href="#" class="text-xs text-primary hover:underline" @click.prevent="emit('open-mcp-guide')">{{ t("welcome.mcpLearnMore") }}</a>
            </div>
          </div>
        </div>
      </div>

      <!-- Project Info -->
      <div class="mt-2 flex items-center justify-center gap-3 text-[11px] text-muted-foreground/60">
        <span>DBX {{ appVersion ? "v" + appVersion : "" }}</span>
        <span>·</span>
        <a href="#" class="hover:text-foreground transition-colors" @click.prevent="emit('open-github')">GitHub</a>
      </div>
    </div>
  </div>
</template>

<style>
.welcome-content {
  max-width: 64rem;
}

@media (min-width: 640px) {
  .welcome-stats-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
  }
}

@media (min-width: 1024px) {
  .welcome-main-grid {
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr) !important;
  }
}
</style>
