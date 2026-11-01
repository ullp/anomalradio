/**
 * The workflows.
 *
 * Nothing else in the suite reads these, which means a one-line edit can silently undo a decision
 * that took a bug to learn. Each assertion below is here because the alternative already happened:
 *
 *   · Pages published the repository root, so the domain served the README instead of the website
 *   · the snapshot build had no store URL, so the published site said "not for sale yet" while the
 *     station said "Buy on Payhip" — the same resolver, disagreeing
 *   · the importer suite skips itself without ffmpeg, so CI could quietly stop exercising the
 *     import pipeline while staying green
 *   · `ubuntu-latest` is migrating to Ubuntu 26, which would move the nginx gate off the version
 *     the instance actually runs
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from './helpers/server.js';

const read = async (name) =>
  readFile(path.join(ROOT, '.github', 'workflows', name), 'utf8');

/** Comment-only lines removed, so a commented-out line cannot satisfy an assertion. */
const effective = (text) =>
  text
    .split('\n')
    .map((line) => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n');

describe('the Pages workflow', () => {
  it('publishes the built snapshot, not the repository root', async () => {
    const yaml = effective(await read('pages.yml'));
    assert.match(yaml, /path:\s*_site/);
    // The bug this guards: publishing the root made the domain render README.md.
    assert.ok(!/jekyll/i.test(yaml), 'a Jekyll build would publish the README again');
  });

  it('gives the snapshot the store URL, so the published site agrees with the station', async () => {
    const yaml = effective(await read('pages.yml'));
    assert.match(yaml, /CHECKOUT_EXTERNAL_DEFAULT_URL:\s*https:\/\/\S+/);
  });
});

describe('the test workflow', () => {
  it('installs ffmpeg, so the import pipeline is actually exercised', async () => {
    const yaml = effective(await read('test.yml'));
    // Without it, importer.test.js and library.test.js skip themselves and CI still goes green.
    assert.match(yaml, /ffmpeg/);
  });

  it('runs the linter and the suite', async () => {
    const yaml = effective(await read('test.yml'));
    assert.match(yaml, /npm run lint/);
    assert.match(yaml, /npm test/);
  });

  it('keeps the nginx gate on the Ubuntu version the instance runs', async () => {
    const yaml = effective(await read('test.yml'));
    // Find the `runs-on:` nearest *before* the nginx step — a whole-file regex would match the other
    // job's `ubuntu-latest` and prove nothing.
    const at = yaml.indexOf('verify-nginx');
    assert.ok(at > 0, 'the nginx verification step is gone');
    const nearest = [...yaml.slice(0, at).matchAll(/runs-on:\s*(\S+)/g)].pop();
    assert.equal(
      nearest?.[1],
      'ubuntu-24.04',
      'the nginx gate must not drift back to ubuntu-latest',
    );
  });
});
