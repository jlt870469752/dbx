import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const quickOpenDialogSource = readFileSync(new URL("../QuickOpenDialog.vue", import.meta.url), "utf8");

describe("QuickOpenDialog theme styles", () => {
  it("keeps the shared corner style, category tabs, and readable foreground text", () => {
    expect(quickOpenDialogSource).toContain('class="max-w-3xl p-0 gap-0 rounded-lg overflow-hidden"');
    expect(quickOpenDialogSource).toContain('portalClass="items-start justify-items-center pt-14 sm:pt-20"');
    expect(quickOpenDialogSource).toContain("quickOpen.categoryDatabase");
    expect(quickOpenDialogSource).toContain("quickOpen.categoryAction");
    expect(quickOpenDialogSource.indexOf("quickOpen.categoryDatabase")).toBeLessThan(quickOpenDialogSource.indexOf("quickOpen.categoryAction"));
    expect(quickOpenDialogSource.indexOf("quickOpen.categoryAction")).toBeLessThan(quickOpenDialogSource.indexOf("quickOpen.categoryFile"));
    expect(quickOpenDialogSource).toContain("quickOpen.databaseScope");
    expect(quickOpenDialogSource).not.toContain("quickOpen.categoryText");
    expect(quickOpenDialogSource).toContain('} else if (e.key === "Tab") {');
    expect(quickOpenDialogSource).toContain("const direction = e.shiftKey ? -1 : 1;");
    expect(quickOpenDialogSource).toContain('tabindex="-1"');
    expect(quickOpenDialogSource).toContain("function handleOpenAutoFocus(e: Event): void");
    expect(quickOpenDialogSource).toContain("function handleDatabaseScopeCloseAutoFocus(e: Event): void");
    expect(quickOpenDialogSource).toContain("e.preventDefault();");
    expect(quickOpenDialogSource).toContain('@open-auto-focus="handleOpenAutoFocus"');
    expect(quickOpenDialogSource).toContain('@close-auto-focus="handleDatabaseScopeCloseAutoFocus"');
    expect(quickOpenDialogSource).toContain("searchInputElement()?.focus({ preventScroll: true });");
    expect(quickOpenDialogSource).toContain('ref="resultsListRef"');
    expect(quickOpenDialogSource).toContain(':data-quick-open-index="index"');
    expect(quickOpenDialogSource).toContain('?.scrollIntoView({ block: "nearest", inline: "nearest" });');
    expect(quickOpenDialogSource).toMatch(/selectNext\(\);\s*scrollSelectedItemIntoView\(\);/);
    expect(quickOpenDialogSource).toMatch(/selectPrevious\(\);\s*scrollSelectedItemIntoView\(\);/);
    expect(quickOpenDialogSource).toContain('class="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap"');
    expect(quickOpenDialogSource).toContain('class="max-w-[42%] truncate text-xs text-muted-foreground"');
    expect(quickOpenDialogSource).toContain("<DropdownMenu v-if=\"selectedCategory === 'database'\">");
    expect(quickOpenDialogSource).toContain('if (type === "action") return Command;');
    expect(quickOpenDialogSource).toContain("recordActionUsage(item.actionId)");
    expect(quickOpenDialogSource).toMatch(/if \(newOpen\) \{\s*resetSelection\(\);/);
    expect(quickOpenDialogSource).not.toContain('setQuery("");');
    expect(quickOpenDialogSource).toContain("background-color: var(--warning-bg) !important;");
    expect(quickOpenDialogSource).not.toContain("border-radius: 0.75rem;");
    expect(quickOpenDialogSource).not.toContain("color: var(--warning) !important;");
  });
});
