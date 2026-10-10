// Cross-language contract: the unchanged server checks JSON.stringify(appshot).length.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const binary = path.resolve(process.argv[2] || '.build/debug/SageChecks');
const fixtures = JSON.parse(execFileSync(binary, ['--appshot-fixtures'], { maxBuffer: 2 * 1024 * 1024 }));
assert.equal(fixtures.length, 8);
for (const appshot of fixtures) {
  assert.ok(JSON.stringify(appshot).length < 100000);
  assert.ok(Buffer.byteLength(JSON.stringify(appshot)) < 100000);
  assert.ok(['available', 'partial'].includes(appshot.status));
  assert.ok(appshot.text.length > 0);
}
for (const unit of ['"', '😀']) {
  assert.ok(JSON.stringify({ text: unit.repeat(80000) }).length >= 100000);
}
console.log('8 Swift App Shot fixtures satisfy the server JSON length limit; old 80k-only rule fails.');
