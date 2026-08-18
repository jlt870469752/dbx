<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, Command, Database, FileCode, FileText } from "@lucide/vue";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useQuickOpen, type QuickOpenCategory, type QuickOpenDatabaseScope, type QuickOpenItem } from "@/composables/useQuickOpen";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  select: [item: QuickOpenItem];
}>();

const { t } = useI18n();
const { searchQuery, selectedCategory, databaseScope, connectionOptions, filteredItems, selectedIndex, selectedItem, selectNext, selectPrevious, resetSelection, loadExternalSqlFiles, recordActionUsage } = useQuickOpen();
const inputRef = ref<HTMLInputElement | null>(null);
const resultsListRef = ref<HTMLElement | null>(null);

const categories: Array<{ id: QuickOpenCategory; labelKey: string }> = [
  { id: "all", labelKey: "quickOpen.categoryAll" },
  { id: "database", labelKey: "quickOpen.categoryDatabase" },
  { id: "action", labelKey: "quickOpen.categoryAction" },
  { id: "file", labelKey: "quickOpen.categoryFile" },
  { id: "code", labelKey: "quickOpen.categoryCode" },
];

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

function searchInputElement(): HTMLInputElement | null {
  if (inputRef.value instanceof HTMLInputElement) return inputRef.value;
  const element = (inputRef.value as { $el?: HTMLInputElement | null } | null)?.$el;
  return element instanceof HTMLInputElement ? element : null;
}

function focusSearchInput(): void {
  nextTick(() => {
    requestAnimationFrame(() => {
      searchInputElement()?.focus({ preventScroll: true });
    });
  });
}

function handleOpenAutoFocus(e: Event): void {
  e.preventDefault();
  focusSearchInput();
}

function handleDatabaseScopeCloseAutoFocus(e: Event): void {
  e.preventDefault();
  focusSearchInput();
}

function scrollSelectedItemIntoView(): void {
  nextTick(() => {
    resultsListRef.value?.querySelector<HTMLElement>(`[data-quick-open-index="${selectedIndex.value}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectNext();
    scrollSelectedItemIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectPrevious();
    scrollSelectedItemIntoView();
  } else if (e.key === "Tab") {
    e.preventDefault();
    const currentIndex = categories.findIndex((category) => category.id === selectedCategory.value);
    const direction = e.shiftKey ? -1 : 1;
    const nextIndex = (currentIndex + direction + categories.length) % categories.length;
    setCategory(categories[nextIndex]?.id ?? "all");
  } else if (e.key === "Enter" && selectedItem.value) {
    e.preventDefault();
    handleSelect(selectedItem.value);
  } else if (e.key === "Escape") {
    e.preventDefault();
    dialogOpen.value = false;
  }
}

function handleSelect(item: QuickOpenItem): void {
  if (item.type === "action" && item.actionId) recordActionUsage(item.actionId);
  emit("select", item);
  dialogOpen.value = false;
}

function setCategory(category: QuickOpenCategory): void {
  selectedCategory.value = category;
  selectedIndex.value = 0;
  if (category === "file") void loadExternalSqlFiles();
  focusSearchInput();
}

function setDatabaseScope(scope: QuickOpenDatabaseScope): void {
  databaseScope.value = scope;
  selectedIndex.value = 0;
  focusSearchInput();
}

function databaseScopeLabel(): string {
  if (databaseScope.value === "context") return t("quickOpen.scopeContext");
  if (databaseScope.value === "connected") return t("quickOpen.scopeConnected");
  if (databaseScope.value === "all") return t("quickOpen.scopeAll");
  const connectionId = databaseScope.value.slice("connection:".length);
  return connectionOptions.value.find((option) => option.id === connectionId)?.name ?? t("quickOpen.scopeAll");
}

function scopeConnectionValue(connectionId: string): QuickOpenDatabaseScope {
  return `connection:${connectionId}`;
}

function isSelectedDatabaseScope(scope: QuickOpenDatabaseScope): boolean {
  return databaseScope.value === scope;
}

function getHighlightedLabel(item: any): (string | { text: string; highlight: boolean })[] {
  if (!searchQuery.value.trim() || !item.matchIndices) {
    return [item.label];
  }

  const indices = new Set(item.matchIndices);
  const parts: (string | { text: string; highlight: boolean })[] = [];
  let current = "";
  let isHighlighting = false;

  for (let i = 0; i < item.label.length; i++) {
    const char = item.label[i];
    const shouldHighlight = indices.has(i);

    if (shouldHighlight !== isHighlighting) {
      if (current) {
        parts.push({
          text: current,
          highlight: isHighlighting,
        });
      }
      current = char;
      isHighlighting = shouldHighlight;
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push({
      text: current,
      highlight: isHighlighting,
    });
  }

  return parts;
}

function getTypeLabel(type: string): string {
  switch (type) {
    case "connection":
      return t("common.connection");
    case "database":
      return t("common.database");
    case "schema":
      return t("common.schema");
    case "table":
      return t("common.table");
    case "view":
      return t("common.view");
    case "materialized_view":
      return t("common.materializedView");
    case "procedure":
      return t("common.procedure");
    case "function":
      return t("common.function");
    case "sequence":
      return t("common.sequence");
    case "package":
      return t("common.package");
    case "package-body":
      return t("common.packageBody");
    case "sql_file":
      return t("quickOpen.sqlFile");
    case "sql_library_file":
      return t("quickOpen.sqlLibraryFile");
    case "action":
      return t("quickOpen.categoryAction");
    default:
      return type;
  }
}

function getItemIcon(type: string) {
  if (type === "sql_file") return FileCode;
  if (type === "sql_library_file") return FileText;
  if (type === "action") return Command;
  return null;
}

watch(
  () => props.open,
  (newOpen) => {
    if (newOpen) {
      resetSelection();
      // Eagerly load external SQL files so they appear in the initial list
      void loadExternalSqlFiles();
      focusSearchInput();
    }
  },
);
</script>

<template>
  <Dialog :open="dialogOpen" @update:open="dialogOpen = $event">
    <DialogContent portalClass="items-start justify-items-center pt-14 sm:pt-20" class="max-w-3xl p-0 gap-0 rounded-lg overflow-hidden" @open-auto-focus="handleOpenAutoFocus">
      <div class="flex flex-col bg-background">
        <!-- Category Tabs -->
        <div class="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
          <div class="flex min-w-0 items-center gap-1 overflow-x-auto">
            <button
              v-for="category in categories"
              :key="category.id"
              type="button"
              tabindex="-1"
              :class="['shrink-0 rounded-md px-2.5 py-1 text-sm transition-colors', selectedCategory === category.id ? 'border border-primary/40 bg-primary/10 text-primary shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground']"
              @click="setCategory(category.id)"
            >
              {{ t(category.labelKey) }}
            </button>
          </div>
          <DropdownMenu v-if="selectedCategory === 'database'">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" class="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground">
                <Database class="h-3.5 w-3.5" />
                <span class="max-w-40 truncate">{{ databaseScopeLabel() }}</span>
                <ChevronDown class="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-64" @close-auto-focus="handleDatabaseScopeCloseAutoFocus">
              <DropdownMenuLabel>{{ t("quickOpen.databaseScope") }}</DropdownMenuLabel>
              <DropdownMenuItem @click="setDatabaseScope('context')">
                <Check :class="['h-4 w-4', isSelectedDatabaseScope('context') ? 'opacity-100' : 'opacity-0']" />
                <span>{{ t("quickOpen.scopeContext") }}</span>
              </DropdownMenuItem>
              <DropdownMenuItem @click="setDatabaseScope('connected')">
                <Check :class="['h-4 w-4', isSelectedDatabaseScope('connected') ? 'opacity-100' : 'opacity-0']" />
                <span>{{ t("quickOpen.scopeConnected") }}</span>
              </DropdownMenuItem>
              <DropdownMenuItem @click="setDatabaseScope('all')">
                <Check :class="['h-4 w-4', isSelectedDatabaseScope('all') ? 'opacity-100' : 'opacity-0']" />
                <span>{{ t("quickOpen.scopeAll") }}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator v-if="connectionOptions.length > 0" />
              <DropdownMenuItem v-for="connection in connectionOptions" :key="connection.id" @click="setDatabaseScope(scopeConnectionValue(connection.id))">
                <Check :class="['h-4 w-4', isSelectedDatabaseScope(scopeConnectionValue(connection.id)) ? 'opacity-100' : 'opacity-0']" />
                <span class="min-w-0 flex-1 truncate">{{ connection.name }}</span>
                <span v-if="connection.connected" class="h-1.5 w-1.5 rounded-full bg-emerald-500" :title="t('quickOpen.connected')" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!-- Search Input -->
        <div class="flex items-center gap-3 px-4 py-3 border-b">
          <Command class="h-5 w-5 text-muted-foreground" />
          <Input ref="inputRef" v-model="searchQuery" type="text" :placeholder="t('quickOpen.placeholder')" class="flex-1 border-0 bg-transparent p-0 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:outline-none" @keydown="handleKeyDown" />
        </div>

        <!-- Results List -->
        <div ref="resultsListRef" class="max-h-[400px] overflow-y-auto">
          <div v-if="filteredItems.length === 0" class="px-4 py-8 text-center text-muted-foreground">
            <p v-if="!searchQuery.trim()">{{ t("quickOpen.emptyPlaceholder") }}</p>
            <p v-else>{{ t("quickOpen.noResults") }}</p>
          </div>

          <div v-else class="divide-y">
            <div v-for="(item, index) in filteredItems" :key="item.id" :data-quick-open-index="index" :class="['px-4 py-2 cursor-pointer', index === selectedIndex ? 'bg-accent' : 'hover:bg-muted']" @click="handleSelect(item)" @mouseenter="selectedIndex = index">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <component v-if="getItemIcon(item.type)" :is="getItemIcon(item.type)" class="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium truncate">
                      <template v-for="(part, i) in getHighlightedLabel(item)" :key="i">
                        <span v-if="typeof part === 'object'" :class="{ 'bg-yellow-200 dark:bg-yellow-800 font-semibold': part.highlight }">
                          {{ part.text }}
                        </span>
                        <span v-else>{{ part }}</span>
                      </template>
                    </div>
                    <div v-if="item.description" class="text-xs text-muted-foreground truncate">
                      {{ item.description }}
                    </div>
                  </div>
                </div>
                <div class="text-xs px-2 py-1 rounded bg-muted text-muted-foreground whitespace-nowrap">
                  {{ getTypeLabel(item.type) }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-4 py-2 border-t text-xs text-muted-foreground flex justify-between">
          <div>{{ filteredItems.length }} {{ t("quickOpen.results") }}</div>
          <div class="flex gap-4">
            <span><kbd class="px-2 py-1 rounded bg-muted">↑↓</kbd> {{ t("quickOpen.navigate") }}</span>
            <span><kbd class="px-2 py-1 rounded bg-muted">⏎</kbd> {{ t("quickOpen.select") }}</span>
            <span><kbd class="px-2 py-1 rounded bg-muted">ESC</kbd> {{ t("quickOpen.close") }}</span>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:deep([data-slot="dialog-content"]) {
  border-color: color-mix(in srgb, var(--border) 80%, var(--ring));
  box-shadow: 0 24px 70px rgb(0 0 0 / 0.32);
}

:deep(.divide-y > div.bg-accent) {
  background-color: var(--info-bg) !important;
  box-shadow: inset 3px 0 0 var(--info) !important;
}

:deep(.bg-yellow-200),
:deep(.dark .bg-yellow-800) {
  background-color: var(--warning-bg) !important;
  border-radius: 0.1875rem;
  padding: 0 0.0625rem;
}
</style>
