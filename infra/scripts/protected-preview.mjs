import { spawn } from 'node:child_process';

const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export function parseProtectedPreviewArgs(argv) {
  const args = argv.filter(value => value !== '--');
  const share = args.includes('--share');
  const allowedEmails = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--for') continue;
    const email = args[++i];
    if (!email || email.startsWith('--') || email.includes('*') || !EMAIL.test(email)) throw new Error('--for requires a valid email address');
    allowedEmails.push(email);
  }
  if (allowedEmails.length && !share) throw new Error('--for is only valid with --share');
  if (share && !allowedEmails.length) throw new Error('--share requires at least one --for email');
  if (!share && args.some(value => value === '--for')) throw new Error('--for is only valid with --share');
  return share ? { share: true, allowedEmails: [...new Set(allowedEmails)] } : { share: false, allowedEmails: [] };
}

/** Start a temporary browser-authenticated Cloudflare Quick Tunnel to the local shell. */
export function startProtectedPreviewTunnel({ allowedEmails, port = 3100, spawnImpl = spawn, onUrl, onError, onExit }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('preview_port_invalid');
  if (!Array.isArray(allowedEmails) || !allowedEmails.length || allowedEmails.some(email => !EMAIL.test(email))) {
    throw new Error('preview_allowed_email_required');
  }
  const argv = ['tunnel', '--url', `http://127.0.0.1:${port}`];
  for (const email of [...new Set(allowedEmails)]) argv.push('--allowed-mail', email);
  const child = spawnImpl('cloudflared', argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let urlFound = false;
  let outputBuffer = '';
  const inspect = chunk => {
    if (urlFound) return;
    outputBuffer = (outputBuffer + String(chunk)).slice(-512);
    const match = outputBuffer.match(URL_PATTERN);
    if (!match) return;
    urlFound = true;
    onUrl?.(match[0]);
  };
  child.stdout?.on('data', inspect);
  child.stderr?.on('data', inspect);
  child.on('error', error => onError?.(error));
  child.on('exit', (code, signal) => onExit?.(code, signal));
  return child;
}
