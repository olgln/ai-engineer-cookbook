-- Accounts: a user signs in through one or more providers (identities) and holds sessions.
-- Times are Unix seconds. No e-mail, name or provider token is stored: only the provider's user id.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- random UUID
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE identities (
  provider   TEXT NOT NULL,                 -- one of AUTH_PROVIDERS (src/config/app.mjs)
  subject    TEXT NOT NULL,                 -- the provider's stable user id (Google `sub`, GitHub `id`)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,              -- hex SHA-256 of the cookie value
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
