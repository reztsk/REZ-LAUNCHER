import { test } from "node:test";
import assert from "node:assert/strict";
import { framingVars, panFactor, slot } from "./fx-math.ts";

test("carousel: centre box in front, sides fan out symmetrically", () => {
  const c = slot(0, 200);
  assert.equal(c.x, 0);
  assert.equal(c.ry, 0);
  const r = slot(2, 200);
  const l = slot(-2, 200);
  assert.equal(r.x, -l.x);
  assert.equal(r.ry, -l.ry);
  assert.ok(r.z < c.z);
  assert.equal(slot(9, 200).visible, false);
});

test("cover editor: pan speed follows the image overflow", () => {
  // 300 px frame, image rendered 600 px wide: 300 px of travel for 100 %.
  assert.equal(panFactor(300, 600, 1), -1 / 3);
  // Zoom doubles the travel.
  assert.equal(panFactor(300, 600, 2), -100 / 900);
  // Image exactly the frame size: nothing to pan.
  assert.equal(panFactor(300, 300, 1), 0);
});

test("cover framing is clamped into CSS variables", () => {
  assert.equal(framingVars({ cover_zoom: 9, cover_x: -4, cover_y: Number.NaN }), "--cz:4.000;--cx:0.00%;--cy:50.00%");
});
