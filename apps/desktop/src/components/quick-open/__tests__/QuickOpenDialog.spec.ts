// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import QuickOpenDialog from "@/components/quick-open/QuickOpenDialog.vue";

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [],
    treeNodes: [],
    connectedIds: new Set<string>(),
  }),
}));

vi.mock("@/stores/savedSqlStore", () => ({
  useSavedSqlStore: () => ({
    allFiles: [],
    getFile: vi.fn().mockReturnValue(undefined),
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listSqlFilesInFolder: vi.fn().mockResolvedValue([]),
  readExternalSqlFile: vi.fn(),
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return {
    getSqlFileFolderPaths: vi.fn().mockReturnValue([]),
    sqlFileFoldersVersion: ref(0),
  };
});

const mountedApps: App[] = [];

async function mountQuickOpenDialog() {
  const state = reactive({ open: true });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(QuickOpenDialog, {
          open: state.open,
          "onUpdate:open": (value: boolean) => {
            state.open = value;
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("QuickOpenDialog", () => {
  it("renders the search panel when opened", async () => {
    await mountQuickOpenDialog();

    expect(document.body.querySelector("[data-slot='dialog-overlay']")).not.toBeNull();
    expect(document.body.querySelector("[data-slot='dialog-content']")).not.toBeNull();
    expect(document.body.querySelector("input")).not.toBeNull();
  });
});
