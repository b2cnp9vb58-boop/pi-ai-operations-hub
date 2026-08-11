import test from 'node:test';
import assert from 'node:assert/strict';
import { probeClaudeCapabilities } from '../scripts/probe-claude-capabilities.mjs';
import { createCapabilityFixture } from './fixtures/fake-claude-capability.mjs';

async function probeFixture(options, probeEnv = {}) {
  const fixture = await createCapabilityFixture(options);
  const originalEnv = Object.fromEntries(Object.keys({ ...fixture.env, ...probeEnv })
    .map((name) => [name, process.env[name]]));
  Object.assign(process.env, fixture.env, probeEnv);
  try {
    return await probeClaudeCapabilities(fixture.bin, fixture.dir);
  } finally {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fixture.cleanup();
  }
}

test('accepts a Claude binary that defers and resumes the same tool call', async () => {
  const report = await probeFixture({ supportsDefer: true });

  assert.equal(report.compatible, true);
  assert.equal(report.toolExecutionCount, 1);
});

test('rejects a Claude binary that cannot defer and resume one tool call', async () => {
  const report = await probeFixture({ supportsDefer: false });

  assert.equal(report.compatible, false);
  assert.match(report.reason, /tool_deferred/);
});

test('rejects a resumed tool with a different tool use ID in the same session', async () => {
  const report = await probeFixture({ supportsDefer: true, resumeToolUseId: 'toolu_different' });

  assert.equal(report.compatible, false);
  assert.match(report.reason, /resumed PreToolUse payload/);
});

test('rejects a deferred result whose tool use ID differs from its initial hook payload', async () => {
  const report = await probeFixture({ supportsDefer: true, deferredToolUseId: 'toolu_different' });

  assert.equal(report.compatible, false);
  assert.match(report.reason, /initial PreToolUse payload/);
});

test('rejects a resumed tool whose input differs from the deferred call', async () => {
  const report = await probeFixture({ supportsDefer: true, resumeToolInput: { command: 'printf wrong' } });

  assert.equal(report.compatible, false);
  assert.match(report.reason, /resumed PreToolUse payload/);
});

test('reports an initial subprocess timeout', async () => {
  const startedAt = Date.now();
  const report = await probeFixture(
    { supportsDefer: true, initialDelayMs: 1000 },
    { PI_CONTROL_PROBE_INITIAL_TIMEOUT_MS: '20' },
  );

  assert.equal(report.compatible, false);
  assert.equal(report.failureCode, 'initial_timeout');
  assert.match(report.reason, /initial subprocess timed out/);
  assert.ok(Date.now() - startedAt < 700, 'initial timeout must terminate the subprocess tree');
});

test('reports a resume subprocess timeout', async () => {
  const startedAt = Date.now();
  const report = await probeFixture(
    { supportsDefer: true, resumeDelayMs: 1000 },
    { PI_CONTROL_PROBE_RESUME_TIMEOUT_MS: '20' },
  );

  assert.equal(report.compatible, false);
  assert.equal(report.failureCode, 'resume_timeout');
  assert.match(report.reason, /resume subprocess timed out/);
  assert.ok(Date.now() - startedAt < 700, 'resume timeout must terminate the subprocess tree');
});
