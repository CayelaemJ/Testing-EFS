import {execFileSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const rules=[
  ['Groq API token', /gsk_[A-Za-z0-9]{24,}/],
  ['GitHub API token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{45,})/],
  ['OpenAI secret token', /sk-(?:proj-)?[A-Za-z0-9_-]{35,}/],
  ['AWS access key ID', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['Database URL containing a password', /postgres(?:ql)?:\/\/[^:\s/@'"]+:[^\s/@'"]{8,}@[^\s/'"]+/i],
  ['Private key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/]
];

function containsCredentialedNonExampleDatabaseUrl(content) {
  // Reserved documentation and loopback hosts are synthetic fixtures, not deployed databases.
  const candidates=content.match(/postgres(?:ql)?:\/\/[^:\s/@'"]+:[^\s/@'"]{8,}@[^\s/'"]+/gi)||[];
  return candidates.some(candidate=>{
    const host=candidate.split('@').pop().split(':')[0].toLowerCase();
    return !(['localhost','127.0.0.1','::1'].includes(host) ||
      host.endsWith('.invalid') || host.endsWith('.example') ||
      /^example\.(?:com|net|org)$/.test(host));
  });
}
export function matchesSecret(content) {
  return rules.filter(([name,pattern])=>
    name==='Database URL containing a password'
      ? containsCredentialedNonExampleDatabaseUrl(content)
      : pattern.test(content)
  ).map(([name])=>name);
}
export function isDisallowedEnvFile(path) {
  const name=basename(path);
  return /^\.env(?:\..+)?$/.test(name) && !/\.env\.(?:example|sample|template|dist)$/.test(name);
}

export function scanRepository() {
  const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  let hits=0;
  for(const path of tracked) {
    if(isDisallowedEnvFile(path)){console.error('[secret-scan] Tracked environment file:',path);hits++;continue;}
    let content;
    try{
      if(statSync(path).size>4_000_000){console.error('[secret-scan] File exceeds scan limit (manual review required):',path);hits++;continue;}
      content=readFileSync(path,'utf8');
    }catch(e){console.error('[secret-scan] Cannot read tracked file:',path);hits++;continue;}
    if(content.includes('\0'))continue;
    for(const rule of matchesSecret(content)){console.error('[secret-scan]',path,'matches',rule,'(value redacted)');hits++;}
  }
  console.log('[secret-scan] Tracked files checked:',tracked.length,'issues:',hits);
  return hits===0?0:1;
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) process.exitCode=scanRepository();
