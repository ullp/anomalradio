/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · share.js — ⇪ share a track.
   Shares the *page* permalink (/track/<id>), never an audio URL — that keeps
   the protection model intact while the link still unfurls a rich card on
   social networks (M2 renders the OG tags server-side).
   ═══════════════════════════════════════════════════════════════════════ */

import { h, icon, toast, copyText } from './ui.js';

export const trackUrl = (track) => `${location.origin}/track/${track.id}`;

const trackText = (track) => `${track.artist} — ${track.title} · Anomalradio.com`;

export function shareTargets(track) {
  const url = encodeURIComponent(trackUrl(track));
  const text = encodeURIComponent(trackText(track));
  return [
    { key: 'x', label: 'X / Twitter', href: `https://twitter.com/intent/tweet?text=${text}&url=${url}` },
    { key: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${url}` },
    { key: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${text}%20${url}` },
    { key: 'telegram', label: 'Telegram', href: `https://t.me/share/url?url=${url}&text=${text}` },
    { key: 'reddit', label: 'Reddit', href: `https://www.reddit.com/submit?url=${url}&title=${text}` },
    {
      key: 'linkedin',
      label: 'LinkedIn',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    },
    { key: 'mastodon', label: 'Mastodon', href: `https://mastodonshare.com/?text=${text}%20${url}` },
    { key: 'mail', label: 'E-mail', href: `mailto:?subject=${text}&body=${url}` },
  ];
}

export async function copyTrackLink(track) {
  const ok = await copyText(trackUrl(track));
  toast(ok ? `Link copied — ${track.title}` : 'Could not access the clipboard', {
    iconName: ok ? 'check' : 'info',
  });
  return ok;
}

export async function nativeShare(track) {
  if (!navigator.share) return false;
  try {
    await navigator.share({ title: trackText(track), text: trackText(track), url: trackUrl(track) });
    return true;
  } catch {
    return false; // user dismissed the sheet
  }
}

let openPopover = null;

function closePopover() {
  openPopover?.remove();
  openPopover = null;
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onKeydown, true);
}

function onDocumentClick(event) {
  if (openPopover && !openPopover.contains(event.target)) closePopover();
}

function onKeydown(event) {
  if (event.key === 'Escape') closePopover();
}

/** Open the share sheet anchored to a button. */
export function openShare(anchor, track) {
  closePopover();

  const popover = h(
    'div',
    { class: 'popover', role: 'dialog', 'aria-label': `Share ${track.title}` },
    h('div', { class: 'popover__title' }, 'Share this track'),
    ...shareTargets(track).map((target) =>
      h(
        'a',
        {
          class: 'popover__item',
          href: target.href,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
        h('span', { class: 'flex', html: icon(target.key) }),
        target.label,
      ),
    ),
    h('div', { class: 'popover__sep' }),
    h(
      'button',
      { class: 'popover__item', type: 'button', onClick: () => copyTrackLink(track) },
      h('span', { class: 'flex', html: icon('copy') }),
      'Copy link',
    ),
    h(
      'button',
      {
        class: 'popover__item',
        type: 'button',
        onClick: () => {
          window.open(trackUrl(track), '_blank', 'noopener');
        },
      },
      h('span', { class: 'flex', html: icon('external') }),
      'Open track page',
    ),
  );

  document.body.append(popover);
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth || 240;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const above = rect.top > popover.offsetHeight + 16;
  popover.style.left = `${left}px`;
  popover.style.top = above
    ? `${rect.top + window.scrollY - popover.offsetHeight - 10}px`
    : `${rect.bottom + window.scrollY + 10}px`;

  openPopover = popover;
  // Deferred so the click that opened the popover does not immediately close it.
  setTimeout(() => {
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }, 0);

  return popover;
}

/**
 * Wire every element carrying data-share="<trackId>" inside a root.
 * Tracks are resolved through the provided lookup function.
 */
export function bindShareButtons(root, lookup) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-share]');
    if (!button) return;
    event.preventDefault();
    const track = lookup(button.dataset.share);
    if (!track) return;
    if (navigator.share && window.matchMedia('(max-width: 720px)').matches) {
      nativeShare(track).then((shared) => {
        if (!shared) openShare(button, track);
      });
      return;
    }
    openShare(button, track);
  });
}
