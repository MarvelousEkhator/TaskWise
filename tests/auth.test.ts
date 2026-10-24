import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken, isAdminEmail, newToken, parseCookies, safeEqual } from "../src/authUtils.js";

test("parseCookies reads several cookies and decodes values", () => {
  const cookies = parseCookies("a=1; tw_session=abc%20def; empty=");
  assert.equal(cookies.a, "1");
  assert.equal(cookies.tw_session, "abc def");
  assert.equal(cookies.empty, "");
});

test("parseCookies handles a missing header", () => {
  assert.deepEqual(parseCookies(undefined), {});
});

test("isAdminEmail matches only the admin, ignoring case and spaces", () => {
  process.env.ADMIN_EMAIL = "Owner@Example.com";
  assert.equal(isAdminEmail("owner@example.com"), true);
  assert.equal(isAdminEmail("  OWNER@EXAMPLE.COM "), true);
  assert.equal(isAdminEmail("someone@example.com"), false);
});

test("isAdminEmail is false for everyone when ADMIN_EMAIL is not set", () => {
  delete process.env.ADMIN_EMAIL;
  assert.equal(isAdminEmail("owner@example.com"), false);
  assert.equal(isAdminEmail(""), false);
});

test("hashToken is stable, differs per token, and never returns the token", () => {
  process.env.SESSION_SECRET = "unit-test-signing-value";
  const token = newToken();
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), hashToken(newToken()));
  assert.notEqual(hashToken(token), token);
});

test("hashToken changes when the signing value changes", () => {
  process.env.SESSION_SECRET = "first-value";
  const first = hashToken("same-token");
  process.env.SESSION_SECRET = "second-value";
  assert.notEqual(first, hashToken("same-token"));
});

test("hashToken refuses to work without SESSION_SECRET", () => {
  delete process.env.SESSION_SECRET;
  assert.throws(() => hashToken("anything"), /SESSION_SECRET/);
});

test("newToken is long and unique", () => {
  const a = newToken();
  assert.ok(a.length >= 43);
  assert.notEqual(a, newToken());
});

test("safeEqual compares exactly", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});