'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

const API_BASE_URL = 'https://api.steampowered.com';
const API_ENDPOINTS = {
    RESOLVE_VANITY_URL: `${API_BASE_URL}/ISteamUser/ResolveVanityURL/v0001/`,
    GET_PLAYER_SUMMARIES: `${API_BASE_URL}/ISteamUser/GetPlayerSummaries/v2/`,
    GET_APP_LIST: `${API_BASE_URL}/ISteamApps/GetAppList/v0002/`,
    GET_NEWS_FOR_APP: `${API_BASE_URL}/ISteamNews/GetNewsForApp/v0002/`,
    GET_RECENTLY_PLAYED: `${API_BASE_URL}/IPlayerService/GetRecentlyPlayedGames/v1/`,
};

const RATE_LIMIT_CONFIG = {
    RETRY_BASE_TIME: 60000, // 1 Minute als Basis-Wartezeit
    MAX_RETRIES: 5, // Maximale Anzahl von Wiederholungsversuchen
    REQUEST_TIMEOUT: 20000, // 20s Timeout für alle API-Anfragen
};

// Central timer configuration for all adapter intervals
const TIMER_CONFIG = {
    // Major timers for background operations
    NEWS_UPDATE_INTERVAL_MS: 6 * 60 * 60 * 1000, // 6 hours
    RECENTLY_PLAYED_INTERVAL_MS: 15 * 60 * 1000, // 15 minutes
    MIN_PLAYER_SUMMARY_INTERVAL_SEC: 15, // 15 seconds

    // Cooldowns to prevent excessive API calls
    RECENTLY_PLAYED_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutes (match the interval)
    NEWS_FETCH_COOLDOWN_MS: 60 * 60 * 1000, // 1 hour

    // Initial intervals after startup to stagger requests
    STARTUP_NEWS_DELAY_MS: 2000, // 2 seconds
    STARTUP_RECENTLY_PLAYED_DELAY_MS: 5000, // 5 seconds
    STARTUP_PLAYER_SUMMARY_DELAY_MS: 10000, // 10 seconds

    // Flag reset timing
    RECENTLY_FETCHED_RESET_MS: 30000, // 30 seconds

    // Data refresh timeouts
    APP_LIST_REFRESH_MS: 86400000, // 24 hours

    // Force shutdown timeout in case of hanging requests
    FORCE_SHUTDOWN_TIMEOUT_MS: 2000, // 2 seconds
};

class Steam extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'steam',
        });

        this._initialStartup = true;
        this._recentlyFetchedFlag = false;
        this._fetchingRecentlyPlayed = false;

        this._activeRequests = 0;
        this._maxConcurrentRequests = 3;
        this._requestQueue = [];

        this.dailyRequestCount = 0;
        this.resetTimeout = null;
        this.steamAppList = null;
        this.lastAppListFetch = 0;
        this.steamID64 = null;
        this.newsInterval = null;
        this.recentlyPlayedInterval = null;
        this.playerSummaryInterval = null;
        this.isFetchingPlayerSummary = false;
        this.isShuttingDown = false;
        this._apiTimeouts = []; // Track all API timeouts for cleanup
        this._fetchingPlayerSummaryStartTime = null; // Timestamp tracking for safe resets

        this._lastApiCallTime = {
            playerSummary: 0,
            recentlyPlayed: 0,
            newsForGame: {},
            appList: 0,
        };

        this._lastActiveGameUpdate = 0;
        this._activeGameUpdateCooldown = 5 * 60 * 1000; // 5 minutes

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    async executeRequest(requestFunction) {
        if (this.isShuttingDown) {
            return null;
        }

        // If too many requests are active, queue this one
        if (this._activeRequests >= this._maxConcurrentRequests) {
            return new Promise((resolve, reject) => {
                this._requestQueue.push({
                    fn: requestFunction,
                    resolve,
                    reject,
                });
            });
        }

        this._activeRequests++;
        try {
            return await requestFunction();
        } finally {
            this._activeRequests--;
            this._processQueue();
        }
    }

    _processQueue() {
        if (this._requestQueue.length > 0 && this._activeRequests < this._maxConcurrentRequests) {
            const next = this._requestQueue.shift();
            this.executeRequest(next.fn).then(next.resolve).catch(next.reject);
        }
    }

    async onReady() {
        // Explicitly reset shutdown flag at startup
        this.isShuttingDown = false;
        this._apiTimeouts = [];
        this._initialStartup = true;
        await this.checkAndCreateStates();

        const apiKey = this.config.apiKey;
        const steamName = this.config.steamName;

        if (!apiKey || !steamName) {
            this.log.error(this._('API Key and Steam Name required.'));
            this.setConnected(false);
            return;
        }

        try {
            // Check if we already have a Steam ID stored
            const storedSteamIdObj = await this.getStateAsync('steamID64');
            const storedSteamNameObj = await this.getStateAsync('steamName');

            // Only resolve if we don't have a Steam ID or the Steam name changed
            if (
                !storedSteamIdObj ||
                !storedSteamIdObj.val ||
                !storedSteamNameObj ||
                storedSteamNameObj.val !== steamName
            ) {
                this.log.info(this._('Need to resolve Steam ID for %s', steamName));
                const steamID64 = await this.resolveSteamID(steamName);

                if (!steamID64) {
                    this.log.error(this._('Could not resolve Steam ID.'));
                    this.setConnected(false);
                    return;
                }

                this.steamID64 = steamID64;
                await this.createOrUpdateState('steamID64', steamID64, 'string', this._('Steam ID64'));
                await this.createOrUpdateState('steamName', steamName, 'string', this._('Steam Name'));
                this.log.info(this._('Resolved Steam ID for %s: %s', steamName, steamID64));
            } else {
                // Use the stored Steam ID
                this.steamID64 = storedSteamIdObj.val;
                this.log.info(this._('Using stored Steam ID: %s', this.steamID64));
            }

            // Check if we should load owned games
            if (this.config.enableOwnedGames) {
                await this.getOwnedGamesAndUpdateConfig();
            }

            await this.setupGames();
            await this.resetDailyRequestCount();

            // Fetch initial data - do this BEFORE setting up intervals
            this.log.info('Fetching initial data after startup...');

            try {
                // Initial player summary fetch
                await this.fetchAndSetData(this.config.apiKey, null);

                // Initial recently played fetch
                await this.fetchRecentlyPlayed();
            } catch (err) {
                this.log.error(`Error during initial data fetch: ${err}`);
            }

            this.setConnected(true);

            // Set startup complete after initial data fetch
            this._initialStartup = false;

            // Clear old intervals if any
            if (this.newsInterval) {
                clearInterval(this.newsInterval);
            }
            if (this.recentlyPlayedInterval) {
                clearInterval(this.recentlyPlayedInterval);
            }
            if (this.playerSummaryInterval) {
                clearInterval(this.playerSummaryInterval);
            }

            // Stagger intervals to prevent overlapping calls
            setTimeout(() => {
                this.newsInterval = setInterval(async () => {
                    try {
                        await this.updateAllGamesNews();
                    } catch (e) {
                        this.log.error(e);
                    }
                }, TIMER_CONFIG.NEWS_UPDATE_INTERVAL_MS);
            }, TIMER_CONFIG.STARTUP_NEWS_DELAY_MS);

            setTimeout(() => {
                this.recentlyPlayedInterval = setInterval(async () => {
                    try {
                        this.logApiDebug('recentlyPlayedInterval', 'Scheduled interval triggered');
                        await this.fetchRecentlyPlayed();
                    } catch (e) {
                        this.log.error(`Error in recentlyPlayed interval: ${e}`);
                    }
                }, TIMER_CONFIG.RECENTLY_PLAYED_INTERVAL_MS);
            }, TIMER_CONFIG.STARTUP_RECENTLY_PLAYED_DELAY_MS);

            // Player summary interval
            let intervalSec = parseInt(String(this.config.playerSummaryIntervalSec), 10) || 60;
            if (intervalSec < TIMER_CONFIG.MIN_PLAYER_SUMMARY_INTERVAL_SEC) {
                intervalSec = TIMER_CONFIG.MIN_PLAYER_SUMMARY_INTERVAL_SEC;
            }

            setTimeout(() => {
                this.playerSummaryInterval = setInterval(() => {
                    (async () => {
                        try {
                            if (this.dailyRequestCount < 10000) {
                                await this.fetchAndSetData(this.config.apiKey, null);
                            } else {
                                this.log.warn(this._('Daily API request limit reached.'));
                            }
                        } catch (e) {
                            this.log.error(e);
                        }
                    })();
                }, intervalSec * 1000);
            }, TIMER_CONFIG.STARTUP_PLAYER_SUMMARY_DELAY_MS);
        } catch (error) {
            this._initialStartup = false; // Make sure to reset flag even on error
            this.log.error(this._('Error during initialization: %s', error));
            this.setConnected(false);
        }
    }

    async getOwnedGamesAndUpdateConfig() {
        this.log.info('Fetching owned games from Steam...');

        if (!this.steamID64 || !this.config.apiKey) {
            this.log.error('Cannot fetch owned games: Missing Steam ID or API key');
            return false;
        }

        try {
            // Define the API endpoint for GetOwnedGames
            const OWNED_GAMES_ENDPOINT = `${API_BASE_URL}/IPlayerService/GetOwnedGames/v0001/`;

            // Make the API call
            const response = await this.apiRequest(OWNED_GAMES_ENDPOINT, {
                key: this.config.apiKey,
                steamid: this.steamID64,
                include_appinfo: 1, // Include game names
                include_played_free_games: 1, // Include free games that have been played
            });

            // Check if we got a valid response
            if (
                response &&
                response.data &&
                response.data.response &&
                response.data.response.games &&
                Array.isArray(response.data.response.games)
            ) {
                const ownedGames = response.data.response.games;
                this.log.info(`Found ${ownedGames.length} owned games`);

                // Create or update gameList in config
                if (!this.config.gameList) {
                    this.config.gameList = [];
                }

                // Keep track of existing games to avoid duplicates
                const existingAppIds = new Set(this.config.gameList.map(game => Number(game.appId)));

                // Process each owned game
                for (const game of ownedGames) {
                    // Process and update game data in states
                    await this.processOwnedGame(game);

                    if (!existingAppIds.has(game.appid)) {
                        // Add new game to config
                        this.config.gameList.push({
                            gameName: game.name,
                            appId: game.appid,
                            enabled: true,
                        });

                        this.log.debug(`Added owned game: ${game.name} (${game.appid})`);
                    }
                }

                // Save the updated configuration without causing restart
                try {
                    const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                    if (obj) {
                        obj.native.gameList = this.config.gameList;
                        // Set noUpdate to true to prevent adapter restart
                        await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj, { noUpdate: true });
                        this.log.info(`Updated configuration with ${this.config.gameList.length} games`);

                        // Disable the flag to prevent fetching on next startup
                        obj.native.enableOwnedGames = false;
                        await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj, { noUpdate: true });
                        this.log.info('Disabled "Enable owned games" option to prevent refetching');
                    }
                } catch (err) {
                    this.log.error(`Failed to update configuration with owned games: ${err}`);
                }

                return true;
            }
            this.log.warn('Invalid or empty response from GetOwnedGames API');
            return false;
        } catch (error) {
            this.log.error(`Error fetching owned games: ${error}`);
            return false;
        }
    }

    async fetchAndSetData(apiKey, steamID64, retryCount = 0) {
        // Add timestamp check to prevent calls that are too close together
        const now = Date.now();
        const lastCallTime = this._lastApiCallTime.playerSummary || 0;
        const timeSinceLastCall = now - lastCallTime;
        const minInterval = 5000; // 5 seconds minimum between calls

        if (timeSinceLastCall < minInterval) {
            this.logApiDebug('fetchAndSetData', `Call too frequent, minimum interval is ${minInterval}ms`);
            return;
        }

        // Check if we're already fetching and skip if so
        if (this.isFetchingPlayerSummary) {
            this.logApiDebug('fetchAndSetData', 'Request skipped because another is running');

            // Add a failsafe: if flag has been set for more than 2 minutes, reset it
            if (this._fetchingPlayerSummaryStartTime && now - this._fetchingPlayerSummaryStartTime > 120000) {
                this.log.warn('Force resetting fetchAndSetData lock after timeout');
                this.isFetchingPlayerSummary = false;
                this._fetchingPlayerSummaryStartTime = null;
            }
            return;
        }

        // Set the flag and timestamp
        this.isFetchingPlayerSummary = true;
        this._fetchingPlayerSummaryStartTime = now;
        this._lastApiCallTime.playerSummary = now;

        try {
            if (this.dailyRequestCount < 8000) {
                // Use the class-level steamID64 variable instead of fetching from state
                if (!this.steamID64) {
                    this.logApiError('fetchAndSetData', new Error('Steam ID not available in memory'));
                    this.isFetchingPlayerSummary = false;
                    this._fetchingPlayerSummaryStartTime = null;
                    return;
                }

                const success = await this.getPlayerSummaries(apiKey, this.steamID64);

                if (success) {
                    this.dailyRequestCount++;
                    await this.setState('info.dailyRequestCount', this.dailyRequestCount, true);

                    // If we have a current game, update its data after player summary succeeds
                    const currentGameState = await this.getStateAsync('currentGame');
                    if (currentGameState && currentGameState.val) {
                        // Call updateActiveGame directly here, without setTimeout
                        await this.updateActiveGame();
                    }
                }
            } else {
                this.logApiWarning('fetchAndSetData', 'Daily API request limit reached');
            }
        } catch (error) {
            this.logApiError('fetchAndSetData', error, 'Error fetching data');

            if (error.response && error.response.status === 429) {
                // Only retry up to MAX_RETRIES times
                if (retryCount >= RATE_LIMIT_CONFIG.MAX_RETRIES) {
                    this.log.error(`Maximum retries (${RATE_LIMIT_CONFIG.MAX_RETRIES}) reached for API call.`);
                    this.isFetchingPlayerSummary = false;
                    this._fetchingPlayerSummaryStartTime = null;
                    return;
                }

                const waitTime = Math.pow(2, retryCount || 0) * RATE_LIMIT_CONFIG.RETRY_BASE_TIME;
                this.logApiWarning('fetchAndSetData', 'Rate limit exceeded. Retrying in %s minutes.', waitTime / 60000);

                // Reset flag BEFORE scheduling retry
                this.isFetchingPlayerSummary = false;
                this._fetchingPlayerSummaryStartTime = null;

                // Schedule a retry
                setTimeout(() => {
                    this.fetchAndSetData(apiKey, null, (retryCount || 0) + 1);
                }, waitTime);

                return; // Exit early
            }
        } finally {
            // Only reset flags if we didn't already reset them in the rate limiting case
            if (this.isFetchingPlayerSummary) {
                this.isFetchingPlayerSummary = false;
                this._fetchingPlayerSummaryStartTime = null;
            }
        }
    }

    async resetDailyRequestCount() {
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
        const msToMidnight = midnight.getTime() - now.getTime();

        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
        }

        this.resetTimeout = setTimeout(async () => {
            this.dailyRequestCount = 0;
            this.log.info(this._('Daily request count reset.'));
            await this.setState('info.dailyRequestCount', this.dailyRequestCount, true);
            await this.setState('info.dailyRequestCountReset', new Date().toISOString(), true);
            this.resetDailyRequestCount();
        }, msToMidnight);
    }

    async apiRequest(endpoint, params = {}, retryCount = 0) {
        // Simple early return if shutting down
        if (this.isShuttingDown) {
            this.logApiDebug('apiRequest', 'Request skipped because adapter is shutting down');
            return {
                status: 200,
                data: { response: { success: 0 } },
            };
        }

        return this.executeRequest(async () => {
            try {
                this.logApiDebug('apiRequest', 'API request to %s', endpoint);
                const response = await axios.get(endpoint, {
                    params,
                    timeout: RATE_LIMIT_CONFIG.REQUEST_TIMEOUT,
                });
                return response;
            } catch (error) {
                // Handle Rate-Limit (429)
                if (
                    !this.isShuttingDown &&
                    error.response &&
                    error.response.status === 429 &&
                    retryCount < RATE_LIMIT_CONFIG.MAX_RETRIES
                ) {
                    const waitTime = Math.pow(2, retryCount) * RATE_LIMIT_CONFIG.RETRY_BASE_TIME;
                    this.logApiWarning('apiRequest', 'Rate limit exceeded. Retrying in %s minutes.', waitTime / 60000);

                    const timeoutId = setTimeout(() => {
                        const index = this._apiTimeouts.indexOf(timeoutId);
                        if (index !== -1) {
                            this._apiTimeouts.splice(index, 1);
                        }
                    }, waitTime);
                    this._apiTimeouts.push(timeoutId);

                    // Wait for timeout
                    await new Promise(resolve => setTimeout(resolve, waitTime));

                    // Check again before retrying
                    if (this.isShuttingDown) {
                        throw new Error('Adapter is shutting down');
                    }

                    return this.apiRequest(endpoint, params, retryCount + 1);
                }

                this.logApiError('apiRequest', error);
                throw error;
            }
        });
    }

    async safeApiCall(apiFunction, errorReturnValue, errorMessage) {
        if (this.isShuttingDown) {
            this.logApiDebug('safeApiCall', 'API call skipped because adapter is shutting down');
            return errorReturnValue;
        }

        try {
            return await apiFunction();
        } catch (error) {
            // If we're shutting down during this call, just return without error
            if (this.isShuttingDown) {
                this.logApiDebug('safeApiCall', 'API call aborted due to shutdown');
                return errorReturnValue;
            }

            this.log.error(this._(errorMessage, error));
            return errorReturnValue;
        }
    }

    async resolveSteamID(steamName) {
        return this.safeApiCall(
            async () => {
                const apiKey = this.config.apiKey;
                const response = await this.apiRequest(API_ENDPOINTS.RESOLVE_VANITY_URL, {
                    key: apiKey,
                    vanityurl: steamName,
                });

                if (response.data && response.data.response && response.data.response.success === 1) {
                    this.logApiInfo('resolveSteamID', 'Successfully resolved Steam ID for %s', steamName);
                    return response.data.response.steamid;
                }
                this.logApiWarning('resolveSteamID', 'Could not resolve Steam ID for %s', steamName);
                return null;
            },
            null,
            'Error resolving Steam ID: %s',
        );
    }

    async getPlayerSummaries(apiKey, steamID) {
        return this.safeApiCall(
            async () => {
                // Update timestamp directly
                this._lastApiCallTime.playerSummary = Date.now();

                this.logApiDebug('getPlayerSummaries', 'Fetching player data using Steam ID from state');
                const response = await this.apiRequest(API_ENDPOINTS.GET_PLAYER_SUMMARIES, {
                    key: apiKey,
                    format: 'json',
                    steamids: steamID,
                });

                if (response.status === 200 && response.data.response.players[0]) {
                    await this.setPlayerState(response.data.response.players[0]);
                    return true;
                }
                this.logApiWarning('getPlayerSummaries', 'No player data received from Steam API');
                return false;
            },
            false,
            'Error fetching player data: %s',
        );
    }

    async setPlayerState(data) {
        try {
            // Skip if shutting down
            if (this.isShuttingDown) {
                this.logApiDebug('setPlayerState', 'Skipped updating player state during shutdown');
                return;
            }

            // Update basic player states
            const updates = [
                this.createOrUpdateState('playerName', data.personaname, 'string', this._('Player Name')),
                this.createOrUpdateState('profileURL', data.profileurl, 'string', this._('Profile URL')),
                this.createOrUpdateState('avatar', data.avatarfull, 'string', this._('Avatar URL')),
                this.createOrUpdateState('playerState', data.personastate, 'number', this._('Player State')),
            ];

            // Add current game info if available
            if (data.gameextrainfo) {
                if (data.gameid) {
                    updates.push(
                        this.createOrUpdateState(
                            'currentGameAppId',
                            parseInt(data.gameid),
                            'number',
                            this._('Current Game App ID'),
                        ),
                    );
                }
                updates.push(
                    this.createOrUpdateState('currentGame', data.gameextrainfo, 'string', this._('Current Game')),
                );
            } else {
                updates.push(this.createOrUpdateState('currentGame', '', 'string', this._('Current Game')));
            }

            // Execute all state updates in parallel
            await Promise.all(updates);
        } catch (error) {
            this.log.error(this._('Error updating player state: %s', error));
        }
    }

    async createGameStates(gameId, gameName) {
        await this.setObjectNotExistsAsync(`games.${gameId}`, {
            type: 'channel',
            common: { name: gameName },
            native: {},
        });
        await this.setObjectNotExistsAsync(`games.${gameId}.name`, {
            type: 'state',
            common: {
                name: this._('Game Name'),
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`games.${gameId}.isPlaying`, {
            type: 'state',
            common: {
                name: this._('Currently Playing'),
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`games.${gameId}.gameAppId`, {
            type: 'state',
            common: {
                name: this._('Game App ID'),
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`games.${gameId}.news`, {
            type: 'channel',
            common: { name: this._('Game News') },
            native: {},
        });
        await this.setObjectNotExistsAsync(`games.${gameId}.news.lastTitle`, {
            type: 'state',
            common: {
                name: this._('Latest News Title'),
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`games.${gameId}.news.lastURL`, {
            type: 'state',
            common: {
                name: this._('Latest News URL'),
                type: 'string',
                role: 'url',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`games.${gameId}.news.lastContent`, {
            type: 'state',
            common: {
                name: this._('Latest News Content'),
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`games.${gameId}.news.lastDate`, {
            type: 'state',
            common: {
                name: this._('Latest News Date'),
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
            },
            native: {},
        });

        // Add additional states for Steam game information
        await this.setObjectNotExistsAsync(`games.${gameId}.playtime_2weeks`, {
            type: 'state',
            common: {
                name: this._('Playtime (2 weeks)'),
                type: 'number',
                role: 'value',
                unit: 'min',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`games.${gameId}.playtime_forever`, {
            type: 'state',
            common: {
                name: this._('Playtime (total)'),
                type: 'number',
                role: 'value',
                unit: 'min',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`games.${gameId}.icon_url`, {
            type: 'state',
            common: {
                name: this._('Game Icon URL'),
                type: 'string',
                role: 'url',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`games.${gameId}.logo_url`, {
            type: 'state',
            common: {
                name: this._('Game Logo URL'),
                type: 'string',
                role: 'url',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`games.${gameId}.stats_url`, {
            type: 'state',
            common: {
                name: this._('Game Stats URL'),
                type: 'string',
                role: 'url',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`games.${gameId}.has_stats`, {
            type: 'state',
            common: {
                name: this._('Has Community Stats'),
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
    }

    async processOwnedGame(gameData) {
        try {
            const gameName = gameData.name || `Unknown Game (${gameData.appid})`;
            const gameId = gameName.replace(/[^a-zA-Z0-9]/g, '_');

            // Create game states if they don't exist
            await this.createGameStates(gameId, gameName);

            // Update basic game info
            await this.setState(`games.${gameId}.name`, gameName, true);
            await this.setState(`games.${gameId}.gameAppId`, gameData.appid, true);

            // Update playtime information
            if (gameData.playtime_2weeks !== undefined) {
                await this.setState(`games.${gameId}.playtime_2weeks`, gameData.playtime_2weeks, true);
            } else {
                await this.setState(`games.${gameId}.playtime_2weeks`, 0, true);
            }

            if (gameData.playtime_forever !== undefined) {
                await this.setState(`games.${gameId}.playtime_forever`, gameData.playtime_forever, true);
            }

            // Create and update image URLs
            if (gameData.img_icon_url) {
                const iconUrl = `http://media.steampowered.com/steamcommunity/public/images/apps/${gameData.appid}/${gameData.img_icon_url}.jpg`;
                await this.setState(`games.${gameId}.icon_url`, iconUrl, true);
            }

            if (gameData.img_logo_url) {
                const logoUrl = `http://media.steampowered.com/steamcommunity/public/images/apps/${gameData.appid}/${gameData.img_logo_url}.jpg`;
                await this.setState(`games.${gameId}.logo_url`, logoUrl, true);
            }

            // Update stats information
            if (gameData.has_community_visible_stats !== undefined) {
                await this.setState(`games.${gameId}.has_stats`, gameData.has_community_visible_stats, true);

                if (gameData.has_community_visible_stats) {
                    const statsUrl = `http://steamcommunity.com/profiles/${this.steamID64}/stats/${gameData.appid}`;
                    await this.setState(`games.${gameId}.stats_url`, statsUrl, true);
                }
            }

            this.log.debug(`Updated game data for ${gameName}`);
        } catch (error) {
            this.log.warn(`Error processing owned game ${gameData.appid}: ${error}`);
        }
    }

    async addNewGame(gameData) {
        if (!gameData || !gameData.name) {
            this.log.warn('addNewGame called with invalid gameData');
            return;
        }
        try {
            const gameId = gameData.name.replace(/[^a-zA-Z0-9]/g, '_');
            await this.createGameStates(gameId, gameData.name);
            await this.setState(`games.${gameId}.name`, gameData.name, true);
            await this.setState(`games.${gameId}.isPlaying`, true, true);
            await this.setState(`games.${gameId}.gameAppId`, gameData.appId, true);
            if (gameData.appId) {
                const newsItems = await this.getNewsForGame(gameData.appId);
                if (newsItems && newsItems.length > 0) {
                    await this.updateGameNews(gameId, newsItems[0]);
                }
            }
        } catch (error) {
            this.log.error(this._('Error adding new game: %s', error));
        }
    }

    async setupGames() {
        if (!this.config.gameList || !Array.isArray(this.config.gameList)) {
            this.log.info(this._('No games configured to monitor or invalid game list format.'));
            return;
        }

        try {
            await this.setObjectNotExistsAsync('games', {
                type: 'folder',
                common: { name: this._('Steam Games') },
                native: {},
            });

            let configUpdated = false;

            // Process each game in the configuration
            for (const game of this.config.gameList) {
                if (!game || typeof game !== 'object') {
                    this.log.warn(this._('Invalid game entry in configuration: %s', JSON.stringify(game)));
                    continue;
                }

                if (game.enabled) {
                    try {
                        let gameData = null;
                        let gameId = null;
                        let configNeedsUpdate = false;

                        if (game.appId && !isNaN(parseInt(game.appId)) && parseInt(game.appId) > 0) {
                            // If we have the AppID but missing the name, look it up
                            if (!game.gameName) {
                                this.log.info(`Looking up name for AppID ${game.appId}`);
                                gameData = await this.findGame(parseInt(game.appId), true);

                                if (gameData && gameData.name) {
                                    // Update config with the found name
                                    game.gameName = gameData.name;
                                    configNeedsUpdate = true;
                                    this.log.info(`Updated game name to ${gameData.name} for AppID ${game.appId}`);
                                }
                            } else {
                                gameData = { appId: parseInt(game.appId), name: game.gameName };
                            }
                        } else if (game.gameName) {
                            // If we have the name but missing the AppID, look it up
                            this.log.info(`Looking up AppID for game ${game.gameName}`);
                            gameData = await this.findGame(game.gameName, false);

                            if (gameData && gameData.appId) {
                                // Update config with the found AppID
                                game.appId = gameData.appId;
                                configNeedsUpdate = true;
                                this.log.info(`Updated AppID to ${gameData.appId} for game ${game.gameName}`);
                            }
                        }

                        if (configNeedsUpdate) {
                            configUpdated = true;
                        }

                        // Process the game as usual for state creation
                        if (gameData) {
                            gameId = gameData.name.replace(/[^a-zA-Z0-9]/g, '_');
                            await this.createGameStates(gameId, gameData.name);
                            await this.setState(`games.${gameId}.name`, gameData.name, true);
                            await this.setState(`games.${gameId}.isPlaying`, false, true);
                            if (gameData.appId) {
                                await this.setState(`games.${gameId}.gameAppId`, gameData.appId, true);
                            }

                            // Get news in non-blocking way
                            if (gameData.appId) {
                                this.fetchGameNewsNonBlocking(gameData.appId, gameId, gameData.name);
                            }
                        } else {
                            this.log.warn(`Could not find or process game: ${game.gameName || game.appId}`);
                        }
                    } catch (err) {
                        this.log.error(this._('Error processing game %s: %s', game.gameName || game.appId, err));
                    }
                }
            }

            // Update configuration if needed, but only after processing all games
            if (configUpdated) {
                try {
                    // Get current config
                    const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                    if (obj) {
                        // Update just the gameList without changing other configs
                        obj.native.gameList = this.config.gameList;

                        // Use setForeignObject with the noUpdate flag to prevent restart
                        await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj);
                        this.log.info('Updated game configuration with new information');
                    }
                } catch (err) {
                    this.log.error(`Failed to save updated game configuration: ${err}`);
                }
            }

            this.log.info('Game setup completed');
        } catch (error) {
            this.log.error(this._('Error during setupGames: %s', error));
        }
    }

    async fetchGameNewsNonBlocking(appId, gameId, gameName) {
        try {
            // Update timestamp directly
            if (!this._lastApiCallTime.newsForGame[appId]) {
                this._lastApiCallTime.newsForGame[appId] = 0;
            }
            this._lastApiCallTime.newsForGame[appId] = Date.now();

            const newsItems = await this.getNewsForGame(appId);
            if (newsItems && newsItems.length > 0) {
                await this.updateGameNews(gameId, newsItems[0]);
                this.log.debug(this._('Loaded initial news for %s', gameName));
            }
        } catch (error) {
            this.log.warn(this._('Could not load news for %s: %s', gameName, error));
            // Non-critical error, continue operation
        }
    }

    async updateGameNews(gameId, newsItem) {
        await this.setState(`games.${gameId}.news.lastTitle`, newsItem.title, true);
        await this.setState(`games.${gameId}.news.lastURL`, newsItem.url, true);
        await this.setState(`games.${gameId}.news.lastContent`, newsItem.contents, true);
        await this.setState(`games.${gameId}.news.lastDate`, newsItem.date, true);
    }

    async createOrUpdateState(stateName, value, type, name) {
        await this.setObjectNotExistsAsync(stateName, {
            type: 'state',
            common: {
                name: name,
                type: type,
                role: 'state',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setState(stateName, value, true);
    }

    async checkAndCreateStates() {
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: {
                name: this._('Device or Service connected'),
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('steamID64', {
            type: 'state',
            common: {
                name: this._('Steam ID64'),
                type: 'string',
                role: 'state',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.dailyRequestCount', {
            type: 'state',
            common: {
                name: this._('Daily Request Count'),
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.dailyRequestCountReset', {
            type: 'state',
            common: {
                name: this._('Daily Request Count Reset'),
                type: 'string',
                role: 'value.time',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
    }

    async findGame(searchTerm, isAppId = false) {
        try {
            if (!this.steamAppList || Date.now() - this.lastAppListFetch > TIMER_CONFIG.APP_LIST_REFRESH_MS) {
                await this.fetchSteamAppList();
            }

            if (!this.steamAppList) {
                this.log.error(this._('Steam app list not available'));
                return null;
            }

            let game = null;

            if (isAppId) {
                // Convert to number if needed
                const appId = typeof searchTerm === 'string' ? parseInt(searchTerm, 10) : searchTerm;
                game = this.steamAppList.find(app => app.appid === appId);
                if (game) {
                    this.log.debug(this._('Found game by AppID %s: %s', appId, game.name));
                    return { appId: game.appid, name: game.name };
                }
            } else {
                // Text search
                const searchName = searchTerm.toLowerCase();

                // Try exact match first
                game = this.steamAppList.find(app => app.name.toLowerCase() === searchName);
                if (game) {
                    this.log.debug(this._('Found exact match: %s', game.name));
                    return { appId: game.appid, name: game.name };
                }

                // Try partial match
                game = this.steamAppList.find(app => app.name.toLowerCase().includes(searchName));
                if (game) {
                    this.log.debug(this._('Found partial match: %s', game.name));
                    return { appId: game.appid, name: game.name };
                }

                // Suggest similar games
                this.warnSimilarGames(searchTerm);
            }

            return null;
        } catch (error) {
            this.log.error(this._('Error searching for game: %s', error));
            return null;
        }
    }

    async fetchSteamAppList() {
        try {
            this.logApiInfo('fetchSteamAppList', 'Fetching Steam app list...');

            // Update timestamp to prevent multiple simultaneous requests
            this._lastApiCallTime.appList = Date.now();

            const response = await this.apiRequest(API_ENDPOINTS.GET_APP_LIST, {
                format: 'json',
            });

            if (
                response.status === 200 &&
                response.data &&
                response.data.applist &&
                response.data.applist.apps &&
                Array.isArray(response.data.applist.apps)
            ) {
                this.steamAppList = response.data.applist.apps
                    .filter(app => app.name && app.name.trim() !== '')
                    .sort((a, b) => a.name.localeCompare(b.name));
                this.lastAppListFetch = Date.now();
                this.logApiInfo('fetchSteamAppList', `Successfully fetched ${this.steamAppList.length} Steam apps`);
                return this.steamAppList;
            }
            this.logApiError(
                'fetchSteamAppList',
                new Error('Invalid response format'),
                'Failed to fetch Steam app list',
            );
            return null;
        } catch (error) {
            this.logApiError('fetchSteamAppList', error, 'Error fetching Steam app list');
            return null;
        }
    }

    async getNewsForGame(appId, count, maxLength) {
        // Update timestamp directly
        if (!this._lastApiCallTime.newsForGame[appId]) {
            this._lastApiCallTime.newsForGame[appId] = 0;
        }
        this._lastApiCallTime.newsForGame[appId] = Date.now();

        return this.safeApiCall(
            async () => {
                const response = await this.apiRequest(API_ENDPOINTS.GET_NEWS_FOR_APP, {
                    appid: appId,
                    count: count || 3,
                    maxlength: maxLength || 300,
                    format: 'json',
                });

                if (
                    response.status === 200 &&
                    response.data &&
                    response.data.appnews &&
                    response.data.appnews.newsitems &&
                    response.data.appnews.newsitems.length > 0
                ) {
                    return response.data.appnews.newsitems;
                }
                this.log.debug(this._('No news items found for appId: %s', appId));
                return [];
            },
            [],
            'Error fetching news for game %s: %s',
            appId,
        );
    }

    async updateAllGamesNews() {
        try {
            const gameChannels = await this.getChannelsOfAsync('games');
            for (const channel of gameChannels) {
                const gameId = channel._id.split('.').pop();
                const appIdState = await this.getStateAsync(`games.${gameId}.gameAppId`);
                if (appIdState && typeof appIdState.val === 'number' && appIdState.val > 0) {
                    const appId = appIdState.val;

                    // Update timestamp directly
                    if (!this._lastApiCallTime.newsForGame[appId]) {
                        this._lastApiCallTime.newsForGame[appId] = 0;
                    }
                    this._lastApiCallTime.newsForGame[appId] = Date.now();

                    const newsItems = await this.getNewsForGame(appId);
                    if (newsItems && newsItems.length > 0) {
                        await this.updateGameNews(gameId, newsItems[0]);
                        this.log.debug(this._('Updated news for %s', channel.common.name));
                    }
                }
            }
        } catch (error) {
            this.log.error(this._('Error updating games news: %s', error));
        }
    }

    async fetchRecentlyPlayed() {
        // Exit early if we're shutting down
        if (this.isShuttingDown) {
            return false;
        }

        // Check cooldown to prevent frequent API calls
        const now = Date.now();
        const lastCallTime = this._lastApiCallTime.recentlyPlayed || 0;
        const timeSinceLastCall = now - lastCallTime;

        // If called too soon after previous call, skip this request
        if (timeSinceLastCall < TIMER_CONFIG.RECENTLY_PLAYED_COOLDOWN_MS) {
            this.logApiDebug(
                'fetchRecentlyPlayed',
                `Skipping API call - cooldown active (${Math.round(timeSinceLastCall / 1000)}s elapsed, need ${Math.round(TIMER_CONFIG.RECENTLY_PLAYED_COOLDOWN_MS / 1000)}s)`,
            );
            return false;
        }

        // Update timestamp directly
        this._lastApiCallTime.recentlyPlayed = Date.now();

        // Use a flag to prevent multiple concurrent fetches
        if (this._fetchingRecentlyPlayed) {
            this.logApiDebug('fetchRecentlyPlayed', 'Already in progress, skipping');
            return false;
        }

        this._fetchingRecentlyPlayed = true;

        try {
            // Use class-level steamID64 instead of fetching from state
            if (!this.steamID64) {
                this.logApiError('fetchRecentlyPlayed', new Error('Steam ID not available in memory'));
                return false;
            }

            this.logApiDebug('fetchRecentlyPlayed', `Fetching player data using Steam ID from state`);
            const response = await this.apiRequest(API_ENDPOINTS.GET_RECENTLY_PLAYED, {
                key: this.config.apiKey,
                steamid: this.steamID64,
            });

            // Only process data if we have a valid response
            if (
                response &&
                response.data &&
                response.data.response &&
                response.data.response.games &&
                Array.isArray(response.data.response.games)
            ) {
                const games = response.data.response.games;

                // Process each game with the full data processing
                for (const game of games) {
                    await this.processOwnedGame(game);
                }

                return true;
            }
            this.log.debug('No recently played games found or invalid response format');
            return false;
        } catch (error) {
            this.log.error(`Error fetching recently played games: ${error}`);
            return false;
        } finally {
            this._fetchingRecentlyPlayed = false;
        }
    }

    async createRecentlyPlayedGameStates(gameName) {
        // First ensure the parent folder structure exists
        await this.setObjectNotExistsAsync('recentlyPlayed', {
            type: 'folder',
            common: { name: this._('Recently Played') },
            native: {},
        });

        await this.setObjectNotExistsAsync('recentlyPlayed.games', {
            type: 'folder',
            common: { name: this._('Games') },
            native: {},
        });

        // Create states for this specific game, using game name instead of ID
        const safeGameName = gameName.replace(/[^a-zA-Z0-9]/g, '_');

        await this.setObjectNotExistsAsync(`recentlyPlayed.games.${safeGameName}`, {
            type: 'channel',
            common: { name: gameName },
            native: {},
        });

        // Create basic game info states
        await this.setObjectNotExistsAsync(`recentlyPlayed.games.${safeGameName}.name`, {
            type: 'state',
            common: {
                name: this._('Game Name'),
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`recentlyPlayed.games.${safeGameName}.appId`, {
            type: 'state',
            common: {
                name: this._('Game App ID'),
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        // Playtime states
        await this.setObjectNotExistsAsync(`recentlyPlayed.games.${safeGameName}.playtime_2weeks`, {
            type: 'state',
            common: {
                name: this._('Playtime (2 weeks)'),
                type: 'number',
                role: 'value',
                unit: 'min',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`recentlyPlayed.games.${safeGameName}.playtime_forever`, {
            type: 'state',
            common: {
                name: this._('Playtime (total)'),
                type: 'number',
                role: 'value',
                unit: 'min',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`recentlyPlayed.games.${safeGameName}.last_played`, {
            type: 'state',
            common: {
                name: this._('Last Played'),
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
            },
            native: {},
        });
    }

    async processRecentlyPlayedGame(gameData) {
        try {
            const gameName = gameData.name || `Unknown Game (${gameData.appid})`;
            const safeGameName = gameName.replace(/[^a-zA-Z0-9]/g, '_');

            // Create the states in the recentlyPlayed folder
            await this.createRecentlyPlayedGameStates(gameName);

            // Update the game data in recentlyPlayed
            await this.setState(`recentlyPlayed.games.${safeGameName}.name`, gameName, true);
            await this.setState(`recentlyPlayed.games.${safeGameName}.appId`, gameData.appid, true);
            await this.setState(
                `recentlyPlayed.games.${safeGameName}.last_played`,
                Math.floor(Date.now() / 1000),
                true,
            );

            // Update playtime if available
            if (gameData.playtime_2weeks !== undefined) {
                await this.setState(
                    `recentlyPlayed.games.${safeGameName}.playtime_2weeks`,
                    gameData.playtime_2weeks,
                    true,
                );
            }

            if (gameData.playtime_forever !== undefined) {
                await this.setState(
                    `recentlyPlayed.games.${safeGameName}.playtime_forever`,
                    gameData.playtime_forever,
                    true,
                );
            }
        } catch (error) {
            this.log.warn(`Error processing recently played game ${gameData.appid}: ${error}`);
        }
    }

    warnSimilarGames(gameName) {
        // Überprüfe, ob Funktionalität aktiviert ist
        if (!this.config.enableGameSuggestions) {
            this.logApiInfo('warnSimilarGames', 'Game suggestions disabled in config');
            return;
        }

        if (!this.steamAppList) {
            this.logApiWarning('warnSimilarGames', 'No Steam app list available for suggestions');
            return;
        }

        const search = gameName.toLowerCase();

        // Helper to calculate Levenshtein distance
        function levenshtein(a, b) {
            if (a.length === 0) {
                return b.length;
            }
            if (b.length === 0) {
                return a.length;
            }

            const matrix = [];
            for (let i = 0; i <= b.length; i++) {
                matrix[i] = [i];
            }
            for (let j = 0; j <= a.length; j++) {
                matrix[0][j] = j;
            }

            for (let i = 1; i <= b.length; i++) {
                for (let j = 1; j <= a.length; j++) {
                    const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j] + 1, // deletion
                        matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j - 1] + cost, // substitution
                    );
                }
            }
            return matrix[b.length][a.length];
        }

        // Reduziere die zu verarbeitende Menge für bessere Performance
        const sampleSize = 250000;
        let gamesToCheck = this.steamAppList;

        // Wenn die Liste zu groß ist, verwende ein Sampling
        if (gamesToCheck.length > sampleSize) {
            const randomIndices = new Set();
            while (randomIndices.size < sampleSize) {
                randomIndices.add(Math.floor(Math.random() * this.steamAppList.length));
            }
            gamesToCheck = Array.from(randomIndices).map(i => this.steamAppList[i]);
        }

        // Finde die 5 Spiele mit der geringsten Levenshtein-Distanz
        const similarGames = gamesToCheck
            .filter(app => app.name && app.name.trim() !== '')
            .map(app => ({
                name: app.name,
                appid: app.appid,
                distance: levenshtein(search, app.name.toLowerCase()),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 5);

        if (similarGames.length > 0) {
            const similarList = similarGames.map(app => `${app.name} (AppID: ${app.appid})`);
            this.logApiWarning(
                'warnSimilarGames',
                'No games found matching: %s. Did you mean: %s',
                gameName,
                similarList.join(', '),
            );
        } else {
            this.logApiWarning('warnSimilarGames', 'No games found matching: %s. No similar games found.', gameName);
        }
    }

    async updateActiveGame() {
        try {
            // Add cooldown to prevent excessive updates
            const now = Date.now();
            const elapsed = now - this._lastActiveGameUpdate;

            if (elapsed < this._activeGameUpdateCooldown) {
                this.log.debug(
                    `Active game update skipped - cooldown active (${Math.round(elapsed / 1000)}s elapsed, need ${Math.round(this._activeGameUpdateCooldown / 1000)}s)`,
                );
                return false;
            }

            // Get the current game name
            const currentGameState = await this.getStateAsync('currentGame');
            if (!currentGameState || !currentGameState.val) {
                return false;
            }

            const currentGame = currentGameState.val;
            const safeGameName = currentGame.replace(/[^a-zA-Z0-9]/g, '_');

            // Check if this game exists in our states
            const gameExists = await this.getObjectAsync(`games.${safeGameName}`);
            if (!gameExists) {
                this.log.debug(`Game ${currentGame} not found in states, cannot update`);
                return false;
            }

            // Get the current appId
            const appIdState = await this.getStateAsync(`games.${safeGameName}.gameAppId`);
            if (!appIdState || !appIdState.val) {
                this.log.debug(`No AppID available for ${currentGame}, cannot update`);
                return false;
            }

            const appId = appIdState.val;

            // Update the timestamp
            this._lastActiveGameUpdate = now;

            // Make a direct API call for this specific game only
            this.log.info(`Updating active game data for ${currentGame} (${appId})`);

            // First prioritize playtime info from recently played games
            const response = await this.apiRequest(API_ENDPOINTS.GET_RECENTLY_PLAYED, {
                key: this.config.apiKey,
                steamid: this.steamID64,
                count: 1, // Limit to just 1 game to reduce payload size
            });

            if (
                response &&
                response.data &&
                response.data.response &&
                response.data.response.games &&
                Array.isArray(response.data.response.games)
            ) {
                // Find this specific game in the response
                const gameData = response.data.response.games.find(g => g.appid == appId);

                if (gameData) {
                    // Make sure to set isPlaying explicitly
                    await this.setState(`games.${safeGameName}.isPlaying`, true, true);

                    // Update game data
                    await this.processOwnedGame(gameData);

                    this.log.debug(`Successfully updated active game: ${currentGame}`);
                    return true;
                }
            }

            this.log.debug(`Could not find ${currentGame} in recently played API response`);
            return false;
        } catch (error) {
            this.log.warn(`Error updating active game data: ${error}`);
            return false;
        }
    }

    async onUnload(callback) {
        try {
            // First flag we're shutting down to prevent new requests
            this.isShuttingDown = true;
            this.setConnected(false);
            this.log.info('Graceful shutdown started');

            // Cancel all pending requests in queue
            this._requestQueue.forEach(item => {
                item.reject(new Error('Adapter is shutting down'));
            });
            this._requestQueue = [];

            // Wait for any active requests to finish (with timeout)
            const shutdownTimeout = setTimeout(() => {
                this.log.warn('Force shutdown - some requests did not complete in time');
            }, TIMER_CONFIG.FORCE_SHUTDOWN_TIMEOUT_MS);

            // Clear all intervals first
            [
                this.resetTimeout,
                this.newsInterval,
                this.recentlyPlayedInterval,
                this.playerSummaryInterval,
                ...this._apiTimeouts,
            ].forEach(timer => {
                if (timer) {
                    clearTimeout(timer);
                }
            });

            clearTimeout(shutdownTimeout);
            this.log.info('Shutdown complete');
            callback();
        } catch (e) {
            this.log.error(`Error during unload: ${e}`);
            callback();
        }
    }

    async onStateChange(id, state) {
        if (state) {
            this.log.debug(`State ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            this.log.debug(`State ${id} deleted`);
        }

        // Simplified approach for handling game state changes
        if (id === `${this.namespace}.currentGame` && state && state.ack) {
            const currentGame = state.val;
            const gameChannels = await this.getChannelsOfAsync('games');

            // Reset all games to not playing
            for (const channel of gameChannels) {
                const gameId = channel._id.split('.').pop();
                await this.setState(`games.${gameId}.isPlaying`, false, true);
            }

            // If there's a current game, find and set it to playing
            if (currentGame) {
                const safeGameName = currentGame.replace(/[^a-zA-Z0-9]/g, '_');
                const gameObj = await this.getObjectAsync(`games.${safeGameName}`);
                if (gameObj) {
                    await this.setState(`games.${safeGameName}.isPlaying`, true, true);
                }
            }
        }
    }

    async onMessage(obj) {
        if (obj.command === 'test') {
            this.log.info(this._('Test message: %s', obj.message));
            if (obj.callback) {
                this.sendTo(obj.from, obj.callback, {
                    result: this._('Test message received'),
                    error: null,
                });
            }
        }
    }

    setConnected(connected) {
        this.setState('info.connection', connected, true);
    }

    _(text, ...args) {
        if (!args.length) {
            return text;
        }
        return text.replace(/%s/g, () => args.shift());
    }

    // Helper for consistent logging
    logWithFormat(level, method, message, ...args) {
        const formattedMsg = this._(`[${method}] ${message}`, ...args);
        this.log[level](formattedMsg);
    }

    logApiDebug(method, message, ...args) {
        this.logWithFormat('debug', method, message, ...args);
    }

    logApiInfo(method, message, ...args) {
        this.logWithFormat('info', method, message, ...args);
    }

    logApiWarning(method, message, ...args) {
        this.logWithFormat('warn', method, message, ...args);
    }

    logApiError(method, error, message = 'API error') {
        let detailedMessage = message;

        if (error.response) {
            detailedMessage += `: ${error.response.status} - ${error.response.statusText || 'Unknown'}`;
            if (error.response.data && error.response.data.error) {
                detailedMessage += ` (${error.response.data.error})`;
            }
        } else if (error.request) {
            detailedMessage += ': No response received';
            if (error.code) {
                detailedMessage += ` (${error.code})`;
            }
        } else {
            detailedMessage += `: ${error.message || 'Unknown error'}`;
        }

        this.logWithFormat('error', method, detailedMessage);
    }
}
if (require.main !== module) {
    module.exports = options => new Steam(options);
} else {
    new Steam();
}
