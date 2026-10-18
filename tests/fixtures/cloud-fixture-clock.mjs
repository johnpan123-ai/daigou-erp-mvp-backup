// Match the dated shared fixture while allowing debounce, retries and UI timers
// to run normally. Call before navigation so application initialization agrees.
export const CLOUD_FIXTURE_TIME = '2026-09-07T12:00:00+08:00';
export const fixCloudFixtureTime = page => page.clock.setFixedTime(CLOUD_FIXTURE_TIME);
