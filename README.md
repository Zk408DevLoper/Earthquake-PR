# Earthquake Monitor

A mobile-friendly earthquake map and timeline powered by the EMSC / SeismicPortal catalogue. The Android application displays this website in a WebView and adds background monitoring, city/province lookup, and phone-dialer support.

## Run the website

Serve the repository with any static web server, for example `python -m http.server 8000`, then open `http://localhost:8000`. Location access requires HTTPS or localhost and permission from the user. Leaflet, map tiles, and catalogue requests require an internet connection. GitHub Pages hosts the deployed website.

## Where to make changes

| File | Purpose |
| --- | --- |
| `index.html` | Page sections, navigation, forms, and accessible labels |
| `style.css` | Theme variables, shared controls, responsive layout, and component styles |
| `script.js` | API requests, country filtering, map markers, timeline, report details, location, and contacts |

The Android source is maintained separately from this website repository. Its `MainActivity.java` hosts the WebView; `EarthquakeService.java` handles monitoring; `EMSCClient.java` requests catalogue data. Website changes do not require rebuilding Android unless the bridge changes.

## Reading the JavaScript

Settings and shared state are at the top. Named sections group theme handling, requests, country lookup, geometry filtering, map rendering, timeline/details navigation, estimated shaking, location details, frequency, contacts, and startup. `eventFromFeature()` normalizes catalogue records; missing numeric values remain `null`.

Timeline buttons call `selectEarthquake(eventId)` to render the details page. It saves a report snapshot so background refreshes do not erase the report being read. `showSelectedEarthquakeOnMap()` runs only when the user chooses **View on map**. **Back to timeline** restores focus to the report when it remains in the feed.

## Data and calculations

- The timeline displays up to 300 reports from the past seven days in the user's country, including the configured offshore buffer. Without a resolved country, it uses a nearby radius. This limited timeline is not a complete historical catalogue.
- The nearest-event card uses the past two days. Distances are calculated from the device position to reported epicenters.
- Nearby frequency is a separate paginated query within 100 km for the past 30 days. The 24-hour, seven-day, and 30-day counts share one fixed query end time. Results are cached for five minutes, with manual refresh available. They describe reported events, not forecasts.
- Shaking intensity is an empirical estimate. The IPE assumes a fixed 10 km depth; reported catalogue depth remains visible; it is not measured ground motion or an early-warning guarantee.
- Country boundaries come from OpenStreetMap Nominatim. Its public server has strict usage limits; review its policy before changing lookup behavior or deploying to a large audience. City/province labels use Android's Geocoder when available.

API documentation: [EMSC / SeismicPortal](https://www.seismicportal.eu/fdsn-wsevent.html). Country lookup policy: [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). The public Nominatim service limits total application traffic to one request per second, requires identifying requests and attribution, and discourages periodic lookups. Use a suitable provider or your own service as traffic grows.

## Android bridge

The website checks for each method so it can also run in a normal browser:

| JavaScript method | Android behavior |
| --- | --- |
| `AndroidBridge.setSystemBarColor(hex)` | Match system bars to the chosen theme |
| `AndroidBridge.goHomeAndTest()` | Start a notification test |
| `AndroidBridge.resolveCityProvince(latitude, longitude)` | Resolve a place label off the UI thread |

Android returns the place label through `window.receiveCityProvince(latitude, longitude, address)`. Results are ignored after the user has moved away. Keep method names synchronized in both projects. Do not return street addresses to this popup. `tel:` links open the dialer; they never place calls automatically.

## Privacy and contribution notes

Emergency contacts and theme preferences stay in browser/WebView local storage. Contact numbers are not sent to the earthquake API. Device coordinates are sent to services needed for location-based requests. Country lookup results are cached locally. Do not add API keys or private user data to this repository.

Use `textContent` for API values and contact names. When HTML templates are necessary, escape external strings with `escapeHtml()`. Keep editable contact fields selectable even though display text is not selectable. Text-copy restrictions are a presentation preference, not security.

Before submitting a change, run `node --check script.js`, then check the map, timeline → details → map flow, missing location permission, empty/error API responses, and contact add/remove/dial actions. Check narrow mobile widths and keyboard focus. Android builds must be checked separately in Android Studio.

## License

No project license has been selected yet. Public source visibility alone does not grant an open-source license. The maintainers should choose a license before inviting reuse. Third-party libraries, map attribution, and EMSC data terms apply independently.



## Historical threshold test

Open **Timeline → Load 2022 Luzon earthquake** to fetch EMSC record `20220727_0000002` (M7.0, 2022-07-27, Luzon). The original event time, magnitude, depth and epicenter are preserved. The preview evaluates the same `expectedIntensity()` function and `meetsDangerThreshold()` predicate used by the website banner, using an unrounded intensity and the inclusive threshold of 5.

The preview starts at the user's GPS position. **Use epicenter as test point** provides an above-threshold example without modifying device coordinates. The historical record is stored separately from `earthquakeEvents`, remains visible through live refreshes, and does not affect counts, nearest-current-event selection, or live warning banners. **Remove test** clears the preview and its map marker. It is session-only and is not saved locally.

This checks website intensity classification. It does not exercise the Android service, its event-age checks, seen-event storage, permission handling, or notification delivery. Use Android's notification test separately when verifying the background service.



## Research method and departures from the reference

Reference: Finazzi, F., Bossu, R. & Cotton, F. (2024). *Smartphones enabled up to 58 s strong-shaking warning in the M7.8 Türkiye earthquake*. Scientific Reports 14, 4878. https://doi.org/10.1038/s41598-024-55279-z

The website and Android service use `I = -2.15 log10(r) + 1.03 M + 2.31` and the paper's preliminary depth assumption of 10 km. Mild is 2 ≤ I < 4; moderate is 4 ≤ I < 5; intense is I ≥ 5. Comparisons use unrounded values. Android's ordinary notification threshold is now 2; the website intense-shaking banner and historical test threshold are now 5. Catalogue depths are still displayed as reported and must not be confused with model depth.

This is an adaptation of the IPE and classification, not a reproduction of the complete EQN system. Magnitude and epicenter come from EMSC, not the paper's median-smartphone-acceleration estimator. The implementation uses the local approximation `r = sqrt(surfaceDistance² + 10²)`; the map radius uses spherical geometry, so this is not an exact numerical reproduction of every distance expression in the paper. Intensity is clamped to 0–12 as an application convention.

EMSC polling, search limits, baseline/seen-event suppression and freshness rules remain app-specific. The paper's 3-second acceleration updates, category-escalation re-alerts, wave-arrival countdown and warning-time validation have not been reproduced. Existing Android notification tests force a notification even below threshold. Research claims should distinguish IPE classification tests from detection, delivery latency and real early-warning performance. Regional accuracy has not been validated for the Philippines or other deployment locations.
