import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const quickOpenDialogSource = readFileSync(new URL("../QuickOpenDialog.vue", import.meta.url), "utf8");

describe("QuickOpenDialog theme styles", () => {
  it("keeps the shared corner style, category tabs, and readable foreground text", () => {
    expect(quickOpenDialogSource).toContain('class="max-w-3xl p-0 gap-0 rounded-lg overflow-hidden"');
    expect(quickOpenDialogSource).toContain('portalClass="items-start justify-items-center pt-14 sm:pt-20"');
    expect(quickOpenDialogSource).toContain("quickOpen.categoryDatabase");
    expect(quickOpenDialogSource).toContain("quickOpen.databaseScope");
    expect(quickOpenDialogSource).toContain('} else if (e.key === "Tab") {');
    expect(quickOpenDialogSource).toContain("const direction = e.shiftKey ? -1 : 1;");
    expect(quickOpenDialogSource).toContain('tabindex="-1"');
    expect(quickOpenDialogSource).toContain("function handleOpenAutoFocus(e: Event): void");
    expect(quickOpenDialogSource).toContain("function handleDatabaseScopeCloseAutoFocus(e: Event): void");
    expect(quickOpenDialogSource).toContain("e.preventDefault();");
    expect(quickOpenDialogSource).toContain('@open-auto-focus="handleOpenAutoFocus"');
    expect(quickOpenDialogSource).toContain('@close-auto-focus="handleDatabaseScopeCloseAutoFocus"');
    expect(quickOpenDialogSource).toContain("searchInputElement()?.focus({ preventScroll: true });");
    expect(quickOpenDialogSource).toContain("<DropdownMenu v-if=\"selectedCategory === 'database'\">");
    expect(quickOpenDialogSource).toContain("background-color: var(--warning-bg) !important;");
    expect(quickOpenDialogSource).not.toContain("border-radius: 0.75rem;");
    expect(quickOpenDialogSource).not.toContain("color: var(--warning) !important;");
  });
});
