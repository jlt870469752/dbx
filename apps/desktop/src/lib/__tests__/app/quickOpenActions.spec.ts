import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

describe("Quick Open actions", () => {
  it("dispatches local actions before database connection handling", () => {
    const actionBranch = appSource.indexOf('if (item.type === "action")');
    const connectionAssignment = appSource.indexOf("connectionStore.activeConnectionId = item.connectionId", actionBranch);

    expect(actionBranch).toBeGreaterThan(-1);
    expect(connectionAssignment).toBeGreaterThan(actionBranch);
    expect(appSource).toContain('openSettings("shortcuts")');
    expect(appSource).toContain('toggleRightSidebarPanel("history")');
    expect(appSource).not.toMatch(/case "open-history":[\s\S]{0,100}openRightSidebarPanel\("history"\)/);
    expect(appSource).toContain('openRightSidebarPanel("sqlLibrary")');
    expect(appSource).toContain('openRightSidebarPanel("sqlFile")');
    expect(appSource).toContain("dialogs.showTransferDialog.value = true");
    expect(appSource).toContain("contentAreaRef.value?.refreshData()");
    expect(appSource).toContain("setSidebarOpen(!sidebarOpen.value)");
    expect(appSource).toContain("requestActiveEditorExecute()");
    expect(appSource).toContain("formatActiveSql()");
    expect(appSource).toContain("await openSaveSqlDialog()");
    expect(appSource).toContain("queryStore.closeTab(queryStore.activeTabId)");
    expect(appSource).toContain("contentAreaRef.value?.focusTableWhere()");
    expect(appSource).toContain("contentAreaRef.value?.toggleDataGridTranspose()");
    expect(appSource).toContain("contentAreaRef.value?.showDataGridDdl()");
    expect(appSource).toContain('toggleRightSidebarPanel("ai")');
  });
});
