export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OAuth device flow (no client secret): used only when the GitHub CLI is unavailable. */
export async function startDeviceFlow(host: string, clientId: string): Promise<DeviceCode> {
  const res = await fetch(`https://${host}/login/device/code`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'repo read:org' }),
  });
  if (!res.ok) throw new Error(`Device flow failed: HTTP ${res.status}`);
  const data = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };
  return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri, interval: data.interval, expiresIn: data.expires_in };
}

export async function pollDeviceToken(host: string, clientId: string, code: DeviceCode): Promise<string> {
  let interval = code.interval;
  const deadline = Date.now() + code.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await fetch(`https://${host}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, device_code: code.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string; interval?: number };
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      interval = data.interval ?? interval + 5;
      continue;
    }
    throw new Error(data.error === 'access_denied' ? 'Authorization was denied.' : `Device flow failed: ${data.error ?? 'unknown error'}`);
  }
  throw new Error('The device code expired. Start the sign-in again.');
}
