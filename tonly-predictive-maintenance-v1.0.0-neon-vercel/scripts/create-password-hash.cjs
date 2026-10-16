const { randomBytes, scryptSync } = require('node:crypto');
const readline = require('node:readline');

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.error('Run this script directly in an interactive terminal so the password can be entered without echo.');
  process.exit(1);
}
process.stdout.write('Planner password (minimum 14 characters; input hidden): ');
let password = '';
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('keypress', (character, key = {}) => {
  if (key.ctrl && key.name === 'c') { process.stdout.write('\nCancelled.\n'); process.exit(130); }
  if (key.name === 'return' || key.name === 'enter') {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
    if (password.length < 14) {
      console.error('Password must be at least 14 characters. Run the script again.');
      process.exit(1);
    }
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    password = '';
    process.stdout.write(`${salt}:${hash}\n`);
    return;
  }
  if (key.name === 'backspace') { password = password.slice(0, -1); return; }
  if (character && !key.ctrl && !key.meta) password += character;
});
