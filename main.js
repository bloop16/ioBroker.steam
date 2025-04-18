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

        this._lastApiCallTime = {
            playerSummary: 0,
            recentlyPlayed: 0,
            newsForGame: {},
            appList: 0,
        };

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
        this._initialStartup = true; // Add this flag for tracking initial startup

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

    async fetchAndSetData(apiKey, steamID64, retryCount = 0) {
        if (this.isFetchingPlayerSummary) {
            this.logApiDebug('fetchAndSetData', 'Request skipped because another is running');
            return;
        }
        this.isFetchingPlayerSummary = true;
        try {
            if (this.dailyRequestCount < 8000) {
                // Use the class-level steamID64 variable instead of fetching from state
                if (!this.steamID64) {
                    this.logApiError('fetchAndSetData', new Error('Steam ID not available in memory'));
                    return;
                }
                await this.getPlayerSummaries(apiKey, this.steamID64);
                this.dailyRequestCount++;
                await this.setState('info.dailyRequestCount', this.dailyRequestCount, true);
            } else {
                this.logApiWarning('fetchAndSetData', 'Daily API request limit reached');
            }
        } catch (error) {
            this.logApiError('fetchAndSetData', error, 'Error fetching data');
            if (error.response && error.response.status === 429) {
                const waitTime = Math.pow(2, retryCount || 0) * RATE_LIMIT_CONFIG.RETRY_BASE_TIME;
                this.logApiWarning('fetchAndSetData', 'Rate limit exceeded. Retrying in %s minutes.', waitTime / 60000);
                setTimeout(() => {
                    this.fetchAndSetData(apiKey, null, (retryCount || 0) + 1);
                }, waitTime);
            }
        } finally {
            this.isFetchingPlayerSummary = false;
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

            // Skip updating configuration during adapter runtime
            // Just create states and fetch initial data
            for (const game of this.config.gameList) {
                if (!game || typeof game !== 'object') {
                    this.log.warn(this._('Invalid game entry in configuration: %s', JSON.stringify(game)));
                    continue;
                }

                if (game.enabled) {
                    try {
                        // Use existing data without updating configuration
                        let gameData = null;
                        let gameId = null;

                        if (game.appId && !isNaN(parseInt(game.appId)) && parseInt(game.appId) > 0) {
                            // Use existing game name if available, or find it
                            if (game.gameName) {
                                gameData = { appId: parseInt(game.appId), name: game.gameName };
                            } else {
                                gameData = await this.findGame(parseInt(game.appId), true);
                            }
                        } else if (game.gameName) {
                            // Only lookup app ID if needed for API calls but don't update config
                            if (!this._initialStartup) {
                                // Skip intensive lookups on first run
                                gameData = await this.findGame(game.gameName, false);
                            }
                        }

                        if (gameData) {
                            gameId = gameData.name.replace(/[^a-zA-Z0-9]/g, '_');
                            await this.createGameStates(gameId, gameData.name);
                            await this.setState(`games.${gameId}.name`, gameData.name, true);
                            await this.setState(`games.${gameId}.isPlaying`, false, true);
                            if (gameData.appId) {
                                await this.setState(`games.${gameId}.gameAppId`, gameData.appId, true);
                            }

                            // Get news in non-blocking way, but only if we have an app ID
                            if (gameData.appId && !this._initialStartup) {
                                this.fetchGameNewsNonBlocking(gameData.appId, gameId, gameData.name);
                            }
                        }
                    } catch (err) {
                        this.log.error(this._('Error processing game %s: %s', game.gameName || game.appId, err));
                    }
                }
            }

            // Never save configuration changes during runtime
            this.log.info('Game setup completed without modifying configuration');
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

                // Process each game
                for (const game of games) {
                    await this.processRecentlyPlayedGame(game);
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
        if (this.log.level === 'debug') {
            if (state) {
                this.log.debug(this._('State %s changed: %s (ack = %s)', id, state.val, state.ack));
            } else {
                this.log.debug(this._('State %s deleted', id));
            }
        }

        // Check if playerState has changed and is acknowledged
        if (id === `${this.namespace}.playerState` && state && state.ack) {
            this.log.info(`Player state changed to ${state.val}, triggering recently played fetch`);

            // Add a small delay to allow Steam to update their data
            setTimeout(async () => {
                try {
                    await this.fetchRecentlyPlayed();
                } catch (e) {
                    this.log.error(`Error fetching recently played after state change: ${e}`);
                }
            }, 5000); // 5 second delay
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
