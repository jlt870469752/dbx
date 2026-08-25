import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchQuickOpenText, useQuickOpen } from "@/composables/useQuickOpen";
import * as api from "@/lib/backend/api";
import { getSqlFileFolderPaths, sqlFileFoldersVersion } from "@/lib/sqlFile/sqlFileFolders";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));

vi.mock("@/stores/savedSqlStore", () => ({
  useSavedSqlStore: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listSqlFilesInFolder: vi.fn(),
  readExternalSqlFile: vi.fn(),
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return {
    getSqlFileFolderPaths: vi.fn(),
    sqlFileFoldersVersion: ref(0),
  };
});

function emptySavedSqlStore() {
  return {
    allFiles: [] as any[],
    getFile: vi.fn().mockReturnValue(undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

describe("useQuickOpen", () => {
  beforeEach(() => {
    vi.mocked(useSavedSqlStore).mockReturnValue(emptySavedSqlStore() as any);
    vi.mocked(getSqlFileFolderPaths).mockReturnValue([]);
  });

  describe("external SQL files", () => {
    it("reloads when folders change during an in-flight scan", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(getSqlFileFolderPaths).mockReturnValueOnce(["/old"]).mockReturnValue(["/new"]);
      const oldScan = deferred<Awaited<ReturnType<typeof api.listSqlFilesInFolder>>>();
      vi.mocked(api.listSqlFilesInFolder).mockImplementation((path) => {
        if (path === "/old") return oldScan.promise;
        return Promise.resolve([{ name: "new.sql", path: "/new/new.sql", is_dir: false, children: [] }]);
      });

      const { filteredItems, loadExternalSqlFiles, setQuery } = useQuickOpen();
      const initialLoad = loadExternalSqlFiles();
      expect(api.listSqlFilesInFolder).toHaveBeenCalledWith("/old");

      sqlFileFoldersVersion.value++;
      await nextTick();
      oldScan.resolve([{ name: "old.sql", path: "/old/old.sql", is_dir: false, children: [] }]);
      await initialLoad;

      expect(api.listSqlFilesInFolder).toHaveBeenCalledTimes(2);
      expect(api.listSqlFilesInFolder).toHaveBeenLastCalledWith("/new");
      setQuery(".sql");
      expect(filteredItems.value.map((item) => item.label)).toContain("new.sql");
      expect(filteredItems.value.map((item) => item.label)).not.toContain("old.sql");
    });
  });

  describe("fuzzyMatch function", () => {
    it("ranks exact names, initials, prefixes, substrings, and fuzzy matches in order", () => {
      const exact = matchQuickOpenText("shop", "shop");
      const initials = matchQuickOpenText("gafi", "groupon_apply_finance_invoice");
      const prefix = matchQuickOpenText("shop", "shop_attribute");
      const substring = matchQuickOpenText("shop", "sale_payway_shop");
      const fuzzy = matchQuickOpenText("gafi", "giftcard_define_item");

      expect([exact?.kind, initials?.kind, prefix?.kind, substring?.kind, fuzzy?.kind]).toEqual(["exact", "initials", "prefix", "substring", "fuzzy"]);
      expect(exact!.score).toBeLessThan(initials!.score);
      expect(initials!.score).toBeLessThan(prefix!.score);
      expect(prefix!.score).toBeLessThan(substring!.score);
      expect(substring!.score).toBeLessThan(fuzzy!.score);
      expect(initials?.indices).toEqual([0, 8, 14, 22]);
    });

    it("matches multi-word prefix combinations and highlights their source characters", () => {
      const label = "giftcard_define_shop_log";

      expect(matchQuickOpenText("gdsl", label)?.kind).toBe("initials");
      for (const query of ["giftdsl", "gdshopl", "gdesl"]) {
        const match = matchQuickOpenText(query, label);
        expect(match?.kind).toBe("word-prefix");
        expect(match?.indices.map((index) => label[index]).join("")).toBe(query);
      }
      expect(matchQuickOpenText("giftcard", label)?.kind).toBe("prefix");
      expect(matchQuickOpenText("define", label)?.kind).toBe("substring");
      expect(matchQuickOpenText("shop", label)?.kind).toBe("substring");
      expect(matchQuickOpenText("cardshoplog", label)?.kind).toBe("fuzzy");
    });

    it("puts the exact shop result before prefixed and containing names", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "contains", name: "sale_payway_shop", type: "mssql" },
          { id: "prefix", name: "shop_attribute", type: "mssql" },
          { id: "exact", name: "shop", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("shop");

      expect(filteredItems.value.map((item) => item.label)).toEqual(["shop", "shop_attribute", "sale_payway_shop"]);
    });

    it("puts an exact identifier acronym before loose fuzzy matches", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "fuzzy", name: "giftcard_define_item", type: "mssql" },
          { id: "initials", name: "groupon_apply_finance_invoice", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("gafi");

      expect(filteredItems.value.map((item) => item.label)).toEqual(["groupon_apply_finance_invoice", "giftcard_define_item"]);
      expect(filteredItems.value[0].matchIndices).toEqual([0, 8, 14, 22]);
    });

    it("should return exact substring match with score 1", () => {
      // Mock store with test data
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "MyDatabase",
            label: "MyDatabase",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("MyDatabase");

      // After search, we should find the exact match
      expect(filteredItems.value.length).toBeGreaterThan(0);
      const result = filteredItems.value.find((item) => item.label === "MyDatabase");
      expect(result).toBeDefined();
      if (result) {
        expect(result.matchScore).toBe(1); // Exact substring match score
      }
    });

    it("should handle empty query by returning all items", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Connection1", type: "mssql" },
          { id: "conn2", name: "Connection2", type: "postgres" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      // Empty "All" search includes connections and the local action palette.
      expect(filteredItems.value.length).toBe(20);
      filteredItems.value.forEach((item) => {
        expect(item.matchScore).toBe(Infinity);
      });
    });

    it("should perform fuzzy matching for non-consecutive characters", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("MyCo");

      // Fuzzy match should find "MyConnection"
      const result = filteredItems.value.find((item) => item.label === "MyConnection");
      expect(result).toBeDefined();
    });

    it("should return null for non-matching query", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("XYZ");

      // No match should return empty results
      expect(filteredItems.value.length).toBe(0);
    });

    it("should score consecutive characters higher than non-consecutive", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "user_login_table", type: "mssql" },
          { id: "conn2", name: "user_data_login", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("login");

      // "user_login_table" has consecutive "login" match (better score)
      // "user_data_login" has consecutive "login" match too
      expect(filteredItems.value.length).toBe(2);
      // Both should have score 1.0 (consecutive match: login appears consecutively)
    });
  });

  describe("filtering and searching", () => {
    it("filters to database results when the Database category is selected", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "ProdConnection", db_type: "mysql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "UserDB",
            label: "UserDB",
          },
        ],
      } as any);
      vi.mocked(useSavedSqlStore).mockReturnValue({
        allFiles: [{ id: "sql-1", name: "users.sql", connectionId: "conn1", updatedAt: "2026-08-14T00:00:00.000Z" }],
        getFile: vi.fn().mockReturnValue({ id: "sql-1", name: "users.sql", connectionId: "conn1", updatedAt: "2026-08-14T00:00:00.000Z" }),
      } as any);

      const { filteredItems, selectedCategory, setQuery } = useQuickOpen();
      selectedCategory.value = "database";
      setQuery("user");

      expect(filteredItems.value.map((item) => item.type)).toEqual(["database"]);
      expect(filteredItems.value[0]?.label).toBe("UserDB");
    });

    it("shows local application commands in Action and All without leaking into other categories", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "ProdConnection", db_type: "mysql" }],
        treeNodes: [],
      } as any);

      const { filteredItems, selectedCategory, setQuery } = useQuickOpen();
      selectedCategory.value = "action";
      setQuery("");

      expect(filteredItems.value).toHaveLength(18);
      expect(filteredItems.value.every((item) => item.type === "action")).toBe(true);
      expect(filteredItems.value.map((item) => item.label)).toEqual([
        "/new-query",
        "/settings",
        "/shortcuts",
        "/drivers",
        "/history",
        "/sql-library",
        "/sql-files",
        "/sidebar",
        "/transfer",
        "/refresh",
        "/execute",
        "/format",
        "/save-sql",
        "/close-tab",
        "/focus-where",
        "/transpose",
        "/show-ddl",
        "/ai",
      ]);
      expect(filteredItems.value.map((item) => item.actionId)).toEqual([
        "new-query",
        "open-settings",
        "open-shortcuts",
        "open-driver-store",
        "open-history",
        "open-sql-library",
        "open-sql-files",
        "toggle-sidebar",
        "open-data-transfer",
        "refresh-current",
        "execute-sql",
        "format-sql",
        "save-sql",
        "close-tab",
        "focus-table-where",
        "toggle-transpose",
        "show-ddl",
        "toggle-ai",
      ]);

      selectedCategory.value = "all";
      expect(filteredItems.value.some((item) => item.type === "action")).toBe(true);

      selectedCategory.value = "database";
      expect(filteredItems.value.some((item) => item.type === "action")).toBe(false);
    });

    it("finds actions through Chinese and English aliases", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);

      const { filteredItems, selectedCategory, setQuery } = useQuickOpen();
      selectedCategory.value = "action";

      setQuery("keymap");
      expect(filteredItems.value.map((item) => item.actionId)).toEqual(["open-shortcuts"]);

      setQuery("数据传输");
      expect(filteredItems.value.map((item) => item.actionId)).toEqual(["open-data-transfer"]);

      setQuery("refresh");
      expect(filteredItems.value.map((item) => item.actionId)).toEqual(["refresh-current"]);

      setQuery("/");
      expect(filteredItems.value).toHaveLength(18);
      expect(filteredItems.value.every((item) => item.label.startsWith("/"))).toBe(true);

      setQuery("/short");
      expect(filteredItems.value.map((item) => item.actionId)).toEqual(["open-shortcuts"]);

      setQuery("格式化 sql");
      expect(filteredItems.value.map((item) => item.actionId)).toEqual(["format-sql"]);

      setQuery("table ddl");
      expect(filteredItems.value.map((item) => item.actionId)).toEqual(["show-ddl"]);
    });

    it("sorts actions by usage count and recency, then restores the order from local storage", () => {
      const storage = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      });
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const now = vi.spyOn(Date, "now").mockReturnValue(100);

      try {
        const first = useQuickOpen();
        first.selectedCategory.value = "action";
        first.recordActionUsage("open-history");
        now.mockReturnValue(200);
        first.recordActionUsage("refresh-current");

        expect(first.filteredItems.value.slice(0, 2).map((item) => item.actionId)).toEqual(["refresh-current", "open-history"]);

        now.mockReturnValue(300);
        first.recordActionUsage("open-history");
        expect(first.filteredItems.value[0]?.actionId).toBe("open-history");

        const persisted = JSON.parse(storage.get("dbx-quick-open-action-usage") || "{}");
        expect(persisted["open-history"]).toMatchObject({ count: 2, lastUsedAt: 300 });

        const restored = useQuickOpen();
        restored.selectedCategory.value = "action";
        expect(restored.filteredItems.value[0]?.actionId).toBe("open-history");
      } finally {
        now.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it("filters database results to connected data sources", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "conn1", name: "Connected", db_type: "mysql" },
          { id: "conn2", name: "Cold", db_type: "mysql" },
        ],
        connectedIds: new Set(["conn1"]),
        treeNodes: [
          { connectionId: "conn1", type: "database", database: "app", label: "app" },
          { connectionId: "conn2", type: "database", database: "archive", label: "archive" },
        ],
      } as any);

      const { filteredItems, selectedCategory, databaseScope, setQuery } = useQuickOpen();
      selectedCategory.value = "database";
      databaseScope.value = "connected";
      setQuery("");

      expect(filteredItems.value.map((item) => item.label)).toEqual(["Connected", "app"]);
    });

    it("keeps the current query when switching categories and only changes the search scope", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "ProdConnection", db_type: "mysql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "UserDB",
            label: "UserDB",
          },
        ],
      } as any);
      vi.mocked(useSavedSqlStore).mockReturnValue({
        allFiles: [{ id: "sql-1", name: "users.sql", connectionId: "conn1", updatedAt: "2026-08-14T00:00:00.000Z" }],
        getFile: vi.fn().mockReturnValue({ id: "sql-1", name: "users.sql", connectionId: "conn1", updatedAt: "2026-08-14T00:00:00.000Z" }),
      } as any);

      const { searchQuery, filteredItems, selectedCategory, setQuery } = useQuickOpen();
      setQuery("user");
      expect(searchQuery.value).toBe("user");
      expect(filteredItems.value.map((item) => item.label)).toEqual(["UserDB", "users.sql"]);

      selectedCategory.value = "database";
      expect(searchQuery.value).toBe("user");
      expect(filteredItems.value.map((item) => item.label)).toEqual(["UserDB"]);

      selectedCategory.value = "code";
      expect(searchQuery.value).toBe("user");
      expect(filteredItems.value.map((item) => item.label)).toEqual(["users.sql"]);
    });

    it("applies database scope only inside the Database category", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "conn1", name: "Alpha", db_type: "mysql" },
          { id: "conn2", name: "Beta", db_type: "mysql" },
        ],
        treeNodes: [
          { connectionId: "conn1", type: "database", database: "alpha_db", label: "alpha_db" },
          { connectionId: "conn2", type: "database", database: "beta_db", label: "beta_db" },
        ],
      } as any);
      vi.mocked(useSavedSqlStore).mockReturnValue({
        allFiles: [{ id: "sql-1", name: "shared.sql", connectionId: "conn1", updatedAt: "2026-08-14T00:00:00.000Z" }],
        getFile: vi.fn().mockReturnValue({ id: "sql-1", name: "shared.sql", connectionId: "conn1", updatedAt: "2026-08-14T00:00:00.000Z" }),
      } as any);

      const { filteredItems, selectedCategory, databaseScope, setQuery } = useQuickOpen();
      databaseScope.value = "connection:conn2";
      setQuery("");

      expect(filteredItems.value.map((item) => item.label)).toContain("shared.sql");
      expect(filteredItems.value.map((item) => item.label)).toContain("Alpha");
      expect(filteredItems.value.map((item) => item.label)).toContain("alpha_db");
      expect(filteredItems.value.map((item) => item.label)).toContain("Beta");
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_db");

      selectedCategory.value = "database";
      expect(filteredItems.value.map((item) => item.label)).toEqual(["Beta", "beta_db"]);
    });

    it("keeps the current query when switching database scope and only narrows database results", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "conn1", name: "Alpha", db_type: "mysql" },
          { id: "conn2", name: "Beta", db_type: "mysql" },
        ],
        treeNodes: [
          { connectionId: "conn1", type: "database", database: "users_primary", label: "users_primary" },
          { connectionId: "conn2", type: "database", database: "users_archive", label: "users_archive" },
        ],
      } as any);

      const { searchQuery, filteredItems, selectedCategory, databaseScope, setQuery } = useQuickOpen();
      selectedCategory.value = "database";
      setQuery("users");

      expect(searchQuery.value).toBe("users");
      expect(filteredItems.value.map((item) => item.label)).toEqual(["users_archive", "users_primary"]);

      databaseScope.value = "connection:conn1";
      expect(searchQuery.value).toBe("users");
      expect(filteredItems.value.map((item) => item.label)).toEqual(["users_primary"]);
    });

    it("keeps database-object highlight indices relative to the visible label", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "Test TiDB", db_type: "mysql" }],
        treeNodes: [
          {
            id: "conn1",
            connectionId: "conn1",
            type: "connection",
            label: "Test TiDB",
            children: [
              {
                id: "conn1:retail_mps",
                connectionId: "conn1",
                type: "database",
                database: "retail_mps",
                label: "retail_mps",
                children: [
                  {
                    id: "table1",
                    connectionId: "conn1",
                    type: "table",
                    database: "retail_mps",
                    label: "groupon_apply_finance_invoice",
                  },
                ],
              },
            ],
          },
        ],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("gafi");

      const table = filteredItems.value.find((item) => item.type === "table");
      expect(table?.label).toBe("groupon_apply_finance_invoice");
      expect(table?.matchIndices).toEqual([0, 8, 14, 22]);
    });

    it("uses @source to filter by connection, database, or schema before searching object names", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "Main MySQL", db_type: "mysql" }],
        treeNodes: [
          {
            id: "conn1:prod-xxx1",
            connectionId: "conn1",
            type: "database",
            database: "prod-xxx1",
            label: "prod-xxx1",
            children: [
              { id: "prod-users", connectionId: "conn1", type: "table", database: "prod-xxx1", label: "users" },
              { id: "prod-orders", connectionId: "conn1", type: "table", database: "prod-xxx1", label: "orders" },
            ],
          },
          {
            id: "conn1:test-xxx1",
            connectionId: "conn1",
            type: "database",
            database: "test-xxx1",
            label: "test-xxx1",
            children: [{ id: "test-orders", connectionId: "conn1", type: "table", database: "test-xxx1", label: "orders" }],
          },
        ],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("@prod1");
      expect(filteredItems.value.map((item) => `${item.database ?? item.label}:${item.label}`)).toEqual(["prod-xxx1:prod-xxx1", "prod-xxx1:users", "prod-xxx1:orders"]);

      setQuery("@prodx orders");
      expect(filteredItems.value.map((item) => `${item.database}:${item.label}`)).toEqual(["prod-xxx1:orders"]);
      expect(filteredItems.value[0]?.matchIndices).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("does not highlight the label when only connection metadata matches", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "ProdConnection", db_type: "mysql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "UserDB",
            label: "UserDB",
          },
        ],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("Prod");

      const database = filteredItems.value.find((item) => item.type === "database");
      expect(database?.matchIndices).toEqual([]);
      expect(database?.matchScore).toBeGreaterThan(1000);
    });

    it("indexes database objects under connection groups", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Grouped PG", db_type: "postgres" }],
        treeNodes: [
          {
            id: "group1",
            type: "connection-group",
            label: "Production",
            children: [
              {
                id: "conn1",
                connectionId: "conn1",
                type: "connection",
                label: "Grouped PG",
                children: [
                  {
                    id: "conn1:postgres",
                    connectionId: "conn1",
                    type: "database",
                    database: "postgres",
                    label: "postgres",
                    children: [
                      {
                        id: "conn1:postgres:public",
                        connectionId: "conn1",
                        type: "schema",
                        database: "postgres",
                        schema: "public",
                        label: "public",
                        children: [
                          {
                            id: "conn1:postgres:public:users",
                            connectionId: "conn1",
                            type: "table",
                            database: "postgres",
                            schema: "public",
                            label: "users",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("users");
      expect(filteredItems.value.map((item) => item.label)).toContain("users");
    });

    it("includes schemas as quick open results", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "PG", db_type: "postgres" }],
        treeNodes: [
          {
            id: "conn1",
            connectionId: "conn1",
            type: "connection",
            label: "PG",
            children: [
              {
                id: "conn1:postgres",
                connectionId: "conn1",
                type: "database",
                database: "postgres",
                label: "postgres",
                children: [
                  {
                    id: "conn1:postgres:analytics",
                    connectionId: "conn1",
                    type: "schema",
                    database: "postgres",
                    schema: "analytics",
                    label: "analytics",
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("analytics");
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ type: "schema", label: "analytics" })]));
    });

    it("should filter items based on search query", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "ProdDB", type: "mssql" },
          { id: "conn2", name: "DevDB", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("Prod");

      expect(filteredItems.value.length).toBe(1);
      expect(filteredItems.value[0].label).toBe("ProdDB");
    });

    it("should be case-insensitive", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("myconnection");

      expect(filteredItems.value.length).toBe(1);
      expect(filteredItems.value[0].label).toBe("MyConnection");
    });

    it("should search across connection name and database name", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "ProdConnection", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "UserDB",
            label: "UserDB",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      // Search by connection name
      setQuery("Prod");
      expect(filteredItems.value.length).toBeGreaterThan(0);
    });

    it("should sort by match score (lower scores first)", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Database", type: "mssql" },
          { id: "conn2", name: "MyDB", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("db");

      expect(filteredItems.value.length).toBe(2);
      // First result should have better (lower) score
      expect(filteredItems.value[0].matchScore).toBeLessThanOrEqual(filteredItems.value[1].matchScore);
    });

    it("should sort by type for equal match scores", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "test", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "test_db",
            label: "test_db",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("test");

      // Connections should come before databases for the same query
      if (filteredItems.value.length >= 2) {
        const connectionItem = filteredItems.value.find((item) => item.type === "connection");
        const databaseItem = filteredItems.value.find((item) => item.type === "database");

        if (connectionItem && databaseItem) {
          expect(filteredItems.value.indexOf(connectionItem)).toBeLessThan(filteredItems.value.indexOf(databaseItem));
        }
      }
    });
  });

  describe("item selection navigation", () => {
    it("should initialize with selectedIndex at 0", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectedIndex } = useQuickOpen();
      expect(selectedIndex.value).toBe(0);
    });

    it("should select next item", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedIndex, selectedCategory, setQuery } = useQuickOpen();

      selectedCategory.value = "database";
      setQuery("");

      expect(selectedIndex.value).toBe(0);
      selectNext();
      expect(selectedIndex.value).toBe(1);
    });

    it("should not exceed max index when selecting next", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Conn1", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedIndex, selectedCategory, setQuery } = useQuickOpen();

      selectedCategory.value = "database";
      setQuery("");

      selectNext();
      selectNext(); // Attempt to go beyond max
      expect(selectedIndex.value).toBe(0); // Should stay at 0 (only 1 item)
    });

    it("should select previous item", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectPrevious, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      selectNext();
      expect(selectedIndex.value).toBe(1);
      selectPrevious();
      expect(selectedIndex.value).toBe(0);
    });

    it("should not go below 0 when selecting previous", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectPrevious, selectedIndex } = useQuickOpen();

      // Verify initial state
      expect(selectedIndex.value).toBe(0);

      selectPrevious();
      expect(selectedIndex.value).toBe(0);
    });

    it("should return correct selectedItem", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedItem, setQuery } = useQuickOpen();

      setQuery("");

      expect(selectedItem.value?.label).toBe("Conn1");
      selectNext();
      expect(selectedItem.value?.label).toBe("Conn2");
    });

    it("should return null selectedItem when index is out of bounds", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Conn1", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectedItem, selectedIndex } = useQuickOpen();

      // Manually set invalid index
      selectedIndex.value = 999;
      expect(selectedItem.value).toBeNull();
    });
  });

  describe("reset and query setting", () => {
    it("resets selection when v-model changes the search query directly", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "conn1", name: "Connection1", type: "mssql" },
          { id: "conn2", name: "Connection2", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { searchQuery, selectNext, selectedIndex } = useQuickOpen();
      selectNext();
      expect(selectedIndex.value).toBe(1);

      searchQuery.value = "Connection";
      expect(selectedIndex.value).toBe(0);
    });

    it("should reset selection to 0 when setQuery is called", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, setQuery, selectedIndex } = useQuickOpen();

      selectNext();
      expect(selectedIndex.value).toBe(1);

      setQuery("test");
      expect(selectedIndex.value).toBe(0);
    });

    it("should update searchQuery when setQuery is called", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { searchQuery, setQuery } = useQuickOpen();

      setQuery("NewQuery");
      expect(searchQuery.value).toBe("NewQuery");
    });

    it("should resetSelection to 0", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { resetSelection, selectNext, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      selectNext();
      expect(selectedIndex.value).toBe(1);

      resetSelection();
      expect(selectedIndex.value).toBe(0);
    });
  });

  describe("allItems with different database object types", () => {
    it("should include tables from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "table",
            database: "MyDB",
            schema: "dbo",
            label: "Users",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const tableItem = filteredItems.value.find((item) => item.type === "table");
      expect(tableItem).toBeDefined();
      expect(tableItem?.label).toBe("Users");
    });

    it("should include views from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "view",
            database: "MyDB",
            schema: "dbo",
            label: "UserView",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const viewItem = filteredItems.value.find((item) => item.type === "view");
      expect(viewItem).toBeDefined();
      expect(viewItem?.label).toBe("UserView");
    });

    it("should include procedures from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "procedure",
            database: "MyDB",
            schema: "dbo",
            label: "GetUsers",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const procItem = filteredItems.value.find((item) => item.type === "procedure");
      expect(procItem).toBeDefined();
      expect(procItem?.label).toBe("GetUsers");
    });

    it("should include functions from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "function",
            database: "MyDB",
            schema: "dbo",
            label: "ComputeAge",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const funcItem = filteredItems.value.find((item) => item.type === "function");
      expect(funcItem).toBeDefined();
      expect(funcItem?.label).toBe("ComputeAge");
    });
  });

  describe("SQL library files", () => {
    function savedSqlStoreWithFiles(files: any[]) {
      const fileMap = new Map(files.map((f) => [f.id, f]));
      return {
        allFiles: files,
        getFile: vi.fn().mockImplementation((id: string) => fileMap.get(id)),
      };
    }

    it("shows limited SQL library files when no search query", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = Array.from({ length: 30 }, (_, i) => ({
        id: `file${i}`,
        name: `query_${i}.sql`,
        connectionId: "conn1",
        updatedAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }));
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("");

      // All also includes the 18 local application actions.
      expect(filteredItems.value.length).toBe(39);
      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems.length).toBe(20);
    });

    it("includes all SQL library files when searching", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = [
        { id: "f1", name: "get_users.sql", connectionId: "conn1", updatedAt: "2024-01-01T00:00:00.000Z" },
        { id: "f2", name: "create_orders.sql", connectionId: "conn1", updatedAt: "2024-01-02T00:00:00.000Z" },
        { id: "f3", name: "update_inventory.sql", connectionId: "conn1", updatedAt: "2024-01-03T00:00:00.000Z" },
      ];
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");

      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems).toHaveLength(1);
      expect(sqlItems[0].label).toBe("get_users.sql");
      expect(sqlItems[0].sqlFileId).toBe("f1");
    });

    it("includes SQL library files whose connection was deleted", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "Active", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = [
        { id: "f1", name: "active_query.sql", connectionId: "conn1", updatedAt: "2024-01-01T00:00:00.000Z" },
        { id: "f2", name: "orphaned_query.sql", connectionId: "deleted_conn", updatedAt: "2024-01-02T00:00:00.000Z" },
      ];
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("query");

      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems).toHaveLength(2);
      expect(sqlItems.find((item) => item.label === "orphaned_query.sql")?.description).toBe("Connection deleted");
    });

    it("labels SQL library files without a connection as unassociated", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles([{ id: "f1", name: "draft.sql", connectionId: "", updatedAt: "2024-01-01T00:00:00.000Z" }]) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("draft");

      expect(filteredItems.value.find((item) => item.type === "sql_library_file")?.description).toBe("Unassociated");
    });
  });

  describe("remote metadata search", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    function remoteSearchStore(overrides: Record<string, unknown> = {}) {
      return {
        connections: [{ id: "conn1", name: "MySQL", db_type: "mysql" }],
        connectedIds: new Set(["conn1"]),
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
          },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([]),
        ...overrides,
      };
    }

    async function runDebouncedSearch(): Promise<void> {
      await vi.advanceTimersByTimeAsync(200);
      await flushAsyncWork();
    }

    it("finds unloaded tables through server metadata", async () => {
      const mockStore = remoteSearchStore({
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "orders", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("ord");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "ord", 25, undefined, true, undefined, undefined, { activateConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "orders", type: "table", database: "app" })]));
    });

    it("reuses cached remote metadata locally before scheduling another remote search", async () => {
      const listCompletionTables = vi.fn().mockResolvedValue([{ name: "orders", type: "table" }]);
      const mockStore = remoteSearchStore({ listCompletionTables });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("ord");
      await runDebouncedSearch();
      expect(filteredItems.value.map((item) => item.label)).toContain("orders");

      setQuery("o");

      expect(filteredItems.value.map((item) => item.label)).toContain("orders");
      expect(listCompletionTables).toHaveBeenCalledTimes(1);
    });

    it("deduplicates loaded and remote table results", async () => {
      const mockStore = remoteSearchStore({
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
            children: [
              {
                id: "conn1:app:users",
                connectionId: "conn1",
                type: "table",
                database: "app",
                label: "users",
              },
            ],
          },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "users", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.filter((item) => item.label === "users")).toHaveLength(1);
    });

    it("ignores stale remote responses", async () => {
      const alpha = deferred<Array<{ name: string; type: "table" }>>();
      const beta = deferred<Array<{ name: string; type: "table" }>>();
      const mockStore = remoteSearchStore({
        listCompletionTables: vi.fn((_connectionId, _database, query) => (query === "alpha" ? alpha.promise : beta.promise)),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("alpha");
      await runDebouncedSearch();
      setQuery("beta");
      await runDebouncedSearch();

      beta.resolve([{ name: "beta_table", type: "table" }]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");

      alpha.resolve([{ name: "alpha_table", type: "table" }]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");
      expect(filteredItems.value.map((item) => item.label)).not.toContain("alpha_table");
    });

    it("does not request metadata for empty or one-character queries", async () => {
      const mockStore = remoteSearchStore();
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("");
      setQuery("a");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).not.toHaveBeenCalled();
    });

    it("searches disconnected contexts through lazy connection", async () => {
      const mockStore = remoteSearchStore({ connectedIds: new Set<string>() });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "users", 25, undefined, true, undefined, undefined, { activateConnection: false });
    });

    it("prioritizes the active connection before applying the remote request cap", async () => {
      const connections = Array.from({ length: 9 }, (_, index) => ({ id: `conn${index}`, name: `Connection ${index}`, db_type: "mysql", database: `db${index}` }));
      const mockStore = remoteSearchStore({
        connections,
        activeConnectionId: "conn8",
        connectedIds: new Set(["conn8"]),
        treeNodes: [],
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      const requestedConnections = mockStore.listCompletionTables.mock.calls.map(([connectionId]) => connectionId);
      expect(requestedConnections).toContain("conn8");
      expect(requestedConnections).not.toContain("conn7");
      expect(mockStore.listCompletionTables).toHaveBeenCalledTimes(8);
    });

    it("publishes active connection results without waiting for slow cold connections", async () => {
      const slowSearch = deferred<Array<{ name: string; type: "table" }>>();
      const mockStore = remoteSearchStore({
        connections: [
          { id: "cold", name: "Cold", db_type: "mysql", database: "cold_db" },
          { id: "active", name: "Active", db_type: "mysql", database: "active_db" },
        ],
        activeConnectionId: "active",
        connectedIds: new Set(["active"]),
        treeNodes: [],
        listCompletionTables: vi.fn((connectionId) => (connectionId === "active" ? Promise.resolve([{ name: "active_users", type: "table" as const }]) : slowSearch.promise)),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.map((item) => item.label)).toContain("active_users");
      slowSearch.resolve([]);
      await flushAsyncWork();
    });

    it("drops stale queued contexts before scheduling a newer query", async () => {
      const alphaRequests: Array<ReturnType<typeof deferred<Array<{ name: string; type: "table" }>>>> = [];
      const listCompletionTables = vi.fn((_connectionId, _database, query) => {
        if (query === "alpha") {
          const request = deferred<Array<{ name: string; type: "table" }>>();
          alphaRequests.push(request);
          return request.promise;
        }
        return Promise.resolve([{ name: "beta_table", type: "table" as const }]);
      });
      const mockStore = remoteSearchStore({
        treeNodes: Array.from({ length: 4 }, (_, index) => ({
          id: `conn1:db${index}`,
          connectionId: "conn1",
          type: "database",
          database: `db${index}`,
          label: `db${index}`,
        })),
        listCompletionTables,
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("alpha");
      await runDebouncedSearch();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      setQuery("beta");
      await runDebouncedSearch();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      alphaRequests[0]!.resolve([]);
      await flushAsyncWork();
      expect(listCompletionTables.mock.calls[2]?.[2]).toBe("beta");
      expect(listCompletionTables.mock.calls.filter(([, , query]) => query === "alpha")).toHaveLength(2);

      alphaRequests[1]!.resolve([]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");
    });

    it("derives the SQLite main database before its tree is expanded", async () => {
      const mockStore = remoteSearchStore({
        connections: [{ id: "sqlite-1", name: "SQLite", db_type: "sqlite", host: "/tmp/app.sqlite" }],
        connectedIds: new Set<string>(),
        treeNodes: [],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "scroll_test", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("scroll_test");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("sqlite-1", "main", "scroll_test", 25, undefined, true, undefined, undefined, { activateConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "scroll_test", type: "table", database: "main" })]));
    });

    it("searches the PostgreSQL backend default database before its tree is expanded", async () => {
      const mockStore = remoteSearchStore({
        connections: [{ id: "pg-1", name: "PostgreSQL", db_type: "postgres", database: "" }],
        connectedIds: new Set<string>(),
        treeNodes: [],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "cold_start_table", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("cold_start_table");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("pg-1", "postgres", "cold_start_table", 25, undefined, true, undefined, undefined, { activateConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "cold_start_table", type: "table", database: "postgres" })]));
    });

    it("keeps local results when remote metadata search fails", async () => {
      const mockStore = remoteSearchStore({
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
            children: [
              {
                id: "conn1:app:users",
                connectionId: "conn1",
                type: "table",
                database: "app",
                label: "users",
              },
            ],
          },
        ],
        listCompletionTables: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.map((item) => item.label)).toContain("users");
    });

    it("caps requests, concurrency, and merged remote results", async () => {
      const pending: Array<ReturnType<typeof deferred<Array<{ name: string; type: "table" }>>>> = [];
      let callIndex = 0;
      const listCompletionTables = vi.fn(() => {
        const request = deferred<Array<{ name: string; type: "table" }>>();
        pending.push(request);
        return request.promise;
      });
      const mockStore = remoteSearchStore({
        treeNodes: Array.from({ length: 12 }, (_, index) => ({
          id: `conn1:db${index}`,
          connectionId: "conn1",
          type: "database",
          database: `db${index}`,
          label: `db${index}`,
        })),
        listCompletionTables,
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("table");
      await vi.advanceTimersByTimeAsync(200);
      await flushAsyncWork();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      for (let wave = 0; wave < 4; wave++) {
        const active = pending.slice(wave * 2, wave * 2 + 2);
        for (const request of active) {
          const requestIndex = callIndex++;
          request.resolve(Array.from({ length: 30 }, (_, index) => ({ name: `table_${requestIndex}_${index}`, type: "table" })));
        }
        await flushAsyncWork();
        expect(listCompletionTables.mock.calls.length).toBeLessThanOrEqual(Math.min((wave + 2) * 2, 8));
      }

      await flushAsyncWork();
      expect(listCompletionTables).toHaveBeenCalledTimes(8);
      expect(filteredItems.value.filter((item) => item.type === "table")).toHaveLength(100);
      expect(
        filteredItems.value
          .filter((item) => item.type === "action")
          .map((item) => item.actionId)
          .sort(),
      ).toEqual(["focus-table-where", "show-ddl"]);
    });

    it("limits remote database metadata search to the selected connection scope", async () => {
      const mockStore = remoteSearchStore({
        connections: [
          { id: "conn1", name: "Alpha", db_type: "mysql", database: "app" },
          { id: "conn2", name: "Beta", db_type: "mysql", database: "archive" },
        ],
        treeNodes: [
          { id: "conn1:app", connectionId: "conn1", type: "database", database: "app", label: "app" },
          { id: "conn2:archive", connectionId: "conn2", type: "database", database: "archive", label: "archive" },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectedCategory, databaseScope, setQuery } = useQuickOpen();
      selectedCategory.value = "database";
      databaseScope.value = "connection:conn2";
      setQuery("orders");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledTimes(1);
      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("conn2", "archive", "orders", 25, undefined, true, undefined, undefined, { activateConnection: false });
    });

    it("uses @source to limit remote metadata search to matching databases", async () => {
      const mockStore = remoteSearchStore({
        treeNodes: [
          { id: "conn1:prod-xxx1", connectionId: "conn1", type: "database", database: "prod-xxx1", label: "prod-xxx1" },
          { id: "conn1:test-xxx1", connectionId: "conn1", type: "database", database: "test-xxx1", label: "test-xxx1" },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "orders", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("@prod1 orders");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledTimes(1);
      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("conn1", "prod-xxx1", "orders", 25, undefined, true, undefined, undefined, { activateConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "orders", database: "prod-xxx1" })]));
    });
  });
});
