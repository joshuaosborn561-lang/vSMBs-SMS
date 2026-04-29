const { google } = require('googleapis');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function getRedirectUri() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 3000}`;
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return `${protocol}://${domain}/auth/gmail/callback`;
}

function getAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: clientId,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function exchangeCode(code) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`Gmail OAuth token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${await res.text()}`);
  return res.json();
}

async function getUserEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to get Google user info: ${await res.text()}`);
  const j = await res.json();
  return j.email;
}

function decodeBodyData(data, mimeType) {
  if (!data) return '';
  const buf = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const text = buf.toString('utf8');
  if (mimeType && mimeType.includes('charset=UTF-8')) return text;
  return text;
}

function extractPlainTextFromPayload(payload) {
  if (!payload) return '';
  if (payload.body?.data && (!payload.mimeType || payload.mimeType.startsWith('text/'))) {
    return decodeBodyData(payload.body.data, payload.mimeType);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBodyData(part.body.data, part.mimeType);
      }
    }
    for (const part of payload.parts) {
      const nested = extractPlainTextFromPayload(part);
      if (nested) return nested;
    }
  }
  return '';
}

function getOAuth2Client(refreshToken) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/** Poll unread inbox messages; caller filters by internalDate vs watcher start */
async function pollUnreadSince(refreshToken, _sinceMsForCompat) {
  const auth = getOAuth2Client(refreshToken);
  const gmailAuth = google.gmail({ version: 'v1', auth });

  const q = 'is:unread in:inbox';

  const listRes = await gmailAuth.users.messages.list({
    userId: 'me',
    q,
    maxResults: 25,
  });

  const messages = listRes.data.messages || [];
  const out = [];

  for (const m of messages) {
    const full = await gmailAuth.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'full',
    });

    const msg = full.data;
    const internalDate = msg.internalDate ? parseInt(msg.internalDate, 10) : 0;
    const sinceMs = typeof _sinceMsForCompat === 'number' ? _sinceMsForCompat : null;
    if (sinceMs != null && internalDate && internalDate < sinceMs) continue;

    const headers = msg.payload?.headers || [];
    const get = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const subject = get('Subject');
    const from = get('From');
    let senderEmail = '';
    let senderName = '';
    const fromMatch = from.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
    if (fromMatch) {
      senderName = (fromMatch[1] || '').trim();
      senderEmail = (fromMatch[2] || '').trim();
    } else {
      senderEmail = from.replace(/["']/g, '').trim();
    }

    const body = extractPlainTextFromPayload(msg.payload) || '';

    out.push({
      id: msg.id,
      threadId: msg.threadId,
      internalDate,
      subject,
      senderEmail,
      senderName,
      body,
      snippet: msg.snippet || '',
    });
  }

  return out;
}

async function getAccessTokenFromRefresh(refreshToken) {
  const t = await refreshAccessToken(refreshToken);
  return t.access_token;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getUserEmail,
  getAccessTokenFromRefresh,
  pollUnreadSince,
  getRedirectUri,
};
