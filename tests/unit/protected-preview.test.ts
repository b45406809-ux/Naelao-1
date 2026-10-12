import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseProtectedPreviewArgs, startProtectedPreviewTunnel } from '../../infra/scripts/protected-preview.mjs';

describe('protected local preview', () => {
  it('requires one or more specific visitor email addresses', () => {
    expect(parseProtectedPreviewArgs(['--share', '--for', 'owner@example.com', '--for', 'reviewer@example.org']))
      .toEqual({ share: true, allowedEmails: ['owner@example.com', 'reviewer@example.org'] });
    expect(() => parseProtectedPreviewArgs(['--share'])).toThrow('--share requires at least one --for email');
    expect(() => parseProtectedPreviewArgs(['--share', '--for', '*@example.com'])).toThrow('--for requires a valid email address');
    expect(() => parseProtectedPreviewArgs(['--for', 'owner@example.com'])).toThrow('--for is only valid with --share');
  });

  it('spawns cloudflared without a shell and reports only the generated preview URL', () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let invocation; const urls = [];
    const started = startProtectedPreviewTunnel({
      allowedEmails: ['owner@example.com', 'reviewer@example.org'],
      spawnImpl: (...args) => { invocation = args; return child; },
      onUrl: url => urls.push(url),
    });
    expect(started).toBe(child);
    expect(invocation).toEqual(['cloudflared', [
      'tunnel', '--url', 'http://127.0.0.1:3100',
      '--allowed-mail', 'owner@example.com', '--allowed-mail', 'reviewer@example.org',
    ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }]);
    child.stdout.write('created https://abc-xyz.trycloudflare.');
    child.stdout.write('com\n');
    child.stderr.write('https://other.trycloudflare.com\n');
    expect(urls).toEqual(['https://abc-xyz.trycloudflare.com']);
  });

  it('rejects unbounded or malformed share requests before spawning', () => {
    expect(() => startProtectedPreviewTunnel({ allowedEmails: [], spawnImpl: () => { throw new Error('must not spawn'); } }))
      .toThrow('preview_allowed_email_required');
    expect(() => startProtectedPreviewTunnel({ allowedEmails: ['owner@example.com'], port: 70000 }))
      .toThrow('preview_port_invalid');
  });
});
