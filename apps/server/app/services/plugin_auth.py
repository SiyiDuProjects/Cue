"""OAuth provider for the personal read-only plugin; SDK handles PKCE/protocol validation."""
from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from urllib.parse import urlsplit

from mcp.server.auth.provider import AuthorizationCode, AccessToken, RefreshToken, AuthorizeError, RegistrationError, TokenError
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from app.config import get_settings


SCOPE = "sage:read"


class PluginAuth:
    def __init__(self, registry, origin):
        self.registry, self.origin = registry, origin.rstrip("/")
        self.resource = self.origin + "/mcp"
        self.memory = {}

    async def record(self, kind, identity, value=None, ttl=300, pop=False):
        await self.registry._open_store()
        store, now = self.registry._store, time.time()
        key = hashlib.sha256(identity.encode()).hexdigest()
        if store:
            def access():
                with store.connect() as db:
                    db.execute("CREATE TABLE IF NOT EXISTS plugin_auth (owner TEXT, kind TEXT, id TEXT, expires REAL, body TEXT, PRIMARY KEY(owner,kind,id))")
                    if value is not None:
                        db.execute("DELETE FROM plugin_auth WHERE owner=? AND expires<?", (store.owner, now))
                        count = db.execute("SELECT count(*) FROM plugin_auth WHERE owner=?", (store.owner,)).fetchone()[0]
                        if count >= 4096:
                            raise ValueError("插件授权请求过多，请稍后再试。")
                        db.execute("INSERT OR REPLACE INTO plugin_auth VALUES (?,?,?,?,?)", (store.owner, kind, key, now+ttl, json.dumps(value)))
                        return
                    query = ("DELETE FROM plugin_auth WHERE owner=? AND kind=? AND id=? AND expires>? RETURNING body" if pop else
                             "SELECT body FROM plugin_auth WHERE owner=? AND kind=? AND id=? AND expires>?")
                    row = db.execute(query, (store.owner, kind, key, now)).fetchone()
                    return json.loads(row[0]) if row else None
            return await asyncio.to_thread(access)
        owner = hashlib.sha256(get_settings().interview_access_token.encode()).hexdigest()
        index = (owner, kind, key)
        if value is not None:
            self.memory = {k: v for k, v in self.memory.items() if v[0] > now}
            if len(self.memory) >= 4096:
                raise ValueError("插件授权请求过多。")
            self.memory[index] = (now+ttl, value)
            return
        item = self.memory.pop(index, None) if pop else self.memory.get(index)
        return item[1] if item and item[0] > now else None

    async def get_client(self, client_id):
        value = await self.record("client", client_id)
        return OAuthClientInformationFull.model_validate(value) if value else None

    async def register_client(self, client_info):
        if not get_settings().interview_access_token:
            raise RegistrationError("invalid_client_metadata", "Sage access authentication is not configured.")
        for uri in client_info.redirect_uris or []:
            parsed = urlsplit(str(uri))
            if (parsed.scheme != "https" or parsed.netloc != "chatgpt.com" or parsed.fragment or
                not (parsed.path == "/connector_platform_oauth_redirect" or parsed.path.startswith("/connector/oauth/"))):
                raise RegistrationError("invalid_redirect_uri", "Only ChatGPT connector callbacks are supported.")
        await self.record("client", client_info.client_id, client_info.model_dump(mode="json"), ttl=365*86400)

    async def authorize(self, client, params):
        if params.resource != self.resource or set(params.scopes or [SCOPE]) != {SCOPE}:
            raise AuthorizeError("invalid_request", "Sage requires its exact resource and read-only scope.")
        nonce = secrets.token_urlsafe(32)
        await self.record("pending", nonce, {"client_id": client.client_id, "params": params.model_dump(mode="json")})
        return self.origin + "/plugin/connect?request=" + nonce

    async def load_authorization_code(self, client, authorization_code):
        value = await self.record("code", authorization_code)
        return AuthorizationCode.model_validate({**value, "code": authorization_code}) if value and value["client_id"] == client.client_id else None

    async def exchange_authorization_code(self, client, authorization_code):
        value = await self.record("code", authorization_code.code, pop=True)
        if not value or value["client_id"] != client.client_id:
            raise TokenError("invalid_grant", "Authorization code expired or already used.")
        return await self.issue(client.client_id, secrets.token_urlsafe(24))

    async def issue(self, client_id, grant, deadline=None):
        now = int(time.time())
        deadline = deadline or now+30*86400
        remaining = deadline - now
        if remaining <= 0:
            raise TokenError("invalid_grant", "Please reconnect Sage after 30 days.")
        access, refresh = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
        common = {"client_id": client_id, "scopes": [SCOPE], "resource": self.resource, "subject": "sage-owner", "grant": grant, "deadline": deadline}
        await self.record("access", access, {**common, "expires_at": now+min(3600, remaining)}, ttl=min(3600, remaining))
        await self.record("refresh", refresh, {**common, "expires_at": deadline}, ttl=remaining)
        return OAuthToken(access_token=access, token_type="Bearer", expires_in=min(3600, remaining), refresh_token=refresh, scope=SCOPE)

    async def load_refresh_token(self, client, refresh_token):
        value = await self.record("refresh", refresh_token)
        if not value or value["client_id"] != client.client_id or await self.record("revoked", value["grant"]):
            return None
        return RefreshToken.model_validate({**value, "token": refresh_token})

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        value = await self.record("refresh", refresh_token.token, pop=True)
        if not value or value["client_id"] != client.client_id or set(scopes) != {SCOPE} or await self.record("revoked", value["grant"]):
            raise TokenError("invalid_grant", "Refresh token expired or already used.")
        return await self.issue(client.client_id, value["grant"], value["deadline"])

    async def load_access_token(self, token):
        value = await self.record("access", token)
        if not value or await self.record("revoked", value["grant"]):
            return None
        return AccessToken.model_validate({**value, "token": token})

    async def revoke_token(self, token):
        kind = "refresh" if isinstance(token, RefreshToken) else "access"
        value = await self.record(kind, token.token, pop=True)
        if value:
            await self.record("revoked", value["grant"], {"revoked": True}, ttl=31*86400)
