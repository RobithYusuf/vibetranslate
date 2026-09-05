import { execFileSync } from 'node:child_process';

// A deletion commit is insufficient: private source must not exist in reachable history.
const privateDirectories = ['server', 'worker', 'admin', 'landing', 'docker', 'docs', 'packaging'];
const refs = process.argv.slice(2);
for (const ref of refs.length ? refs : ['HEAD']) {
  const commit = execFileSync('git', [
    'rev-list', '-1', ref, '--', ...privateDirectories,
  ], { encoding: 'utf8' }).trim();
  if (commit) {
    console.error(`Refusing public publication: ${ref} contains private source in commit ${commit}.`);
    console.error(`Private-only directories: ${privateDirectories.join(', ')}`);
    process.exit(1);
  }
}
console.log('Public scope verified: no private directories in reachable history.');
