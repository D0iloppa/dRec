// REST 헬퍼 (상대경로 — dev: vite proxy, prod: nginx proxy)
async function req(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청 실패');
  return data;
}

export const signup = (username: string, password: string, nickname?: string) =>
  req('/auth/signup', { method: 'POST', body: JSON.stringify({ username, password, nickname }) });
export const login = (username: string, password: string) =>
  req('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
export const getProfile = (token: string) =>
  req('/profile/me', { headers: { authorization: 'Bearer ' + token } });
export const patchProfile = (token: string, body: Record<string, unknown>) =>
  req('/profile/me', { method: 'PATCH', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
export const getPresets = () => req('/profile/presets');
export const getItems = () => req('/shop/items');
export const getInventory = (token: string) =>
  req('/shop/inventory', { headers: { authorization: 'Bearer ' + token } });
export const buyItem = (token: string, itemId: number) =>
  req('/shop/buy', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ itemId }) });
export const equipAvatar = (token: string, equipped: Record<string, string>) =>
  req('/profile/equip', { method: 'PUT', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ equipped }) });
