const assert = require('node:assert/strict');
const valid = [
  'postgresql://user:password@ep-example.us-east-2.aws.neon.tech/tonly?sslmode=require',
  'postgres://user:password@host.example/db?sslmode=require',
];
for (const value of valid) {
  const parsed = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  assert.ok(parsed.hostname);
  assert.ok(parsed.pathname.length > 1);
}
const invalid = ['', 'not-a-url', 'http://host/db', 'postgresql://host', 'postgresql://user:pass@host/db?sslmode=disable'];
for (const value of invalid) {
  let accepted = false;
  try { const parsed = new URL(value); accepted = ['postgres:', 'postgresql:'].includes(parsed.protocol) && Boolean(parsed.hostname) && parsed.pathname.length > 1 && parsed.searchParams.get('sslmode') !== 'disable'; } catch {}
  assert.equal(accepted, false, `Unexpectedly accepted invalid database URL: ${value}`);
}
console.log('Neon connection-string shape checks passed.');
