// A stable, anonymous identifier for THIS install — a random UUID minted on first use.
//
// Why it exists: the free server's quota used to key on IP address, because the client never
// sent anything better. That punished the wrong people — an office or campus behind one NAT
// shared a single allowance — while anyone rotating IPs slid past it. The worker has accepted
// an `X-Device-Id` header all along (worker/src/middleware/quota.ts); this is the client
// finally sending it.
//
// Deliberately NOT hardware-derived: a random UUID identifies the install without
// fingerprinting the machine, and deleting app data genuinely resets it. That is the right
// trade for a free-tier counter — abuse resistance worth having, no tracking value.
//
// All Tauri windows share one origin, so localStorage gives every window (settings, overlay,
// popup) the same value. Also used by license activation in Paywall.tsx.
export function getDeviceId(): string {
  let id = localStorage.getItem('machineId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('machineId', id);
  }
  return id;
}
