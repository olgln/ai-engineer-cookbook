-- Learning progress of a signed-in reader: the same JSON document as the browser copy and the export.
-- `rev` grows by one on every write; a write names the rev it was based on (optimistic locking).

CREATE TABLE progress (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
