import { readFileSync, appendFileSync } from 'node:fs';

const [ , , stateFile, ...argv ] = process.argv;
appendFileSync(stateFile + '.argv', JSON.stringify(argv) + '\n');

if (argv[0] === 'auth' && argv[1] === 'status') {
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  process.stdout.write(JSON.stringify(st));
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'logout') {
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'login') {
  process.exit(0);
}

process.exit(1);
