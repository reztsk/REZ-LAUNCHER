// Run with: npm test  (Node's built-in test runner, native TS type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, formatClock, formatPlaytime, formatRelative, formatSession, initials } from "./format.ts";
import { guideFor, joinWin } from "./guides.ts";

test("formatPlaytime", () => {
  assert.equal(formatPlaytime(0), "0m");
  assert.equal(formatPlaytime(45), "45m");
  assert.equal(formatPlaytime(2535), "42h 15m");
  assert.equal(formatPlaytime(60), "1h 00m");
  assert.equal(formatPlaytime(-5), "0m");
});

test("formatClock / formatSession", () => {
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatSession(40), "40 s");
  assert.equal(formatSession(4320), "1h 12m");
});

test("formatRelative", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(formatRelative(null, now), "Jamais");
  assert.equal(formatRelative("2026-11-18T11:59:30Z", now), "À l'instant");
  assert.equal(formatRelative("2026-11-18T09:00:00Z", now), "Il y a 3 h");
  assert.equal(formatRelative("2026-11-17T10:00:00Z", now), "Hier");
});

test("esc / initials", () => {
  assert.equal(esc(`<img src=x onerror="a">`), "&lt;img src=x onerror=&quot;a&quot;&gt;");
  assert.equal(initials("Hollow Knight"), "HK");
  assert.equal(initials("celeste"), "CE");
  assert.equal(initials("  "), "?");
});

test("guides build correct Windows paths", () => {
  assert.equal(joinWin("D:\\", "Jeux", "BattleNet"), "D:\\Jeux\\BattleNet");
  const steps = guideFor("battlenet", "Battle.net", "BattleNet", "D:\\");
  const folders = steps.flatMap((s) => (s.action?.kind === "create_folder" ? [s.action.path] : []));
  assert.deepEqual(folders, ["D:\\Jeux", "D:\\Jeux\\BattleNet", "D:\\Jeux\\BattleNet\\Games"]);
  assert.ok(steps.some((s) => s.action?.kind === "download"));
});
