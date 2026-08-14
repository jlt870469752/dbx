import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const welcomeScreenSource = readFileSync(new URL("../WelcomeScreen.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

describe("WelcomeScreen keyboard shortcuts module", () => {
  it("renders a dedicated keyboard shortcuts section with live shortcut settings", () => {
    expect(welcomeScreenSource).toContain("shortcuts: Partial<ShortcutSettings>;");
    expect(welcomeScreenSource).toContain("const normalizedShortcuts = computed(() => normalizeShortcutSettings(props.shortcuts));");
    expect(welcomeScreenSource).toContain('title: t("welcome.shortcutQuickOpen")');
    expect(welcomeScreenSource).toContain('shortcuts: [{ id: "double-shift", strokes: shortcutStrokeLabels("Shift Shift") }');
    expect(welcomeScreenSource).toContain('t("welcome.keyboardShortcuts")');
    expect(welcomeScreenSource).toContain('t("welcome.shortcutThen")');
  });

  it("passes the configured editor shortcuts from App into WelcomeScreen", () => {
    expect(appSource).toContain(':shortcuts="settingsStore.editorSettings.shortcuts"');
  });
});
