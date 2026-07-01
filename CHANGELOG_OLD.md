# Older changes

## 0.5.10
- (bloop16) Improved Steam setup guidance
- (bloop16) Fixed test and editor typing diagnostics
- (bloop16) Prepared release documentation with archived changelog

## 0.5.9
- (bloop16) Added CI workflow concurrency configuration
- (bloop16) Removed obsolete Dependabot workflow file

## 0.5.8 (2026-01-19)
- (bloop16) Repository checker compliance fully verified
- (bloop16) All dependencies updated to latest stable versions
- (bloop16) TypeScript compilation errors fixed
- (bloop16) Configuration schema enhanced with proper type definitions
- (bloop16) Ready for stable repository inclusion

## 0.5.7 (2025-10-19)
- (bloop16) Migrated to NPM Trusted Publishing (removed classic token dependency)
- (bloop16) Updated all dependencies to latest versions
- (bloop16) Fixed TypeScript configuration for better editor support
- (bloop16) Repository checker issues resolved
- (bloop16) Ready for release with improved CI/CD pipeline

## 0.5.6 (2025-06-28)
- (bloop16) Release version

## 0.5.3 (2025-06-14)
- (bloop16) Fixed state roles
- (bloop16) Fixed io-package.json info.connection
- (bloop16) Removed unneeded getState
- (bloop16) Added trigger to onReady for onStateChange

## 0.5.2 (2025-06-14)
- (bloop16) Fixed onStateChange to work correctly with currentGameAppId

## 0.5.1 (2025-05-04)
- (bloop16) Automatic detection and addition of newly played games to monitored list
- (bloop16) Full internationalization for log messages and UI texts
- (bloop16) Improved game lookup (AppID/name, fuzzy search, suggestions)
- (bloop16) Import of all owned Steam games
- (bloop16) Enhanced game state management (icons, logos, stats, news)
- (bloop16) Optimized API request handling (rate limits, backoff, random intervals)
- (bloop16) Automatic object and state creation/cleanup
- (bloop16) Improved error handling and logging

## 0.4.5 (2025-05-02)
- (bloop16) Corrected state roles to align with ioBroker standards
- (bloop16) Replaced standard timers with adapter timers (this.setTimeout/this.setInterval)
- (bloop16) Ensured standard info object creation in io-package.json

## 0.4.4 (2025-05-01)
- (bloop16) Updated log level output and prepared release update

## 0.4.3 (2025-05-01)
- (bloop16) Updated Node.js engine requirement and dependencies

## 0.4.2 (2025-04-21)
- (bloop16) Improved rate limit handling (warning after 3 consecutive limits)

## 0.4.1 (2025-04-21)
- (bloop16) Added random API request jitter (+/-5 seconds)

## 0.4.0 (2025-04-21)
- (bloop16) Fixed owned games fetch trigger in admin UI
- (bloop16) Improved owned games import error handling and logging
- (bloop16) Removed unnecessary debug/info startup logs
- (bloop16) Optimized interval and timer handling for background tasks
- (bloop16) Improved translation coverage for user-facing messages

## 0.3.0 (2025-04-18)
- (bloop16) Added auto-completion for game names and AppIDs
- (bloop16) Added import of owned games from Steam library
- (bloop16) Enhanced game information with icons, logos, and community stats
- (bloop16) Fixed adapter termination issues
- (bloop16) Added automatic game detection for currently played games
- (bloop16) Optimized API usage with reduced duplicate calls

## 0.2.3 (2025-04-18)
- (bloop16) Fixed API request handling

## 0.2.1 (2025-04-16)
- (bloop16) Fixed API request handling

## 0.2.0 (2025-04-16)
- (bloop16) Added typo-tolerant game suggestions (up to 5 similar names)

## 0.1.2 (2025-04-15)
- (bloop16) Added configurable GetPlayerSummaries interval (min 15s, default 60s)
- (bloop16) Added game news updates every 6 hours
- (bloop16) Added recently played games updates every 15 minutes
- (bloop16) Improved API request management and daily reset handling
- (bloop16) General cleanup and error handling improvements

## 0.0.3 (2025-04-13)
- (bloop16) Fixed state directory structure

## 0.0.2 (2025-04-13)
- (bloop16) First working version
- Steam profile information integration
- API request management with daily limits
- Automatic reset of request counter
- Secure API key storage