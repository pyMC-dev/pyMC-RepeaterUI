# feat: Statistics page identity, streaming timeout fixes, RRD guard, Hash Cache to Dashboard

## Background

This work began as a targeted fix for performance issues noticed after the last merge. What followed was a chain where each fix exposed the next problem — the scope expanded well beyond the original intent.

**The first thread: timeouts.** The Statistics page was silently failing its most important fetches. The global Axios timeout is 10 seconds. RRD queries for 7-day ranges take ~10.5 seconds on a bandwidth-constrained mesh site; 2-day ranges take ~15 seconds. Every long-range Statistics fetch was timing out, the spinner was clearing (an unrelated faster fetch was completing first), and stale data from the previous time range was left on screen with no indication anything had gone wrong. The fix — a two-phase streaming fetch wrapper — was straightforward, but reaching for it required understanding what data the page was actually fetching and why.

**The second thread: page identity.** Investigating the timeouts made it clear the Statistics page did not have a coherent purpose. It was simultaneously attempting to show live real-time data (fed by WebSocket pushes) and historical time-scoped reports, polling every 30 seconds on data with one-hour RRD resolution. Once the `topStats` computed was traced, a pre-existing bug surfaced: it read directly from `packetStore.packetStats`, which the WebSocket handler also writes on every push. Changing the time range from 7 days to 2 days would fetch the correct scoped result, but the next WebSocket message would silently overwrite it with the current live counter. The page was inadvertently live. Fixing this required a clear decision about what Statistics is for.

**Decision: Dashboard = real-time. Statistics = historical reporting.**

The Dashboard and its StatsCards row show live counters updated by the WebSocket. Statistics is now a pure historical reporting page: data loads once on mount and again when the user changes the time range. Nothing on Statistics updates between those two events.

**The third thread: duplicate HTTP calls.** While auditing which fetches were being made and where, it became apparent that several terminal commands, standalone chart components, and config pages were each calling `ApiService.get('/stats')` directly on every mount — ignoring that DataService already fetches, caches, and polls that endpoint. Each of those mounts was issuing a redundant HTTP request to the device. Similarly, `AirtimeUtilizationChart` was polling at twice its data resolution and re-fetching on every navigation without any cache check.

**The fourth thread: style violations.** A final pass over every touched file turned up a consistent pattern of raw Tailwind palette literals, hardcoded RGBA colour values in CSS, and inline `animate-spin` elements scattered across components that were otherwise well-structured. None of these were introduced by this branch, but they were in files we were already editing, so they were corrected in place.

The result is a branch that fixes the original performance problems but also resolves a set of correctness, identity, and style issues that were quietly present in the codebase.

---

## Changes

### Statistics page rework

**The timeout problem.** All long-running API calls on Statistics (metrics, route stats, noise floor, CRC history) were being issued via `ApiService.get`, which carries the global Axios 10-second timeout. Queries against the RRD backend for 7-day ranges take ~10.5 seconds; 2-day ranges take ~15 seconds on a bandwidth-constrained mesh site. Both exceeded the timeout, causing silent failures — the spinner would clear (due to an unrelated faster fetch completing) and stale cached values from the previous time range would be left on screen with no error indication.

**Fix.** Added `src/utils/streamingFetch.ts` — a timeout-aware `GET` wrapper using a two-phase `AbortController`: 15 seconds for the initial connection, and a rolling 5-second idle timer that resets on every progress chunk. Active streaming is never aborted. All Statistics page fetches, and the System Stats page fetches, now use `streamingGet` rather than `ApiService.get`.

**The WebSocket overwrite problem.** This was a pre-existing issue on both `dev` and `fix/ui-tidy` — we did not introduce it, but we did surface it while investigating the timeout failures. `topStats` (the numerical Total RX / Total TX values) was a `computed` that read directly from `packetStore.packetStats`. That store ref is also written by the WebSocket message handler on every push — so changing the time range from 7 days to 2 days would trigger a fetch, but the first WebSocket push afterwards would silently overwrite the time-scoped result with the current live counter. The page was inadvertently live.

**Fix.** `topStats` is now a local `ref` snapshot written only by the explicit fetch in `fetchAllData`. WebSocket pushes to the store no longer affect it. The periodic polling via `useManagedPolling` was also removed — there is nothing to poll on a page whose data resolution is at minimum one hour per RRD bucket.

**The sparkline flash problem.** Total RX, Total TX, and CRC Errors sparklines all shared one `chartLoadingStates.sparklines` flag. CRC history is a faster query and was clearing that flag before the metrics fetch completed, briefly exposing pre-populated stale sparkline data from the previous time range.

**Fix.** Split into `sparklineMetrics` (cleared only by `loadMetricsData`) and `sparklineCrc` (cleared only by `loadCrcErrorData`). Each card now holds its own loading state.

**The RRD corrupt data problem.** The RRD backend stores packet rates as `count / step_seconds` (the DERIVE consolidation function, step = 60 s). Clean data produces values like 0.017 pkts/s (one packet per minute). Corrupt data points in the dataset were producing values of 6.4 million to 110 million pkts/s, which collapsed the Y-axis scale and rendered the Packet Rate chart unreadable for any range ≥ 24 hours.

**Fix.** Added a physics-based guard: `PACKET_RATE_GUARD = 20 pkts/s`. The ~100 ms on-air time is an estimate based on observed averages at the most common MeshCore LoRa settings (SF/BW/payload vary, so the true figure is not a hard minimum). That gives ~10 pkts/s; the guard is set at 2× for headroom. Since RRD buckets store averaged rates, no legitimate bucket can exceed the instantaneous physical ceiling regardless of time range. Any value above the guard is replaced with 0 before bucketing and sparkline generation.

**Packet Rate chart units.** The Packet Rate chart was labelled "RX/hr" / "TX/hr" but was plotting raw pkts/s values from the API with no conversion applied. All data values are now multiplied by 3600 at the mapping step (after the guard check, before bucketing) so the chart correctly displays packets per hour. Y-axis tick and tooltip precision updated from three decimal places to one.

**Other Statistics cleanup.**
- Default time range is now 24 hours on every visit (localStorage persistence removed).
- Loading spinners and retry buttons added to Total RX, Total TX, and CRC Errors sparkline cards.
- Numerical values show a spinner while loading (not just the chart area).
- Removed ~200 lines of dead Plotly / PacketType chart code.
- `ChartCard.vue` extracted as a reusable chart card with loading/error/retry overlay.

---

### Packet Hash Cache moved to Dashboard

Hash Cache (`duplicate_cache_size`) is a live point-in-time count of entries in the deduplication ring buffer. It is a real-time operational metric:

- It does not respond to the Statistics time-range picker.
- It has no historical series in the RRD database.
- Its meaningful context is "how full is the dedup cache right now", alongside RX count and uptime.

Showing it on the Statistics page alongside time-scoped charts was misleading — the value would not change when the user changed the time range, which looked like a bug.

It now lives in the main Dashboard StatsCards row alongside Uptime, RX, Forward, Dropped, and CRC Errors. The Dashboard grid is updated to 6 columns.

---

### Direct API calls audited — commands, chart components, and config pages

Several terminal commands (`packets`, `status`, `board`, `uptime`, `get`) and standalone chart components (`AirtimeUtilizationChart`, `PacketTypesChart`, `RFNoiseFloor`) were calling `ApiService.get('/stats')` directly. DataService already fetches, caches, and polls `/stats` — these calls were issuing a duplicate request on every mount. `WebSettings.vue` had the same pattern, fetching `/stats` on mount to read CORS and web path config.

**Fix.** All of these now read from `useSystemStore().stats` (which DataService populates) rather than issuing their own HTTP request.

`SetCommand` is the write counterpart: it still calls the backend directly via `ApiService.post` (a write, not a cached read), and on success it calls `useSystemStore().fetchStats()` as an explicit cache-bust. Because all the read commands pull from the same reactive store ref, they see the updated values on their next invocation without needing their own fetches. The UI updates for the same reason.

**What was not migrated.** Statistics page chart fetches (`/metrics_graph_data`, `/route_stats`, `/noise_floor_history`, `/crc_error_history`) were left as direct `streamingGet` calls and are intentionally not routed through DataService. These endpoints accept a `hours` parameter and return time-scoped historical data — the per-page time range picker means there is no single canonical cached result that other components would benefit from. TTL caching would require keying by time range, and DataService is not structured for that. They are documented in `data-service.md` as deliberate direct fetches.

Similarly, `packetStore.fetchPacketStats({ hours })` was replaced with a direct `streamingGet('/packet_stats')` call (not through DataService) to prevent the shared `packetStore.packetStats` ref from being used as the delivery mechanism — doing so would leave it susceptible to WebSocket overwrites between user interactions, which is the exact bug described above.

---

### AirtimeUtilizationChart overhaul

Beyond the `/stats` store migration, `AirtimeUtilizationChart` had several additional issues.

**Polling interval.** The chart was polling every 30 seconds via a raw `setInterval`. The underlying `/airtime_chart_data` endpoint aggregates into 60-second buckets — polling at 30 s was twice the data resolution for no benefit. Replaced with `useManagedPolling` at 120-second intervals (matching 2× the bucket resolution) and removed the manual `clearInterval` in `onBeforeUnmount`.

**Navigation re-fetch.** Every time the user navigated away and back to a page containing this chart, a full re-fetch was triggered even if the data was seconds old. Added a module-level cache with a 2-minute TTL: on mount, if the cached data is fresh it is used immediately and the fetch is skipped entirely.

**Streaming timeout.** The `/airtime_chart_data` fetch used `ApiService.get` and was subject to the global 10-second timeout. Switched to `streamingGet`.

**Theme-aware canvas rendering.** Grid lines and axis labels were drawn with hardcoded `rgba(255, 255, 255, ...)` values — invisible in light mode. Extracted a `getChartChrome()` helper that reads the document class to return correct colours for both modes.

**ChartCard.** Adopted the shared `ChartCard` component for loading, refreshing, error, and retry states, replacing the previous inline approach.

---

### GPS and Sensors nav items — visual pop on load

GPS Diagnostics and Sensors nav items are conditionally shown based on `systemStore.stats` — they are only visible once the hardware reports those features as enabled. This means both items are rendered and available before the bootstrap sequence finishes; the exact moment they appear depends on when the device confirms hardware capability, which happens during the bootstrap HTTP phases.

Previously this was an abrupt hard-pop. The Monitoring nav section is now wrapped in a `TransitionGroup` with a 200 ms fade + 4 px upward slide, so items animate in smoothly as hardware capabilities are confirmed.

The animation is intentionally left in place for a second reason: when we add UI-level configuration for GPS and Sensors features (allowing users to enable or disable them from settings), toggling a feature on will trigger the same slide-in, giving the appearance change the appropriate visual weight.

---

### Bootstrap modal — WebSocket race condition

If the WebSocket connection opened before the HTTP bootstrap phases completed (possible on a fast local network), the modal could transition straight from `loading` to `connected` without passing through `connecting` — skipping the display of HTTP phase progress entirely.

Fixed by separating the two watchers: the bootstrap-complete watcher now checks `wsStore.isConnected` directly and short-circuits to `connected` only if the WS is already open; the WS-opens watcher only acts when `phase === 'connecting'` (not `'loading'`), so a fast WS open during HTTP phases no longer causes the jump.

---

### Router — repeated setup check HTTP calls

`checkSetupStatus()` was called on every navigation via the router `beforeEach` guard, issuing an HTTP request to `/api/needs_setup` each time. Added a module-scoped `_setupComplete` flag: once the device confirms setup is not needed, subsequent navigations skip the HTTP call entirely. The flag resets on page reload (intentional — the user may have factory-reset the device between sessions).

---

### Style rule violations fixed

A final audit of all changed files found and corrected the following violations. Not all were introduced by this branch — some were pre-existing in the files we touched.

**Hand-rolled spinner in `Sparkline.vue`.** The chart-area loading state was implemented with a custom `.loader-spinner` CSS class, a `@keyframes spin` animation, and an inline `:style="{ borderTopColor: color }"` binding to tint the spinner ring. This broke two rules: the prohibition on inline `animate-spin` divs (use `<Spinner>` instead), and the prohibition on `:style=` bindings for fixed appearance values. Replaced with `<Spinner size="sm" />` and `<Spinner size="sm" color="current" />`.

**Hand-rolled spinner in `RFNoiseFloor.vue`.** The CAD Calibration overlay used an inline `<svg class="animate-spin">` with a hand-drawn gear path. Same prohibition — replaced with `<Spinner size="sm" color="current" />`. While there, the `gridLineColor` computed was also refactored: it was subscribing to reactive theme changes via an intentional unused expression guarded by an `eslint-disable` comment. Refactored to read `theme.value === 'dark'` directly, which is both correct and readable.

**Raw Tailwind colour literals in `SystemStats.vue` and `AirtimeUtilizationChart.vue`.** Error and success states were using `text-red-600`, `text-red-700`, `text-red-500`, `text-green-700`, `text-green-400`, `text-white`, and `text-white/60`. These are raw Tailwind palette literals, which are prohibited because they do not respond correctly to dark mode. Replaced with semantic tokens `text-accent-red`, `text-accent-green`, and `text-content-secondary`.

**Raw Tailwind colour literals in `Sidebar.vue` `adaptiveTierClass`.** The adaptive tier badge computed returned raw palette literals for all five tier states (`bg-green-100`, `text-green-700`, `bg-blue-100`, `text-blue-700`, `bg-yellow-100`, `text-yellow-700`, `bg-red-100`, `text-red-700`, `bg-gray-100`, `text-gray-700`, and `dark:` variants of each). Replaced with semantic tokens across all states: `accent-green`, `primary`, `secondary`, `accent-red`, and `surface-elevated`/`content-muted`.

**`bg-yellow-400` in `TopBar.vue` notification badge.** The "checking for updates" state on the bell badge used `bg-yellow-400`. Replaced with `bg-secondary` (the project's semantic amber token).

**Hardcoded RGBA amber in `SystemStats.vue` CSS.** The `.cpu-value:hover` and `@keyframes value-update` rules used `rgba(245, 158, 11, ...)` literals. Replaced with `color-mix(in srgb, var(--color-secondary) …, transparent)` so the colour responds to the token rather than being pinned to a hex value.

**Chart legend dots in `Statistics.vue`.** The Packet Rate legend used `bg-purple-400` and `bg-amber-400` for the RX and TX colour swatches. These literals would not match if the chart palette were ever updated, and they violate the colour literal prohibition. Replaced with `:style="{ backgroundColor: CHART_COLORS.rx/tx }"` so the legend is always in sync with the chart lines. Chart palette colours bound via `:style` are explicitly permitted — they are configuration-driven values, the same category as colours from a data payload.

**Debug `console.log` in `WebSettings.vue`.** A `console.log('PyMC Console exists:', ...)` left from development was found and removed.

**Ad-hoc `z-index: 1000` in `NetworkMap.vue`.** Covered under Z-index fixes below.

---

### Z-index fixes

**Notification panel (TopBar).** The System Status notification panel was rendering behind the map legend on the Neighbours tab. The root cause: `TopBar.vue` uses the `glass-card` class, which applies `backdrop-filter: blur(50px)`. This creates a new CSS stacking context. The notification panel was `position: absolute` inside that context at `z-[100]`, meaning its effective document-root z-index was inherited from TopBar's `z-10` — it could never escape. The map legend, outside that context, was trivially above it regardless of z-index value.

Fix: notification panel wrapped in `<Teleport to="body">`, positioning changed from `absolute` to `fixed`, z-index raised to `z-[250]`.

**Map legend (NetworkMap).** The `.map-legend` CSS class was using `z-index: 1000` — an ad-hoc value well outside the established z-index scale (map overlays are `z-[200]`). Corrected to `z-index: 200`.

---

### CLAUDE.md

Two behaviour rules were added to the project's AI assistant instructions based on patterns observed during this session: "Summarise before acting on investigation tasks" (findings and root cause must be stated before any code is written) and "Never assume the cause of a symptom" (reported bugs must be traced in code, not explained away).
