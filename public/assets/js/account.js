/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · account.js — M4: sign in with a magic link, and keep the ★
   list in step with the server.

   Favourites work without an account (an anonymous owner cookie), so this
   panel is an upgrade rather than a gate: signing in moves the stars you
   already collected onto the account, and they then follow you to another
   device. There is no password to choose, forget, reuse or leak.
   ═══════════════════════════════════════════════════════════════════════ */

import * as api from './api.js';
import * as store from './store.js';
import { h, icon, qs, toast } from './ui.js';

/**
 * Adopt the server's star list. Returns the payload, or null when there is nothing to sync with
 * (a file-only host, or a request that failed — offline is not an error for a favourites list).
 */
export async function syncFavourites() {
  if (api.isStatic()) return null;
  try {
    const data = await api.getFavourites();
    store.setFavourites(data.tracks ?? []);
    return data;
  } catch {
    return null;
  }
}

function signedIn(account, redraw) {
  return h(
    'div',
    { class: 'stack stack--tight' },
    h(
      'p',
      { class: 'muted text-sm' },
      h('span', { html: icon('check') }),
      ' Signed in as ',
      h('strong', {}, account.email),
    ),
    h(
      'p',
      { class: 'muted text-xs' },
      'Your ★ list is stored on the station, so it follows you to any device.',
    ),
    h(
      'button',
      {
        class: 'btn btn--sm',
        type: 'button',
        onClick: async () => {
          await api.signOut().catch(() => {});
          toast('Signed out — your local stars stay on this device');
          await syncFavourites();
          redraw();
        },
      },
      'Sign out',
    ),
  );
}

function signedOut() {
  const input = h('input', {
    class: 'input',
    type: 'email',
    name: 'email',
    required: 'required',
    autocomplete: 'email',
    placeholder: 'you@example.com',
    'aria-label': 'E-mail address',
  });
  const status = h('p', { class: 'muted text-xs', hidden: 'hidden' });

  const form = h(
    'form',
    {
      class: 'row wrap',
      onSubmit: async (event) => {
        event.preventDefault();
        const email = input.value.trim();
        if (!email) return;
        status.hidden = false;
        status.textContent = 'Sending…';
        try {
          const result = await api.requestSignInLink(email);
          status.replaceChildren(
            h('span', {}, `Link sent to ${result.sentTo}. It works once and expires soon.`),
          );
          // Outside production the API hands the link back, so a developer does not need an inbox.
          if (result.link) {
            status.append(h('br'), h('a', { href: result.link }, 'Development: open the sign-in link'));
          }
          input.value = '';
        } catch (error) {
          status.textContent =
            error.status === 429
              ? 'Too many attempts — wait a minute and try again.'
              : `Could not send the link: ${error.message}`;
        }
      },
    },
    input,
    h('button', { class: 'btn btn--primary', type: 'submit' }, 'Send sign-in link'),
  );

  return h(
    'div',
    { class: 'stack stack--tight' },
    h(
      'p',
      { class: 'muted text-sm' },
      'Sign in to keep your ★ favourites across devices. No password — we e-mail you a link.',
    ),
    form,
    status,
  );
}

/** Render the panel into `selector` (a no-op in static mode, where there is no API). */
export async function mountAccountPanel(selector = '#account-panel') {
  const host = qs(selector);
  if (!host || api.isStatic()) return null;
  host.hidden = false;

  let account = await api.getAccount().catch(() => ({ signedIn: false, email: null }));
  const redraw = async () => {
    account = await api.getAccount().catch(() => ({ signedIn: false, email: null }));
    host.replaceChildren(
      h('h2', { class: 'panel__title' }, account.signedIn ? 'Your account' : 'Sign in'),
      account.signedIn ? signedIn(account, redraw) : signedOut(),
    );
  };

  await redraw();
  return host;
}
