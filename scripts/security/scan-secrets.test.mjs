import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesSecret,isDisallowedEnvFile} from './scan-secrets.mjs';

test('rejects credential-bearing database URLs without printing the value',()=>{
  const sample='postgresql://tester:'+'long-secret-password'+'@db.customer.tld/app';
  assert.ok(matchesSecret(sample).includes('Database URL containing a password'));
});
test('flags high-confidence model and source-control tokens',()=>{
  assert.ok(matchesSecret('gsk_'+'A'.repeat(32)).includes('Groq API token'));
  assert.ok(matchesSecret('ghp_'+'b'.repeat(36)).includes('GitHub API token'));
});
test('flags private key content',()=>{
  assert.ok(matchesSecret('-----BEGIN '+'PRIVATE KEY-----').includes('Private key material'));
});
test('ignores placeholders and harmless example files',()=>{
  assert.deepEqual(matchesSecret('GROQ_API_KEY=example-value'),[]);
  assert.equal(isDisallowedEnvFile('.env.example'),false);
  assert.equal(isDisallowedEnvFile('.env.production'),true);
});

test('reserved documentation database hosts are excluded but real hosts remain detectable',()=>{
  assert.deepEqual(matchesSecret('postgresql://tester:'+'demo-long-password'+'@db.example.invalid/demo'),[]);
});
