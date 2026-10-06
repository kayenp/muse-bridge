import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoginUrl } from "../../src/session.js";

test("login URLs are recognised", () => {
  assert.ok(isLoginUrl("https://auth.muse.ai/aymh/?origin=https%3A%2F%2Fmuse.ai"));
  assert.ok(isLoginUrl("https://www.facebook.com/aymh/redirect-cycle/?t=6"));
  assert.ok(isLoginUrl("https://muse.ai/login"));
  assert.ok(!isLoginUrl("https://muse.ai/"));
  assert.ok(!isLoginUrl("https://muse.ai/c/abc123"));
});
