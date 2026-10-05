import { KEY_PATTERN } from './crypto';

/**
 * Every route lives in the URL fragment. That keeps secrets out of the
 * server's reach: browsers never send `#...` in a request, and never put it
 * in a Referer header.
 *
 *   #/                       home
 *   #/new                    new draft
 *   #/s/<id>/<key>           view link -- the one people share
 *   #/e/<id>/<key>/<token>   host link -- imported into local history, then
 *                            replaced by #/h/<id> so the token leaves the
 *                            address bar
 *   #/h/<id>                 host editor, credentials from local history
 */

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'view'; id: string; key: string }
  | { name: 'import'; id: string; key: string; token: string }
  | { name: 'host'; id: string };

const ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function parseRoute(hash: string): Route {
  const [kind, id = '', key = '', token = ''] = hash.replace(/^#\/?/, '').split('/');
  if (kind === 'new') return { name: 'new' };
  if (kind === 's' && ID.test(id) && KEY_PATTERN.test(key)) return { name: 'view', id, key };
  if (kind === 'e' && ID.test(id) && KEY_PATTERN.test(key) && TOKEN.test(token)) {
    return { name: 'import', id, key, token };
  }
  if (kind === 'h' && ID.test(id)) return { name: 'host', id };
  return { name: 'home' };
}

const origin = () => location.origin;

export const viewLink = (id: string, key: string) => `${origin()}/#/s/${id}/${key}`;
export const hostLink = (id: string, key: string, token: string) =>
  `${origin()}/#/e/${id}/${key}/${token}`;

export function go(hash: string, replace = false) {
  if (replace) {
    history.replaceState(null, '', hash);
    dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}
