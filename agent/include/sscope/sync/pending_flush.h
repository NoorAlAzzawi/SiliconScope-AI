#pragma once
#include "sscope/db/local_db.h"
#include "sscope/sync/sync_client.h"

namespace sscope {

// Retries all sessions with sync_status='pending' in the local DB.
// Uses the original session_id, import_timestamp, and submitted_fingerprint unchanged.
// Transitions: 200/201 -> synced, 409 -> conflict (with stderr message),
//              network error -> remains pending.
// Returns the count of successfully synced sessions.
int flush_pending_sessions(LocalDb& db, SyncClient& sync_client);

} // namespace sscope
