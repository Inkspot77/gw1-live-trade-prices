/**
 * The Basic Auth gate, exercised directly against `createAuthGate()` rather
 * than through a live HTTP server — the whole surface is `check(req)` and
 * `demandAuth(res)`, so a stub request/response object is enough and keeps
 * these tests fast and free of port allocation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuthGate } from '../src/auth.mjs';

function basicHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function fakeReq(authorization) {
  return { headers: authorization ? { authorization } : {} };
}

/** Captures what demandAuth() would have sent, without a real socket. */
function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { res.body = body; },
  };
  return res;
}

test('a gate with no credentials configured lets everything through', () => {
  const gate = createAuthGate(null);
  assert.equal(gate.enabled, false);
  assert.equal(gate.check(fakeReq(undefined)), true);
  assert.equal(gate.check(fakeReq('garbage')), true);
});

test('correct credentials pass', () => {
  const gate = createAuthGate({ user: 'alan', pass: 'nickset2e' });
  assert.equal(gate.check(fakeReq(basicHeader('alan', 'nickset2e'))), true);
});

test('a missing Authorization header is rejected', () => {
  const gate = createAuthGate({ user: 'alan', pass: 'nickset2e' });
  assert.equal(gate.check(fakeReq(undefined)), false);
});

test('a wrong username is rejected', () => {
  const gate = createAuthGate({ user: 'alan', pass: 'nickset2e' });
  assert.equal(gate.check(fakeReq(basicHeader('eve', 'nickset2e'))), false);
});

test('a wrong password is rejected', () => {
  const gate = createAuthGate({ user: 'alan', pass: 'nickset2e' });
  assert.equal(gate.check(fakeReq(basicHeader('alan', 'wrong'))), false);
});

test('malformed Authorization headers are rejected, not thrown', () => {
  const gate = createAuthGate({ user: 'alan', pass: 'nickset2e' });
  // Not a Basic scheme at all.
  assert.equal(gate.check(fakeReq('Bearer sometoken')), false);
  // Bad base64.
  assert.equal(gate.check(fakeReq('Basic !!!not-base64!!!')), false);
  // Valid base64, but no ":" separator to split user from pass.
  assert.equal(gate.check(fakeReq(`Basic ${Buffer.from('nocolonhere').toString('base64')}`)), false);
  // Empty header value entirely.
  assert.equal(gate.check(fakeReq('Basic ')), false);
});

test('a password containing a colon is still split correctly', () => {
  // decoded is "alan:pass:with:colons" — only the FIRST colon should split
  // user from password, since a password may legitimately contain one.
  const gate = createAuthGate({ user: 'alan', pass: 'pass:with:colons' });
  assert.equal(gate.check(fakeReq(basicHeader('alan', 'pass:with:colons'))), true);
});

test('demandAuth sends 401 with a WWW-Authenticate challenge', () => {
  const gate = createAuthGate({ user: 'alan', pass: 'nickset2e' });
  const res = fakeRes();
  gate.demandAuth(res);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /^Basic realm=/);
  assert.deepEqual(JSON.parse(res.body), { error: 'authentication required' });
});

test('a disabled gate never calls demandAuth in practice (no-op if it did)', () => {
  const gate = createAuthGate(null);
  const res = fakeRes();
  gate.demandAuth(res);
  // Should not throw even though nothing meaningful happens.
  assert.equal(res.statusCode, null);
});
