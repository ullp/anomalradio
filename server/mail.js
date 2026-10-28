/**
 * Mail (M4).
 *
 * One job: deliver a sign-in link. Two drivers, and deliberately no SMTP — OCI blocks outbound
 * port 25 on every tenancy, so an SMTP attempt would fail in the worst possible way (the mail
 * simply never arrives, and nothing in the logs says why).
 *
 *   console — print the link to the journal. Development, and a station with no provider yet.
 *   memory  — keep it in the outbox and send nothing. For tests, and for a station whose mail is
 *             not configured yet but which must not fail.
 *   http    — POST `{ from, to, subject, text }` to a transactional API (Resend-shaped), with the
 *             key in a bearer header. Point MAIL_API_URL at whichever provider you use.
 *
 * The console driver keeps the last few messages in `mailer.outbox`, so tests (and the admin
 * dashboard, later) can read the link without scraping stdout.
 */

import { config } from './config.js';

const OUTBOX_LIMIT = 20;

/** The sign-in e-mail. Plain text on purpose: nothing to render, nothing to break. */
export function signInEmail({ origin, link, ttlMinutes }) {
  return {
    subject: 'Your Anomalradio sign-in link',
    text: [
      'Anomalradio.com — sign in',
      '',
      `Open this link to sign in. It works once, and expires in ${ttlMinutes} minutes:`,
      '',
      link,
      '',
      "If you did not ask for this, ignore this message — nothing happens without the link.",
      '',
      `The station: ${origin}/`,
    ].join('\n'),
  };
}

export function createMailer(overrides = {}) {
  const settings = { ...config.mail, ...overrides };
  const outbox = [];

  function remember(message) {
    outbox.push(message);
    if (outbox.length > OUTBOX_LIMIT) outbox.shift();
  }

  async function send({ to, subject, text }) {
    if (settings.driver === 'memory') {
      remember({ to, subject, text, driver: 'memory' });
      return { ok: true, driver: 'memory' };
    }

    if (settings.driver === 'console') {
      console.log(`\n  ✉  ${subject}\n     to ${to}\n\n${text}\n`);
      remember({ to, subject, text, driver: 'console' });
      return { ok: true, driver: 'console' };
    }

    if (settings.driver !== 'http') {
      throw new Error(`unknown mail driver "${settings.driver}" (expected console or http)`);
    }

    const response = await fetch(settings.apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ from: settings.from, to, subject, text }),
    });

    const body = await response.text().catch(() => '');
    remember({ to, subject, text, driver: 'http', status: response.status });

    if (!response.ok) {
      // The message text (with the link) is deliberately not included in the error.
      throw new Error(`mail provider refused the message (${response.status}): ${body.slice(0, 200)}`);
    }
    return { ok: true, driver: 'http', status: response.status };
  }

  return {
    driver: settings.driver,
    from: settings.from,
    outbox,
    send,
    /** The most recent message sent to an address — what a test or a dashboard reads. */
    lastTo: (email) => [...outbox].reverse().find((message) => message.to === email) ?? null,
  };
}

let instance = null;

export function getMailer() {
  if (!instance) instance = createMailer();
  return instance;
}
