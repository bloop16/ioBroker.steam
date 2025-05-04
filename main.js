'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

const API_BASE_URL = 'https://api.steampowered.com';
const API_ENDPOINTS = {
    RESOLVE_VANITY_URL: `${API_BASE_URL}/ISteamUser/ResolveVanityURL/v0001/`,
    GET_PLAYER_SUMMARIES: `${API_BASE_URL}/ISteamUser/GetPlayerSummaries/v2/`,
    GET_APP_LIST: `${API_BASE_URL}/ISteamApps/GetAppList/v0002/`,
    GET_NEWS_FOR_APP: `${API_BASE_URL}/ISteamNews/GetNewsForApp/v0002/`,
    GET_OWNED_GAMES: `${API_BASE_URL}/IPlayerService/GetOwnedGames/v0001/`,
    GET_RECENTLY_PLAYED_GAMES: `${API_BASE_URL}/IPlayerService/GetRecentlyPlayedGames/v0001/`,
};

const RATE_LIMIT_CONFIG = { REQUEST_TIMEOUT: 20000 };
const TIMER_CONFIG = {
    NEWS_UPDATE_INTERVAL_MS: 6 * 60 * 60 * 1000,
    MIN_PLAYER_SUMMARY_INTERVAL_SEC: 15,
    RECENTLY_PLAYED_INTERVAL_MS: 15 * 60 * 1000,
    NEWS_FETCH_COOLDOWN_MS: 60 * 60 * 1000,
    STARTUP_NEWS_DELAY_MS: 2000,
    STARTUP_PLAYER_SUMMARY_DELAY_MS: 10000,
    API_JITTER_MAX_MS: 5000,
    RECENTLY_FETCHED_RESET_MS: 30000,
    APP_LIST_REFRESH_MS: 86400000,
    FORCE_SHUTDOWN_TIMEOUT_MS: 2000,
    RATE_LIMIT_BACKOFF_MS: 120000,
};

// --- Helper methods for state/channel/folder creation ---
async function ensureState(adapter, id, common, value) {
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
    if (value !== undefined) {
        const oldState = await adapter.getStateAsync(id);
        if (!oldState || oldState.val !== value) {
            await adapter.setState(id, value, true);
        }
    }
}

async function ensureChannel(adapter, id, name) {
    await adapter.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
}

async function ensureFolder(adapter, id, name) {
    await adapter.setObjectNotExistsAsync(id, { type: 'folder', common: { name }, native: {} });
}

class Steam extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'steam' });
        this._activeRequests = 0;
        this._maxConcurrentRequests = 3;
        this._requestQueue = [];
        this.dailyRequestCount = 0;
        this.resetTimeout = null;
        this.steamAppList = null;
        this.lastAppListFetch = 0;
        this.steamID64 = null;
        this.playerSummaryInterval = null;
        this.isFetchingPlayerSummary = false;
        this.isShuttingDown = false;
        this._apiTimeouts = [];
        this._lastApiCallTime = { playerSummary: 0, newsForGame: {}, appList: 0, ownedGames: 0 };
        this._consecutiveRateLimits = 0;
        this._lastRateLimitTime = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    async executeRequest(requestFunction) {
        if (this.isShuttingDown) {
            return null;
        }
        if (this._activeRequests >= this._maxConcurrentRequests) {
            return new Promise((resolve, reject) => this._requestQueue.push({ fn: requestFunction, resolve, reject }));
        }
        this._activeRequests++;
        try {
            const result = await requestFunction();
            this._consecutiveRateLimits = 0;
            return result;
        } finally {
            this._activeRequests--;
            if (this._requestQueue.length && this._activeRequests < this._maxConcurrentRequests) {
                const next = this._requestQueue.shift();
                this.executeRequest(next.fn).then(next.resolve).catch(next.reject);
            }
        }
    }

    async onReady() {
        this.isShuttingDown = false;
        this._apiTimeouts = [];
        await this.checkAndCreateStates();
        const apiKey = this.config.apiKey,
            steamName = this.config.steamName;
        if (!apiKey || !steamName) {
            this.log.error('API key and Steam name are required.');
            this.setConnected(false);
            return;
        }
        try {
            const storedSteamIdObj = await this.getStateAsync('steamID64');
            const storedSteamNameObj = await this.getStateAsync('steamName');
            if (!storedSteamIdObj?.val || !storedSteamNameObj?.val || storedSteamNameObj.val !== steamName) {
                const steamID64 = await this.resolveSteamID(steamName);
                if (!steamID64) {
                    this.log.error('Could not resolve Steam ID.');
                    this.setConnected(false);
                    return;
                }
                this.steamID64 = steamID64;
                await ensureState(
                    this,
                    'steamID64',
                    { name: 'Steam ID 64', type: 'string', role: 'state', read: true, write: false },
                    steamID64,
                );
                await ensureState(
                    this,
                    'steamName',
                    { name: 'Steam Name', type: 'string', role: 'state', read: true, write: false },
                    steamName,
                );
            } else {
                this.steamID64 = storedSteamIdObj.val;
            }
            if (this.config.enableOwnedGames) {
                await this.getOwnedGamesAndUpdateConfig();
            }
            await this.setupGames();
            await this.resetDailyRequestCount();
            this.setConnected(true);

            this._apiTimeouts.push(
                this.setTimeout(() => this.schedulePlayerSummary(), TIMER_CONFIG.STARTUP_PLAYER_SUMMARY_DELAY_MS),
            );

            if (this.config.apiKey && this.steamID64) {
                await this.fetchAndSetData(this.config.apiKey);
                await this.fetchRecentlyPlayedGames();
                await this.updateAllGamesNews();
            }
        } catch (error) {
            this.log.error('Error during initialization:', error);
            this.setConnected(false);
        }
    }

    schedulePlayerSummary() {
        if (this.playerSummaryInterval) {
            this.clearTimeout(this.playerSummaryInterval);
        }
        let intervalSec = parseInt(this.config.playerSummaryIntervalSec, 10) || 60;
        if (intervalSec < TIMER_CONFIG.MIN_PLAYER_SUMMARY_INTERVAL_SEC) {
            intervalSec = TIMER_CONFIG.MIN_PLAYER_SUMMARY_INTERVAL_SEC;
        }
        const baseIntervalMs = intervalSec * 1000;
        const jitter =
            Math.floor(Math.random() * (TIMER_CONFIG.API_JITTER_MAX_MS * 2)) - TIMER_CONFIG.API_JITTER_MAX_MS;
        let backoffMs = 0;
        if (this._lastRateLimitTime && Date.now() - this._lastRateLimitTime < TIMER_CONFIG.RATE_LIMIT_BACKOFF_MS) {
            backoffMs = TIMER_CONFIG.RATE_LIMIT_BACKOFF_MS;
        }
        const nextIntervalMs = baseIntervalMs + jitter + backoffMs;
        this.playerSummaryInterval = this.setTimeout(async () => {
            try {
                if (this.dailyRequestCount < 99000) {
                    await this.fetchAndSetData(this.config.apiKey);
                }
            } catch (e) {
                this.log.error(e);
            }
            if (!this.isShuttingDown) {
                this.schedulePlayerSummary();
            }
        }, nextIntervalMs);
        this._apiTimeouts.push(this.playerSummaryInterval);
    }

    async onUnload(callback) {
        let forceShutdownTimer,
            waitIntervalId = null;
        try {
            this.isShuttingDown = true;
            this.setConnected(false);
            this.log.info('Graceful shutdown started.');
            this._requestQueue.forEach(item => item.reject(new Error('Adapter is shutting down.')));
            this._requestQueue = [];
            forceShutdownTimer = setTimeout(() => {
                if (waitIntervalId) {
                    clearInterval(waitIntervalId);
                }
                cleanupCompleted();
            }, TIMER_CONFIG.FORCE_SHUTDOWN_TIMEOUT_MS);
            let shutdownCompleted = false;
            const cleanupCompleted = () => {
                if (shutdownCompleted) {
                    return;
                }
                shutdownCompleted = true;
                if (forceShutdownTimer) {
                    clearTimeout(forceShutdownTimer);
                }
                if (waitIntervalId) {
                    clearInterval(waitIntervalId);
                }
                this.log.info('Shutdown complete.');
                callback();
            };
            [this.resetTimeout, this.playerSummaryInterval].forEach(timer => timer && this.clearTimeout(timer));
            this._apiTimeouts.forEach(timer => {
                if (timer) {
                    this.clearTimeout(timer);
                    this.clearInterval(timer);
                }
            });
            this._apiTimeouts = [];
            if (this._activeRequests > 0) {
                this.log.info(`Waiting for ${this._activeRequests} active requests to complete...`);
                waitIntervalId = setInterval(() => {
                    if (this._activeRequests <= 0) {
                        cleanupCompleted();
                    }
                }, 100);
            } else {
                cleanupCompleted();
            }
        } catch (e) {
            this.log.error('Error during unload:', e);
            if (forceShutdownTimer) {
                clearTimeout(forceShutdownTimer);
            }
            callback();
        }
    }

    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }
        switch (obj.command) {
            case 'getOwnedGames':
                await this.getOwnedGamesAndUpdateConfig();
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { result: 'ok' }, obj.callback);
                }
                break;
            case 'addToWatchedGames':
                if (obj.message && Array.isArray(obj.message.selectedOwnedGames)) {
                    const selectedAppIds = obj.message.selectedOwnedGames.map(Number);
                    const availableGames = this.config.availableGames || [];
                    const watchedGames = this.config.gameList || [];
                    let updated = false;

                    for (const appId of selectedAppIds) {
                        if (!watchedGames.find(g => Number(g.appId) === appId)) {
                            const game = availableGames.find(g => Number(g.appId) === appId);
                            if (game) {
                                watchedGames.push({
                                    gameName: game.gameName,
                                    appId: game.appId,
                                    enabled: true,
                                });
                                updated = true;
                            }
                        }
                    }
                    if (updated) {
                        const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                        if (obj) {
                            obj.native.gameList = watchedGames;
                            await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj, {
                                noUpdate: true,
                            });
                            this.log.info('Added selected games to Watched Games.');
                        }
                    }
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, {}, obj.callback);
                }
                break;
            default:
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, {}, obj.callback);
                }
                break;
        }
    }

    async onStateChange(id, state) {
        if (!state) {
            return;
        }
        if (state && !state.ack && id.includes('.isPlaying')) {
            const gameIdMatch = id.match(/games\.([^.]+)\.isPlaying/);
            if (gameIdMatch && gameIdMatch[1]) {
                const gameId = gameIdMatch[1];
                try {
                    if (state.val === true) {
                        const gameNameState = await this.getStateAsync(`games.${gameId}.name`);
                        const gameAppIdState = await this.getStateAsync(`games.${gameId}.gameAppId`);
                        if (gameNameState?.val && gameAppIdState?.val) {
                            await ensureState(
                                this,
                                'currentGame',
                                { name: 'Current Game', type: 'string', role: 'state', read: true, write: false },
                                gameNameState.val,
                            );
                            await ensureState(
                                this,
                                'currentGameAppId',
                                { name: 'Current Game AppID', type: 'number', role: 'state', read: true, write: false },
                                gameAppIdState.val,
                            );
                        }
                    } else {
                        const currentGameState = await this.getStateAsync('currentGame');
                        const gameNameState = await this.getStateAsync(`games.${gameId}.name`);
                        if (currentGameState?.val && gameNameState?.val && currentGameState.val === gameNameState.val) {
                            await ensureState(
                                this,
                                'currentGame',
                                { name: 'Current Game', type: 'string', role: 'state', read: true, write: false },
                                '',
                            );
                            await ensureState(
                                this,
                                'currentGameAppId',
                                { name: 'Current Game AppID', type: 'number', role: 'state', read: true, write: false },
                                0,
                            );
                        }
                    }
                    await ensureState(
                        this,
                        id,
                        { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                        !!state.val,
                    );
                } catch (error) {
                    this.log.error(`Error handling manual isPlaying change for ${id}: ${error}`);
                    try {
                        await ensureState(
                            this,
                            id,
                            { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                            !!state.val,
                        );
                    } catch (error) {
                        this.log.error(`Error handling manual isPlaying change for ${id}: ${error}`);
                    }
                }
                return;
            }
        }
        if (state && state.ack) {
            const ownNamespace = `${this.namespace}.`;
            if (id === `${ownNamespace}currentGameAppId`) {
                await this.handleCurrentGameAppIdChange(state.val);
            } else if (id === `${ownNamespace}currentGame`) {
                if (!state.val || (typeof state.val === 'string' && state.val.trim() === '')) {
                    await this.handleGameStopped();
                } else {
                    await this.handleCurrentGameChange(state.val);
                }
            }
        }
    }

    async handleCurrentGameAppIdChange(appId) {
        try {
            const gameChannels = await this.getChannelsOfAsync('games');
            for (const channel of gameChannels) {
                const gameId = channel._id.split('.').pop();
                await ensureState(
                    this,
                    `games.${gameId}.isPlaying`,
                    { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                    false,
                );
            }
            if (appId && appId > 0) {
                for (const channel of gameChannels) {
                    const gameId = channel._id.split('.').pop();
                    const gameAppIdState = await this.getStateAsync(`games.${gameId}.gameAppId`);
                    if (gameAppIdState && Number(gameAppIdState.val) === Number(appId)) {
                        await ensureState(
                            this,
                            `games.${gameId}.isPlaying`,
                            { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                            true,
                        );
                        await this.fetchRecentlyPlayedGames();
                        this.log.debug(`Set game ${gameId} as currently playing (AppID: ${appId})`);
                        break;
                    }
                }
            }
        } catch (error) {
            this.log.error(`Error in handleCurrentGameAppIdChange: ${error}`);
        }
    }

    async handleGameStopped() {
        try {
            this.log.info('Resetting all games to not playing.');

            const gameChannels = await this.getChannelsOfAsync('games');
            if (!gameChannels || gameChannels.length === 0) {
                this.log.warn('No game channels found to reset.');
                return;
            }

            const knownGames = [];
            for (const channel of gameChannels) {
                const channelParts = channel._id.split('.');
                if (channelParts.length === 4 && channelParts[2] === 'games') {
                    knownGames.push(channelParts[3]);
                }
            }

            this.log.debug(`Found ${knownGames.length} games to check for reset: ${knownGames.join(', ')}`);

            let hasReset = false;
            for (const gameId of knownGames) {
                try {
                    const isPlayingState = await this.getStateAsync(`games.${gameId}.isPlaying`);
                    if (isPlayingState && isPlayingState.val === true) {
                        this.log.warn(`Resetting isPlaying state for game ${gameId}`);
                        await ensureState(
                            this,
                            `games.${gameId}.isPlaying`,
                            { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                            false,
                        );
                        hasReset = true;
                    }
                } catch (e) {
                    this.log.error(`Error resetting game ${gameId}:`, e);
                }
            }

            if (!hasReset) {
                this.log.info('No games were marked as playing.');
            }
        } catch (error) {
            this.log.error(`Error in handleGameStopped: ${error.stack || error}`);
        }
    }

    async handleCurrentGameChange(currentGame) {
        try {
            const gameChannels = await this.getChannelsOfAsync('games');
            for (const channel of gameChannels) {
                const gameId = channel._id.split('.').pop();
                await ensureState(
                    this,
                    `games.${gameId}.isPlaying`,
                    { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                    false,
                );
            }

            const safeGameName = currentGame.replace(/[^a-zA-Z0-9]/g, '_');
            const gameObj = await this.getObjectAsync(`games.${safeGameName}`);
            if (gameObj) {
                await ensureState(
                    this,
                    `games.${safeGameName}.isPlaying`,
                    { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                    true,
                );
                this.log.debug(`Set ${currentGame} as currently playing game`);
            }
        } catch (error) {
            this.log.error(`Error in handleCurrentGameChange: ${error}`);
        }
    }

    setConnected(connected) {
        this.getState('info.connection', (err, state) => {
            if (!err && state?.val !== connected) {
                this.setState('info.connection', connected, true);
            }
        });
    }

    async resolveSteamID(steamName) {
        return this.safeApiCall(
            async () => {
                const apiKey = this.config.apiKey;
                const response = await this.apiRequest(API_ENDPOINTS.RESOLVE_VANITY_URL, {
                    key: apiKey,
                    vanityurl: steamName,
                });

                if (response?.data?.response?.success === 1 && response.data.response.steamid) {
                    this.logApiInfo('resolveSteamID', `Successfully resolved Steam ID for ${steamName}`);
                    return response.data.response.steamid;
                }
                const message = response?.data?.response?.message || 'No specific message';
                this.logApiWarning(
                    'resolveSteamID',
                    `Could not resolve Steam ID for ${steamName}. Reason: ${message} (Success Code: ${response?.data?.response?.success})`,
                );
                return null;
            },
            null,
            `Error resolving Steam ID for ${steamName}`,
        );
    }

    async checkAndCreateStates() {
        await ensureState(this, 'info.connection', {
            name: 'Connection status',
            type: 'boolean',
            role: 'indicator.connected',
            read: true,
            write: false,
            def: false,
        });
        await ensureState(this, 'steamID64', {
            name: 'Steam ID 64',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await ensureState(this, 'steamName', {
            name: 'Steam Name',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await ensureState(this, 'info.dailyRequestCount', {
            name: 'Daily API Request Count',
            type: 'number',
            role: 'value.counter',
            read: true,
            write: false,
            def: 0,
        });
        await ensureState(this, 'info.dailyRequestCountReset', {
            name: 'Daily API Request Count Reset Time',
            type: 'string',
            role: 'text.date',
            read: true,
            write: false,
            def: '',
        });
        await ensureState(this, 'playerName', {
            name: 'Player Name',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await ensureState(this, 'profileURL', {
            name: 'Profile URL',
            type: 'string',
            role: 'text.url',
            read: true,
            write: false,
        });
        await ensureState(this, 'avatar', {
            name: 'Avatar URL',
            type: 'string',
            role: 'url.avatar',
            read: true,
            write: false,
        });
        await ensureState(this, 'playerState', {
            name: 'Player State',
            type: 'number',
            role: 'value.state',
            write: false,
            states: {
                0: 'Offline',
                1: 'Online',
                2: 'Busy',
                3: 'Away',
                4: 'Snooze',
                5: 'Looking to trade',
                6: 'Looking to play',
            },
        });
        await ensureState(this, 'currentGame', {
            name: 'Current Game',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await ensureState(this, 'currentGameAppId', {
            name: 'Current Game AppID',
            type: 'number',
            role: 'value.number',
            read: true,
            write: false,
        });
    }

    async fetchAndSetData(apiKey) {
        const now = Date.now();
        const lastCallTime = this._lastApiCallTime.playerSummary || 0;
        const intervalSec = parseInt(String(this.config.playerSummaryIntervalSec), 10) || 60;
        const minInterval = Math.max(intervalSec * 1000, 5000);
        const tolerance = 1000;

        if (now - lastCallTime < minInterval - tolerance) {
            this.logApiDebug(
                'fetchAndSetData',
                `Skipped fetching player data due to interval. Elapsed: ${now - lastCallTime}ms, Min: ${minInterval}ms, Tolerance: ${tolerance}ms`,
            );
            return;
        }

        this._lastApiCallTime.playerSummary = now;

        if (this.isFetchingPlayerSummary) {
            this.logApiDebug('fetchAndSetData', 'Skipped fetching player data, already in progress.');

            if (this._fetchingPlayerSummaryStartTime && now - this._fetchingPlayerSummaryStartTime > 120000) {
                this.log.warn('Force resetting player summary fetch lock (stuck for > 2 minutes).');
                this.isFetchingPlayerSummary = false;
                this._fetchingPlayerSummaryStartTime = null;
            }
            return;
        }

        this.isFetchingPlayerSummary = true;
        this._fetchingPlayerSummaryStartTime = now;

        if (!apiKey || !this.steamID64) {
            this.logApiError('fetchAndSetData', new Error('API Key or Steam ID not available'));
            this.setConnected(false);
            this.isFetchingPlayerSummary = false;
            this._fetchingPlayerSummaryStartTime = null;
            return;
        }

        try {
            if (this.dailyRequestCount < 8000) {
                const success = await this.getPlayerSummaries(apiKey, this.steamID64);

                if (success) {
                    this.dailyRequestCount++;
                    await ensureState(
                        this,
                        'info.dailyRequestCount',
                        { name: 'Daily API Request Count', type: 'number', role: 'state', read: true, write: false },
                        this.dailyRequestCount,
                    );
                }
            } else {
                this.logApiWarning('fetchAndSetData', 'Daily API limit reached, skipping player summary fetch.');
            }
        } catch (error) {
            if (error.response && error.response.status === 429) {
                this.logApiWarning('fetchAndSetData', 'Rate limit exceeded. Skipping this request.');
                this._lastRateLimitTime = Date.now();
            } else {
                this.logApiError('fetchAndSetData', error, 'Error fetching data, skipping update');
            }
        } finally {
            this.isFetchingPlayerSummary = false;
            this._fetchingPlayerSummaryStartTime = null;
        }
    }

    async getPlayerSummaries(apiKey, steamID) {
        return this.safeApiCall(
            async () => {
                this.updateApiTimestamp('playerSummary');

                this.logApiDebug('getPlayerSummaries', 'Fetching player data...');
                const response = await this.apiRequest(API_ENDPOINTS.GET_PLAYER_SUMMARIES, {
                    key: apiKey,
                    format: 'json',
                    steamids: steamID,
                });

                if (response.status === 200 && response.data.response.players[0]) {
                    await this.setPlayerState(response.data.response.players[0]);
                    return true;
                }
                this.logApiWarning('getPlayerSummaries', 'No player data received from API.');
                return false;
            },
            false,
            'Error fetching player data',
        );
    }

    async setPlayerState(data) {
        try {
            if (this.isShuttingDown) {
                this.logApiDebug('setPlayerState', 'Skipped updating player state due to shutdown.');
                return;
            }

            const updates = [
                ensureState(
                    this,
                    'playerName',
                    { name: 'Player Name', type: 'string', role: 'state', read: true, write: false },
                    data.personaname,
                ),
                ensureState(
                    this,
                    'profileURL',
                    { name: 'Profile URL', type: 'string', role: 'state', read: true, write: false },
                    data.profileurl,
                ),
                ensureState(
                    this,
                    'avatar',
                    { name: 'Avatar URL', type: 'string', role: 'state', read: true, write: false },
                    data.avatarfull,
                ),
                ensureState(
                    this,
                    'playerState',
                    { name: 'Player State', type: 'number', role: 'state', read: true, write: false },
                    data.personastate,
                ),
            ];

            const currentGameState = await this.getStateAsync('currentGame');
            const wasPlayingGame = currentGameState && currentGameState.val && currentGameState.val !== '';
            const isPlayingGameNow = data.gameextrainfo && data.gameextrainfo !== '';
            const currentGameName = data.gameextrainfo || '';
            let currentAppId = 0;

            if (isPlayingGameNow) {
                if (data.gameid) {
                    currentAppId = parseInt(data.gameid);
                }

                let foundInConfig = false;
                let foundGameConfig = null;
                if (currentAppId > 0) {
                    foundGameConfig = this.config.gameList.find(g => Number(g.appId) === currentAppId);
                    foundInConfig = !!foundGameConfig;
                }
                if (!foundInConfig && currentGameName) {
                    const sanitizedName = currentGameName.replace(/[^a-zA-Z0-9]/g, '_');
                    foundGameConfig = this.config.gameList.find(
                        g => g.gameName && g.gameName.replace(/[^a-zA-Z0-9]/g, '_') === sanitizedName,
                    );
                    foundInConfig = !!foundGameConfig;
                }

                if (foundGameConfig && !foundGameConfig.enabled) {
                    this.log.info(
                        `Game '${foundGameConfig.gameName}' (AppID: ${foundGameConfig.appId}) is detected as running, but is not enabled in your game list. Do you want to enable it?`,
                    );
                }

                if (!foundInConfig && (currentAppId > 0 || currentGameName)) {
                    let gameData = null;
                    if (currentAppId > 0) {
                        gameData = await this.findGame(currentAppId, true);
                    }
                    if ((!gameData || !gameData.name) && currentGameName) {
                        gameData = await this.findGame(currentGameName, false);
                    }
                    if (gameData && gameData.appId && gameData.name) {
                        this.config.gameList.push({
                            gameName: gameData.name,
                            appId: gameData.appId,
                            enabled: true,
                        });

                        const gameId = gameData.name.replace(/[^a-zA-Z0-9]/g, '_');
                        await this.createGameStates(gameId, gameData.name);
                        await ensureState(
                            this,
                            `games.${gameId}.name`,
                            { name: 'Game Name', type: 'string', role: 'state', read: true, write: false },
                            gameData.name,
                        );
                        await ensureState(
                            this,
                            `games.${gameId}.gameAppId`,
                            { name: 'Game AppID', type: 'number', role: 'state', read: true, write: false },
                            gameData.appId,
                        );
                        await ensureState(
                            this,
                            `games.${gameId}.isPlaying`,
                            { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                            true,
                        );

                        const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                        if (obj) {
                            obj.native.gameList = this.config.gameList;
                            await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj, {
                                noUpdate: true,
                            });
                            this.log.info(`Added new game '${gameData.name}' (AppID: ${gameData.appId}) to config.`);
                        }
                    }
                }

                const gameChannels = await this.getChannelsOfAsync('games');
                if (Array.isArray(gameChannels)) {
                    for (const channel of gameChannels) {
                        const gameId = channel._id.split('.').pop();
                        let isCurrent = false;
                        if (foundGameConfig && foundGameConfig.enabled && foundGameConfig.gameName) {
                            const currentGameId = foundGameConfig.gameName.replace(/[^a-zA-Z0-9]/g, '_');
                            isCurrent = gameId === currentGameId;
                        }
                        if (!isCurrent) {
                            await ensureState(
                                this,
                                `games.${gameId}.isPlaying`,
                                { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                                false,
                            );
                        }
                    }
                }
                if (foundGameConfig && foundGameConfig.enabled && foundGameConfig.gameName) {
                    const gameId = foundGameConfig.gameName.replace(/[^a-zA-Z0-9]/g, '_');
                    await ensureState(
                        this,
                        `games.${gameId}.isPlaying`,
                        { name: 'Is Playing', type: 'boolean', role: 'state', read: true, write: false },
                        true,
                    );
                }

                if (currentAppId > 0) {
                    updates.push(
                        ensureState(
                            this,
                            'currentGameAppId',
                            { name: 'Current Game AppID', type: 'number', role: 'state', read: true, write: false },
                            currentAppId,
                        ),
                    );
                } else {
                    updates.push(
                        ensureState(
                            this,
                            'currentGameAppId',
                            { name: 'Current Game AppID', type: 'number', role: 'state', read: true, write: false },
                            0,
                        ),
                    );
                }
                updates.push(
                    ensureState(
                        this,
                        'currentGame',
                        { name: 'Current Game', type: 'string', role: 'state', read: true, write: false },
                        currentGameName,
                    ),
                );

                if (isPlayingGameNow && currentAppId > 0) {
                    await this.fetchRecentlyPlayedGames();
                }
            } else {
                updates.push(
                    ensureState(
                        this,
                        'currentGame',
                        { name: 'Current Game', type: 'string', role: 'state', read: true, write: false },
                        '',
                    ),
                );
                updates.push(
                    ensureState(
                        this,
                        'currentGameAppId',
                        { name: 'Current Game AppID', type: 'number', role: 'state', read: true, write: false },
                        0,
                    ),
                );

                if (wasPlayingGame) {
                    this.log.debug(
                        `Game state changed from playing '${currentGameState.val}' to stopped. Calling handleGameStopped.`,
                    );
                    await this.handleGameStopped();
                }
            }

            await Promise.all(updates);
        } catch (error) {
            this.log.error(`Error updating player state: ${error}`);
        }
    }

    async fetchRecentlyPlayedGames() {
        if (!this.steamID64 || !this.config.apiKey) {
            this.log.warn('Cannot fetch recently played games: Steam ID or API Key is missing.');
            return;
        }

        this.logApiDebug('fetchRecentlyPlayedGames', 'Attempting to fetch recently played games...');

        return this.safeApiCall(
            async () => {
                this.updateApiTimestamp('recentlyPlayed');

                const response = await this.apiRequest(API_ENDPOINTS.GET_RECENTLY_PLAYED_GAMES, {
                    key: this.config.apiKey,
                    steamid: this.steamID64,
                    count: 0,
                    format: 'json',
                });

                if (
                    response.status === 200 &&
                    response.data.response &&
                    response.data.response.games &&
                    Array.isArray(response.data.response.games)
                ) {
                    const recentlyPlayed = response.data.response.games;
                    this.logApiInfo(
                        'fetchRecentlyPlayedGames',
                        `Successfully fetched ${recentlyPlayed.length} recently played games.`,
                    );
                    await this.processRecentlyPlayedGames(recentlyPlayed);
                    return true;
                } else if (
                    response.status === 200 &&
                    response.data.response &&
                    response.data.response.total_count === 0
                ) {
                    this.logApiInfo('fetchRecentlyPlayedGames', 'No recently played games found in API response.');
                    return true;
                }
                this.logApiWarning(
                    'fetchRecentlyPlayedGames',
                    'Invalid or empty response from GetRecentlyPlayedGames API.',
                );
                return false;
            },
            false,
            'Error fetching recently played games',
        );
    }

    async processRecentlyPlayedGames(games) {
        for (const game of games) {
            try {
                const gameConfig = this.config.gameList.find(g => g.appId === game.appid);

                if (gameConfig && gameConfig.enabled && gameConfig.gameName) {
                    const gameId = gameConfig.gameName.replace(/[^a-zA-Z0-9]/g, '_');

                    const gameChannelObj = await this.getObjectAsync(`games.${gameId}`);
                    if (!gameChannelObj) {
                        this.log.warn(
                            `Game '${gameConfig.gameName}' (AppID: ${game.appid}) found in recently played but states do not exist. Skipping update.`,
                        );
                        continue;
                    }

                    const updates = [];
                    if (game.playtime_2weeks !== undefined) {
                        updates.push(
                            ensureState(
                                this,
                                `games.${gameId}.playtime_2weeks`,
                                { name: 'Playtime (2 weeks)', type: 'number', role: 'state', read: true, write: false },
                                game.playtime_2weeks,
                            ),
                        );
                    }
                    if (game.playtime_forever !== undefined) {
                        updates.push(
                            ensureState(
                                this,
                                `games.${gameId}.playtime_forever`,
                                { name: 'Playtime (total)', type: 'number', role: 'state', read: true, write: false },
                                game.playtime_forever,
                            ),
                        );
                    }
                    if (game.last_play_time !== undefined) {
                        updates.push(
                            ensureState(
                                this,
                                `games.${gameId}.last_played`,
                                { name: 'Last Played', type: 'number', role: 'state', read: true, write: false },
                                game.last_play_time,
                            ),
                        );
                    }

                    await Promise.all(updates);
                    this.logApiDebug(
                        'processRecentlyPlayedGames',
                        `Updated playtime/last played for game '${gameConfig.gameName}' (AppID: ${game.appid})`,
                    );
                } else {
                    this.logApiInfo(
                        'processRecentlyPlayedGames',
                        `Game '${game.name}' (AppID: ${game.appid}) from recently played is not in the monitored list or is disabled.`,
                    );
                }
            } catch (error) {
                this.log.error(
                    `Error processing recently played game data for AppID ${game.appid}: ${error.message || error}`,
                );
            }
        }
    }

    async resetDailyRequestCount() {
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
        const msToMidnight = midnight.getTime() - now.getTime();

        if (this.resetTimeout) {
            this.clearTimeout(this.resetTimeout);
        }

        this.resetTimeout = this.setTimeout(async () => {
            this.dailyRequestCount = 0;
            this.log.info('Daily API request count reset.');
            await ensureState(
                this,
                'info.dailyRequestCount',
                { name: 'Daily API Request Count', type: 'number', role: 'state', read: true, write: false },
                this.dailyRequestCount,
            );
            await ensureState(
                this,
                'info.dailyRequestCountReset',
                { name: 'Daily API Request Count Reset Time', type: 'string', role: 'state', read: true, write: false },
                new Date().toISOString(),
            );
            this.resetDailyRequestCount();
        }, msToMidnight);
    }

    async setupGames() {
        if (!Array.isArray(this.config.gameList)) {
            this.log.info('Game list in configuration is invalid or missing, initializing as empty.');
            this.config.gameList = [];
        }

        try {
            this.log.debug('Starting game setup and cleanup...');
            const existingGameChannels = await this.getChannelsOfAsync('games');
            const configuredGameIds = new Set(
                this.config.gameList
                    .filter(game => game && game.enabled && game.gameName)
                    .map(game => game.gameName.replace(/[^a-zA-Z0-9]/g, '_')),
            );
            this.log.debug(`Configured game IDs: ${[...configuredGameIds].join(', ')}`);

            if (existingGameChannels) {
                this.log.debug(`Raw channels found under 'games': ${existingGameChannels.map(c => c._id).join(', ')}`);

                for (const channel of existingGameChannels) {
                    const channelParts = channel._id.split('.');
                    if (channelParts.length !== 4) {
                        this.log.debug(
                            `Skipping channel ${channel._id} as it's not a direct game channel under 'games'.`,
                        );
                        continue;
                    }

                    const existingGameId = channelParts[3];

                    if (!configuredGameIds.has(existingGameId)) {
                        this.log.info(
                            `Game '${existingGameId}' found in objects but not in config (or disabled). Removing...`,
                        );
                        try {
                            await this.delObjectAsync(`games.${existingGameId}`, { recursive: true });
                            this.log.info(`Successfully removed object tree for game '${existingGameId}'.`);
                        } catch (delErr) {
                            this.log.error(`Error removing object tree for game '${existingGameId}': ${delErr}`);
                        }
                    }
                }
            } else {
                this.log.debug('No existing game channels found in objects.');
            }

            if (this.config.gameList.length === 0) {
                this.log.info('No games configured in adapter settings.');
                return;
            }

            await ensureFolder(this, 'games', 'Steam Games');

            let configUpdated = false;

            for (const game of this.config.gameList) {
                if (!game || typeof game !== 'object') {
                    this.log.warn(`Invalid game entry in configuration: ${JSON.stringify(game)}`);
                    continue;
                }

                if (game.enabled) {
                    try {
                        let gameData = null;
                        let gameId = null;
                        let configNeedsUpdate = false;

                        if (game.appId && !isNaN(parseInt(game.appId)) && parseInt(game.appId) > 0) {
                            if (!game.gameName) {
                                this.log.info(`Looking up game name for AppID ${game.appId}`);
                                gameData = await this.findGame(parseInt(game.appId), true);
                                if (gameData && gameData.name) {
                                    game.gameName = gameData.name;
                                    configNeedsUpdate = true;
                                    this.log.info(`Updated game name for AppID ${game.appId} to '${gameData.name}'`);
                                }
                            } else {
                                gameData = { appId: parseInt(game.appId), name: game.gameName };
                            }
                        } else if (game.gameName) {
                            this.log.info(`Looking up AppID for game '${game.gameName}'`);
                            gameData = await this.findGame(game.gameName, false);
                            if (gameData && gameData.appId) {
                                game.appId = gameData.appId;
                                configNeedsUpdate = true;
                                this.log.info(`Updated AppID for game '${game.gameName}' to ${gameData.appId}`);
                            }
                        }

                        if (configNeedsUpdate) {
                            configUpdated = true;
                        }

                        if (gameData && gameData.name) {
                            gameId = gameData.name.replace(/[^a-zA-Z0-9]/g, '_');
                            await this.createGameStates(gameId, gameData.name);
                            await ensureState(
                                this,
                                `games.${gameId}.name`,
                                { name: 'Game Name', type: 'string', role: 'state', read: true, write: false },
                                gameData.name,
                            );
                            if (gameData.appId) {
                                await ensureState(
                                    this,
                                    `games.${gameId}.gameAppId`,
                                    { name: 'Game AppID', type: 'number', role: 'state', read: true, write: false },
                                    Number(gameData.appId),
                                );
                            }

                            if (gameData.appId) {
                                this.fetchGameNewsNonBlocking(Number(gameData.appId), gameId, gameData.name);
                            }
                        } else if (game.gameName || game.appId) {
                            this.log.warn(`Could not process game entry: ${game.gameName || game.appId}`);
                        }
                    } catch (err) {
                        this.log.error(`Error processing game ${game.gameName || game.appId}: ${err}`);
                    }
                }
            }

            if (configUpdated) {
                try {
                    const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                    if (obj) {
                        obj.native.gameList = this.config.gameList;
                        await this.setForeignObject(`system.adapter.${this.namespace}`, obj, { noUpdate: true });
                        this.log.info('Updated adapter configuration with resolved game names/AppIDs.');
                    }
                } catch (err) {
                    this.log.error(`Failed to save updated game configuration: ${err}`);
                }
            }
            this.log.debug('Game setup and cleanup finished.');

            if (
                this.steamID64 &&
                this.config.apiKey &&
                Array.isArray(this.config.gameList) &&
                this.config.gameList.length > 0
            ) {
                try {
                    const response = await this.apiRequest(API_ENDPOINTS.GET_OWNED_GAMES, {
                        key: this.config.apiKey,
                        steamid: this.steamID64,
                        include_appinfo: 1,
                        include_played_free_games: 1,
                    });
                    if (
                        response &&
                        response.data &&
                        response.data.response &&
                        response.data.response.games &&
                        Array.isArray(response.data.response.games)
                    ) {
                        const ownedGames = response.data.response.games;
                        for (const game of ownedGames) {
                            if (this.config.gameList.find(g => Number(g.appId) === Number(game.appid) && g.enabled)) {
                                await this.processOwnedGame(game);
                            }
                        }
                        this.log.info('Update of game data for all configured games has been completed.');
                    }
                } catch (err) {
                    this.log.error(`Error updating game data on startup.${err}`);
                }
            }
        } catch (error) {
            this.log.error(`Error during setupGames: ${error}`);
        }
    }

    async createGameStates(gameId, gameName) {
        await ensureChannel(this, `games.${gameId}`, gameName);
        await ensureState(
            this,
            `games.${gameId}.name`,
            { name: 'Game Name', type: 'string', role: 'text', read: true, write: false },
            gameName,
        );
        await ensureState(this, `games.${gameId}.isPlaying`, {
            name: 'Currently Playing',
            type: 'boolean',
            role: 'switch.active',
            read: true,
            write: true,
            def: false,
        });
        await ensureState(this, `games.${gameId}.gameAppId`, {
            name: 'Game AppID',
            type: 'number',
            role: 'value.number',
            read: true,
            write: false,
        });
        await ensureChannel(this, `games.${gameId}.news`, 'Game News');
        await ensureState(this, `games.${gameId}.news.lastTitle`, {
            name: 'Latest News Title',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.news.lastURL`, {
            name: 'Latest News URL',
            type: 'string',
            role: 'text.url',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.news.lastContent`, {
            name: 'Latest News Content',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.news.lastDate`, {
            name: 'Latest News Date',
            type: 'number',
            role: 'date',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.last_played`, {
            name: 'Last Played',
            type: 'number',
            role: 'date',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.playtime_2weeks`, {
            name: 'Playtime (2 weeks)',
            type: 'number',
            role: 'value.number',
            unit: 'min',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.playtime_forever`, {
            name: 'Playtime (total)',
            type: 'number',
            role: 'value.number',
            unit: 'min',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.icon_url`, {
            name: 'Game Icon URL',
            type: 'string',
            role: 'url.icon',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.logo_url`, {
            name: 'Game Logo URL',
            type: 'string',
            role: 'url.logo',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.stats_url`, {
            name: 'Game Stats URL',
            type: 'string',
            role: 'text.url',
            read: true,
            write: false,
        });
        await ensureState(this, `games.${gameId}.has_stats`, {
            name: 'Has Community Stats',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false,
        });
    }

    async processOwnedGame(gameData) {
        try {
            const gameName = gameData.name || `Unknown Game (${gameData.appid})`;
            const gameId = gameName.replace(/[^a-zA-Z0-9]/g, '_');

            await this.createGameStates(gameId, gameName);

            await ensureState(
                this,
                `games.${gameId}.name`,
                { name: 'Game Name', type: 'string', role: 'state', read: true, write: false },
                gameName,
            );
            await ensureState(
                this,
                `games.${gameId}.gameAppId`,
                { name: 'Game AppID', type: 'number', role: 'state', read: true, write: false },
                gameData.appid,
            );

            if (gameData.playtime_2weeks !== undefined) {
                await ensureState(
                    this,
                    `games.${gameId}.playtime_2weeks`,
                    { name: 'Playtime (2 weeks)', type: 'number', role: 'state', read: true, write: false },
                    gameData.playtime_2weeks,
                );
            } else {
                await ensureState(
                    this,
                    `games.${gameId}.playtime_2weeks`,
                    { name: 'Playtime (2 weeks)', type: 'number', role: 'state', read: true, write: false },
                    0,
                );
            }

            if (gameData.playtime_forever !== undefined) {
                await ensureState(
                    this,
                    `games.${gameId}.playtime_forever`,
                    { name: 'Playtime (total)', type: 'number', role: 'state', read: true, write: false },
                    gameData.playtime_forever,
                );
            }

            if (gameData.img_icon_url) {
                const iconUrl = `https://media.steampowered.com/steamcommunity/public/images/apps/${gameData.appid}/${gameData.img_icon_url}.jpg`;
                await ensureState(
                    this,
                    `games.${gameId}.icon_url`,
                    { name: 'Game Icon URL', type: 'string', role: 'state', read: true, write: false },
                    iconUrl,
                );
            } else {
                await ensureState(
                    this,
                    `games.${gameId}.icon_url`,
                    { name: 'Game Icon URL', type: 'string', role: 'state', read: true, write: false },
                    '',
                );
            }

            if (gameData.img_logo_url) {
                const logoUrl = `https://media.steampowered.com/steamcommunity/public/images/apps/${gameData.appid}/${gameData.img_logo_url}.jpg`;
                await ensureState(
                    this,
                    `games.${gameId}.logo_url`,
                    { name: 'Game Logo URL', type: 'string', role: 'state', read: true, write: false },
                    logoUrl,
                );
            } else {
                await ensureState(
                    this,
                    `games.${gameId}.logo_url`,
                    { name: 'Game Logo URL', type: 'string', role: 'state', read: true, write: false },
                    '',
                );
            }

            if (gameData.has_community_visible_stats !== undefined) {
                await ensureState(
                    this,
                    `games.${gameId}.has_stats`,
                    { name: 'Has Community Stats', type: 'boolean', role: 'state', read: true, write: false },
                    gameData.has_community_visible_stats,
                );

                if (gameData.has_community_visible_stats) {
                    const statsUrl = `http://steamcommunity.com/profiles/${this.steamID64}/stats/${gameData.appid}`;
                    await ensureState(
                        this,
                        `games.${gameId}.stats_url`,
                        { name: 'Game Stats URL', type: 'string', role: 'state', read: true, write: false },
                        statsUrl,
                    );
                }
            }

            this.log.debug(`Updated data for owned game: ${gameName}`);
        } catch (error) {
            this.log.warn(`Error processing owned game data for AppID ${gameData.appid}:`, error);
        }
    }

    async addNewGame(gameData) {
        if (!gameData || !gameData.name) {
            this.log.warn('Cannot add new game: Invalid game data provided.');
            return;
        }
        try {
            const gameId = gameData.name.replace(/[^a-zA-Z0-9]/g, '_');
            await this.createGameStates(gameId, gameData.name);
            await ensureState(
                this,
                `games.${gameId}.name`,
                { name: 'Game Name', type: 'string', role: 'state', read: true, write: false },
                gameData.name,
            );
            await ensureState(
                this,
                `games.${gameId}.gameAppId`,
                { name: 'Game AppID', type: 'number', role: 'state', read: true, write: false },
                gameData.appId,
            );
            if (gameData.appId) {
                const newsItems = await this.getNewsForGame(gameData.appId);
                if (newsItems && newsItems.length > 0) {
                    await this.updateGameNews(gameId, newsItems[0]);
                }
            }
        } catch (error) {
            this.log.error(`Error adding new game: ${error}`);
        }
    }

    async getOwnedGamesAndUpdateConfig() {
        this.log.info('Fetching owned games from Steam...');

        if (!this.steamID64 || !this.config.apiKey) {
            this.log.error('Cannot fetch owned games: Steam ID or API Key is missing.');
            return false;
        }

        try {
            const OWNED_GAMES_ENDPOINT = `${API_BASE_URL}/IPlayerService/GetOwnedGames/v0001/`;

            const response = await this.apiRequest(OWNED_GAMES_ENDPOINT, {
                key: this.config.apiKey,
                steamid: this.steamID64,
                include_appinfo: 1,
                include_played_free_games: 1,
            });

            if (
                response &&
                response.data &&
                response.data.response &&
                response.data.response.games &&
                Array.isArray(response.data.response.games)
            ) {
                const ownedGames = response.data.response.games;
                this.log.info(`Found ${ownedGames.length} owned games.`);

                const newGameList = ownedGames.map(game => ({
                    gameName: game.name,
                    appId: game.appid,
                    enabled: false,
                }));

                const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                if (obj) {
                    obj.native.gameList = newGameList;
                    await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj, { noUpdate: true });
                    this.log.info(`Loaded ${newGameList.length} games into gameList (all disabled).`);
                }
                return true;
            }
            this.log.warn('Invalid or empty response from GetOwnedGames API.');
            return false;
        } catch (error) {
            this.log.error(`Error fetching owned games: ${error}`);
            return false;
        }
    }

    async findGame(searchTerm, isAppId = false) {
        try {
            this.log.debug(`findGame called with searchTerm: ${searchTerm}, isAppId: ${isAppId}`);

            if (!this.steamAppList || Date.now() - this.lastAppListFetch > TIMER_CONFIG.APP_LIST_REFRESH_MS) {
                this.log.debug('App list missing or outdated, fetching...');
                await this.fetchSteamAppList();
                if (!this.steamAppList) {
                    this.log.error('fetchSteamAppList completed but this.steamAppList is still null. Cannot search.');
                    return null;
                }
                this.log.debug(`App list fetched. Size: ${this.steamAppList.length}`);
            } else {
                this.log.debug(`Using existing app list. Size: ${this.steamAppList.length}`);
            }

            if (!Array.isArray(this.steamAppList)) {
                this.log.error('this.steamAppList is not an array after fetch check. Cannot search.');
                return null;
            }

            let game = null;

            if (isAppId) {
                const appId = typeof searchTerm === 'string' ? parseInt(searchTerm, 10) : searchTerm;
                if (isNaN(appId)) {
                    this.log.error(`Invalid AppID provided for search: ${searchTerm}`);
                    return null;
                }
                this.log.debug(`Searching for AppID (numeric): ${appId}`);

                game = this.steamAppList.find(app => {
                    const listAppId = Number(app.appid);
                    const match = listAppId === appId;
                    return match;
                });
                this.log.debug(`Search loop completed. Game found: ${!!game}`);

                if (game) {
                    this.log.debug(`Found game by AppID ${appId}: ${game.name}`);
                    return { appId: game.appid, name: game.name };
                }
                this.log.warn(`Could not find game name for AppID ${appId} in the fetched list.`);
                if (this.steamAppList.length > 0) {
                    this.log.debug(
                        `Sample AppIDs from list: ${this.steamAppList
                            .slice(0, 5)
                            .map(a => a.appid)
                            .join(', ')}`,
                    );
                }
            } else {
                const searchName = searchTerm.toLowerCase();

                game = this.steamAppList.find(app => app.name.toLowerCase() === searchName);
                if (game) {
                    this.log.debug(`Found exact match: ${game.name}`);
                    return { appId: game.appid, name: game.name };
                }

                game = this.steamAppList.find(app => app.name.toLowerCase().includes(searchName));
                if (game) {
                    this.log.debug(`Found partial match: ${game.name}`);
                    return { appId: game.appid, name: game.name };
                }

                this.warnSimilarGames(searchTerm);
            }

            this.log.warn(`Game search failed for term: ${searchTerm} (isAppId: ${isAppId})`);
            return null;
        } catch (error) {
            this.log.error(`Error searching for game: ${error}`);
            return null;
        }
    }

    async fetchSteamAppList() {
        try {
            this.logApiInfo('fetchSteamAppList', 'Fetching Steam app list...');

            this.updateApiTimestamp('appList');

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
                this.logApiInfo('fetchSteamAppList', `Successfully fetched ${this.steamAppList.length} apps.`);
                return this.steamAppList;
            }
            this.logApiError(
                'fetchSteamAppList',
                new Error('Invalid response format from API'),
                'Failed to fetch Steam app list',
            );
            return null;
        } catch (error) {
            this.logApiError('fetchSteamAppList', error, 'Error fetching Steam app list');
            return null;
        }
    }

    warnSimilarGames(gameName) {
        if (!this.config.enableGameSuggestions) {
            this.logApiInfo('warnSimilarGames', 'Game suggestions are disabled in config.');
            return;
        }

        if (!this.steamAppList) {
            this.logApiWarning('warnSimilarGames', 'Steam app list not available for suggestions.');
            return;
        }

        const search = gameName.toLowerCase();

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
                    matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
                }
            }
            return matrix[b.length][a.length];
        }

        const sampleSize = 250000;
        let gamesToCheck = this.steamAppList;

        if (gamesToCheck.length > sampleSize) {
            const randomIndices = new Set();
            while (randomIndices.size < sampleSize) {
                randomIndices.add(Math.floor(Math.random() * this.steamAppList.length));
            }
            gamesToCheck = Array.from(randomIndices).map(i => this.steamAppList[i]);
        }

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
                `Game '${gameName}' not found in config or Steam list. Did you mean one of these? ${similarList.join(', ')}`,
            );
        } else {
            this.logApiWarning(
                'warnSimilarGames',
                `Game '${gameName}' not found in config or Steam list. No similar names found.`,
            );
        }
    }

    async getNewsForGame(appId, count, maxLength) {
        this.updateApiTimestamp('newsForGame', appId);

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
                    response.data.appnews &&
                    response.data.appnews.newsitems &&
                    response.data.appnews.newsitems.length > 0
                ) {
                    return response.data.appnews.newsitems;
                }
                this.log.debug(`No news items found for appId: ${appId}`);
                return [];
            },
            [],
            `Error fetching news for game ${appId}`,
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

                    this.updateApiTimestamp('newsForGame', appId);

                    const newsItems = await this.getNewsForGame(appId);
                    if (newsItems && newsItems.length > 0) {
                        await this.updateGameNews(gameId, newsItems[0]);
                        this.log.debug(`Updated news for ${channel.common.name}`);
                    }
                }
            }
        } catch (error) {
            this.log.error(`Error updating games news: ${error}`);
        }
    }

    async updateGameNews(gameId, newsItem) {
        await ensureState(
            this,
            `games.${gameId}.news.lastTitle`,
            { name: 'Latest News Title', type: 'string', role: 'state', read: true, write: false },
            newsItem.title,
        );
        await ensureState(
            this,
            `games.${gameId}.news.lastURL`,
            { name: 'Latest News URL', type: 'string', role: 'state', read: true, write: false },
            newsItem.url,
        );
        await ensureState(
            this,
            `games.${gameId}.news.lastContent`,
            { name: 'Latest News Content', type: 'string', role: 'state', read: true, write: false },
            newsItem.contents,
        );
        await ensureState(
            this,
            `games.${gameId}.news.lastDate`,
            { name: 'Latest News Date', type: 'number', role: 'state', read: true, write: false },
            newsItem.date,
        );
    }

    async fetchGameNewsNonBlocking(appId, gameId, gameName) {
        try {
            this.updateApiTimestamp('newsForGame', appId);

            const newsItems = await this.getNewsForGame(appId);
            if (newsItems && newsItems.length > 0) {
                await this.updateGameNews(gameId, newsItems[0]);
                this.log.debug(`Loaded initial news for ${gameName}`);
            }
        } catch (error) {
            this.log.warn(`Could not load news for ${gameName}: ${error}`);
        }
    }

    async apiRequest(endpoint, params = {}) {
        if (this.isShuttingDown) {
            this.logApiDebug('apiRequest', 'Request skipped because adapter is shutting down.');
            return {
                status: 200,
                data: { response: { success: 0 } },
            };
        }

        const getApiName = url => {
            if (url.includes('GetPlayerSummaries')) {
                return 'Player Summaries';
            }
            if (url.includes('GetAppList')) {
                return 'App List';
            }
            if (url.includes('GetNewsForApp')) {
                return 'News for App';
            }
            if (url.includes('ResolveVanityURL')) {
                return 'Resolve Vanity URL';
            }
            if (url.includes('GetOwnedGames')) {
                return 'Owned Games';
            }
            if (url.includes('GetRecentlyPlayedGames')) {
                return 'Recently Played Games';
            }
            return 'Unknown API';
        };

        const apiName = getApiName(endpoint);

        return this.executeRequest(async () => {
            try {
                this.logApiDebug('apiRequest', `API request to ${endpoint} (${apiName})`);
                const response = await axios.get(endpoint, {
                    params,
                    timeout: RATE_LIMIT_CONFIG.REQUEST_TIMEOUT,
                });
                return response;
            } catch (error) {
                if (error.response && error.response.status === 429) {
                    this._consecutiveRateLimits++;

                    if (this._consecutiveRateLimits >= 3) {
                        this.logApiWarning(
                            'apiRequest',
                            `Rate limit (429) on ${apiName} API at ${new Date().toISOString()} - Endpoint: ${endpoint}`,
                        );
                        this._consecutiveRateLimits = 0;
                    } else {
                        this.logApiInfo(
                            'apiRequest',
                            `Rate limit (429) on ${apiName} API at ${new Date().toISOString()} - Endpoint: ${endpoint} (Consecutive: ${this._consecutiveRateLimits})`,
                        );
                    }

                    this._lastRateLimitTime = Date.now();
                    error.isRateLimit = true;
                } else {
                    this.logApiError('apiRequest', error, `API request failed for ${apiName}`);
                }
                throw error;
            }
        });
    }

    async safeApiCall(func, defaultValue, errorMsg, ...errorArgs) {
        try {
            return await func();
        } catch (error) {
            if (error.isRateLimit) {
                return defaultValue;
            }

            let skipMessage;
            if (error.response && error.response.status === 429) {
                skipMessage = 'Rate limit exceeded. Skipping this request.';
            } else {
                skipMessage = 'Request failed. Skipping this request.';
            }

            if (errorMsg) {
                let formattedErrorMsg = errorMsg;
                errorArgs.forEach(arg => {
                    formattedErrorMsg = formattedErrorMsg.replace('%s', String(arg));
                });
                this.log.error(`${skipMessage} ${formattedErrorMsg}`, error);
            } else {
                this.log.error(`API call error. ${skipMessage}`, error);
            }

            return defaultValue;
        }
    }

    logWithFormat(level, method, message, ...args) {
        let formattedMsg = message;
        args.forEach(arg => {
            formattedMsg = formattedMsg.replace('%s', String(arg));
        });
        this.log[level](`[${method}] ${formattedMsg}`);
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

    logApiError(method, error, baseMessage = 'API error', ...args) {
        let formattedBaseMessage = baseMessage;
        args.forEach(arg => {
            formattedBaseMessage = formattedBaseMessage.replace('%s', String(arg));
        });

        let details = '';
        const unknownStatus = 'Unknown';
        const noResponse = 'No response received';
        const unknownError = 'Unknown error';

        if (error.response) {
            details = `: ${error.response.status} - ${error.response.statusText || unknownStatus}`;
            if (error.response.data && error.response.data.error) {
                details += ` (${error.response.data.error})`;
            }
        } else if (error.request) {
            details = `: ${noResponse}`;
            if (error.code) {
                details += ` (${error.code})`;
            }
        } else {
            details = `: ${error.message || unknownError}`;
        }

        this.log.error(`[${method}] ${formattedBaseMessage}${details}`, error);
    }

    updateApiTimestamp(apiType, id = null) {
        const now = Date.now();
        if (apiType === 'newsForGame' && id) {
            if (!this._lastApiCallTime.newsForGame[id]) {
                this._lastApiCallTime.newsForGame[id] = 0;
            }
            this._lastApiCallTime.newsForGame[id] = now;
        } else {
            this._lastApiCallTime[apiType] = now;
        }
        return now;
    }
}

if (require.main !== module) {
    module.exports = options => new Steam(options);
} else {
    new Steam();
}
