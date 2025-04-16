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

class Steam extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'steam',
        });
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

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    async onReady() {
        await this.checkAndCreateStates();

        const apiKey = this.config.apiKey;
        const steamName = this.config.steamName;

        if (!apiKey || !steamName) {
            this.log.error(this._('API Key and Steam Name required.'));
            this.setConnected(false);
            return;
        }

        try {
            const steamID64 = await this.resolveSteamID(steamName);
            if (!steamID64) {
                this.log.error(this._('Could not resolve Steam ID.'));
                this.setConnected(false);
                return;
            }
            this.steamID64 = steamID64;

            this.log.info(this._('Resolved Steam ID for %s', steamName));
            await this.createOrUpdateState('steamID64', steamID64, 'string', this._('Steam ID64'));

            await this.setupGames();
            await this.resetDailyRequestCount();
            this.setConnected(true);
            await this.fetchAndSetData(apiKey, steamID64);

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

            // News every 6 hours
            this.newsInterval = setInterval(
                () => {
                    (async () => {
                        try {
                            await this.updateAllGamesNews();
                        } catch (e) {
                            this.log.error(e);
                        }
                    })();
                },
                6 * 60 * 60 * 1000,
            );

            // Recently played every 15 min
            this.recentlyPlayedInterval = setInterval(
                () => {
                    (async () => {
                        try {
                            await this.fetchRecentlyPlayed();
                        } catch (e) {
                            this.log.error(e);
                        }
                    })();
                },
                15 * 60 * 1000,
            );

            // Player summary interval
            let intervalSec = parseInt(String(this.config.playerSummaryIntervalSec), 10) || 60;
            if (intervalSec < 15) {
                intervalSec = 15;
            }

            this.playerSummaryInterval = setInterval(() => {
                (async () => {
                    try {
                        if (this.dailyRequestCount < 10000) {
                            await this.fetchAndSetData(this.config.apiKey, this.steamID64);
                        } else {
                            this.log.warn(this._('Daily API request limit reached.'));
                        }
                    } catch (e) {
                        this.log.error(e);
                    }
                })();
            }, intervalSec * 1000);
        } catch (error) {
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
                await this.getPlayerSummaries(apiKey, steamID64);
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
                    this.fetchAndSetData(apiKey, steamID64, (retryCount || 0) + 1);
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
        // First check if shutting down
        if (this.isShuttingDown) {
            this.logApiDebug('apiRequest', 'Request skipped because adapter is shutting down');
            throw new Error('Adapter is shutting down');
        }

        try {
            this.logApiDebug('apiRequest', 'API request to %s with params: %s', endpoint, JSON.stringify(params));
            const response = await axios.get(endpoint, {
                params,
                timeout: RATE_LIMIT_CONFIG.REQUEST_TIMEOUT,
            });
            return response;
        } catch (error) {
            // Check again if shutting down before retrying
            if (this.isShuttingDown) {
                throw new Error('Adapter is shutting down');
            }

            // Handle Rate-Limit (429)
            if (error.response && error.response.status === 429 && retryCount < RATE_LIMIT_CONFIG.MAX_RETRIES) {
                const waitTime = Math.pow(2, retryCount) * RATE_LIMIT_CONFIG.RETRY_BASE_TIME;
                this.logApiWarning('apiRequest', 'Rate limit exceeded. Retrying in %s minutes.', waitTime / 60000);

                return new Promise((resolve, reject) => {
                    const timeoutId = setTimeout(async () => {
                        // Remove the timeout from tracking array when it completes
                        const index = this._apiTimeouts.indexOf(timeoutId);
                        if (index !== -1) {
                            this._apiTimeouts.splice(index, 1);
                        }

                        // Check if adapter is shutting down before executing retry
                        if (this.isShuttingDown) {
                            reject(new Error('Adapter is shutting down'));
                            return;
                        }

                        try {
                            const result = await this.apiRequest(endpoint, params, retryCount + 1);
                            resolve(result);
                        } catch (e) {
                            reject(e);
                        }
                    }, waitTime);

                    // Add timeout to tracking array for cleanup
                    this._apiTimeouts.push(timeoutId);
                });
            }

            this.logApiError('apiRequest', error);
            throw error; // Re-throw for caller to handle
        }
    }

    async safeApiCall(apiFunction, errorReturnValue, errorMessage) {
        try {
            return await apiFunction();
        } catch (error) {
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
            await this.createOrUpdateState('playerName', data.personaname, 'string', this._('Player Name'));
            await this.createOrUpdateState('profileURL', data.profileurl, 'string', this._('Profile URL'));
            await this.createOrUpdateState('avatar', data.avatarfull, 'string', this._('Avatar URL'));
            await this.createOrUpdateState('playerState', data.personastate, 'number', this._('Player State'));

            let currentGameName = '';

            if (data.gameextrainfo) {
                currentGameName = data.gameextrainfo;
                if (data.gameid) {
                    await this.createOrUpdateState(
                        'currentGameAppId',
                        parseInt(data.gameid),
                        'number',
                        this._('Current Game App ID'),
                    );
                }
                await this.createOrUpdateState('currentGame', currentGameName, 'string', this._('Current Game'));
            } else {
                await this.createOrUpdateState('currentGame', '', 'string', this._('Current Game'));
            }

            await this.fetchRecentlyPlayed();
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

            let configUpdated = false;
            const updatedGameList = [];

            for (const game of this.config.gameList) {
                if (!game || typeof game !== 'object') {
                    this.log.warn(this._('Invalid game entry in configuration: %s', JSON.stringify(game)));
                    continue;
                }

                const updatedGame = { ...game };

                if (game.enabled) {
                    let gameData = null;

                    if (game.appId && !isNaN(parseInt(game.appId)) && parseInt(game.appId) > 0) {
                        gameData = await this.getGameByAppId(parseInt(game.appId));
                        if (gameData && (!game.gameName || game.gameName !== gameData.name)) {
                            updatedGame.gameName = gameData.name;
                            configUpdated = true;
                            this.log.info(this._('Updated game name to %s for AppID %s', gameData.name, game.appId));
                        }
                    } else if (game.gameName) {
                        gameData = await this.searchGameAppId(game.gameName);
                        if (gameData && gameData.appId) {
                            updatedGame.appId = gameData.appId;
                            configUpdated = true;
                            this.log.info(
                                this._('Updated game %s with AppID %s in configuration', game.gameName, gameData.appId),
                            );
                        }
                    }

                    if (gameData) {
                        const gameId = gameData.name.replace(/[^a-zA-Z0-9]/g, '_');
                        await this.createGameStates(gameId, gameData.name);
                        await this.setState(`games.${gameId}.name`, gameData.name, true);
                        await this.setState(`games.${gameId}.isPlaying`, false, true);
                        await this.setState(`games.${gameId}.gameAppId`, gameData.appId, true);

                        if (gameData.appId) {
                            try {
                                const newsItems = await this.getNewsForGame(gameData.appId);
                                if (newsItems && newsItems.length > 0) {
                                    await this.updateGameNews(gameId, newsItems[0]);
                                    this.log.debug(this._('Loaded initial news for %s', gameData.name));
                                }
                            } catch (error) {
                                this.log.warn(this._('Could not load news for %s: %s', gameData.name, error));
                            }
                        }
                    }
                }

                updatedGameList.push(updatedGame);
            }

            if (configUpdated) {
                try {
                    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                        native: {
                            gameList: updatedGameList,
                        },
                    });

                    this.config.gameList = updatedGameList;
                    this.log.info(this._('Saved updated game configuration.'));
                } catch (error) {
                    this.log.error(this._('Error saving updated game configuration: %s', error));
                }
            }
        } catch (error) {
            this.log.error(this._('Error during setupGames: %s', error));
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

    async searchGameAppId(gameName) {
        try {
            if (!this.steamAppList || Date.now() - this.lastAppListFetch > 86400000) {
                await this.fetchSteamAppList();
            }
            if (!this.steamAppList) {
                this.log.error(this._('Steam app list not available'));
                return null;
            }
            const searchName = gameName.toLowerCase();
            const exactMatch = this.steamAppList.find(app => app.name.toLowerCase() === searchName);
            if (exactMatch) {
                this.log.debug(this._('Found exact match: %s', exactMatch.name));
                return { appId: exactMatch.appid, name: exactMatch.name };
            }
            const containsMatch = this.steamAppList.find(app => app.name.toLowerCase().includes(searchName));
            if (containsMatch) {
                this.log.debug(this._('Found partial match: %s', containsMatch.name));
                return { appId: containsMatch.appid, name: containsMatch.name };
            }
            this.warnSimilarGames(gameName);
            return null;
        } catch (error) {
            this.log.error(this._('Error searching for game: %s', error));
            return null;
        }
    }

    async fetchSteamAppList() {
        return this.safeApiCall(
            async () => {
                this.log.info(this._('Fetching Steam app list...'));
                const response = await this.apiRequest(API_ENDPOINTS.GET_APP_LIST);

                if (
                    response.status === 200 &&
                    response.data &&
                    response.data.applist &&
                    Array.isArray(response.data.applist.apps)
                ) {
                    this.steamAppList = response.data.applist.apps
                        .filter(app => app.name && app.name.trim() !== '')
                        .sort((a, b) => a.name.localeCompare(b.name));
                    this.lastAppListFetch = Date.now();
                    this.log.info(this._('Steam app list fetched with %s games', this.steamAppList.length));
                    return true;
                }
                this.log.error(this._('Invalid response from Steam app list API'));
                return false;
            },
            false,
            'Error fetching Steam app list: %s',
        );
    }

    async getGameByAppId(appId) {
        try {
            if (!this.steamAppList || Date.now() - this.lastAppListFetch > 86400000) {
                await this.fetchSteamAppList();
            }

            if (!this.steamAppList) {
                this.log.error(this._('Steam app list not available'));
                return null;
            }

            const game = this.steamAppList.find(app => app.appid === appId);
            if (game && game.name) {
                this.log.debug(this._('Found game by AppID %s: %s', appId, game.name));
                return { appId: game.appid, name: game.name };
            }

            this.log.warn(this._('No game found with AppID: %s', appId));
            return null;
        } catch (error) {
            this.log.error(this._('Error searching for game by AppID: %s', error));
            return null;
        }
    }

    async getNewsForGame(appId, count, maxLength) {
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
        return this.safeApiCall(
            async () => {
                const apiKey = this.config.apiKey;
                const steamID64 = this.steamID64;
                if (!apiKey || !steamID64) {
                    return false;
                }

                const response = await this.apiRequest(API_ENDPOINTS.GET_RECENTLY_PLAYED, {
                    key: apiKey,
                    steamid: steamID64,
                });

                // Erstelle eine Ordnerstruktur für die kürzlich gespielten Spiele, falls noch nicht vorhanden
                await this.setObjectNotExistsAsync('recentlyPlayed', {
                    type: 'folder',
                    common: { name: this._('Recently Played Games') },
                    native: {},
                });

                // Verarbeite und speichere detaillierte Informationen für jedes Spiel
                if (response.data && response.data.response && response.data.response.games) {
                    const games = response.data.response.games;

                    // Jetzt speichern wir stattdessen eine einfache Zahl der kürzlich gespielten Spiele
                    await this.setObjectNotExistsAsync('recentlyPlayed.count', {
                        type: 'state',
                        common: {
                            name: this._('Number of Recently Played Games'),
                            type: 'number',
                            role: 'value',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    // Setze die Anzahl der kürzlich gespielten Spiele
                    await this.setState('recentlyPlayed.count', games.length, true);

                    this.log.debug(`Updated information for ${games.length} recently played games`);
                    return true;
                }
                return false;
            },
            false,
            'Error fetching recently played games: %s',
        );
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
            this.isShuttingDown = true;
            this.setConnected(false);

            // Clear the reset timeout
            if (this.resetTimeout) {
                clearTimeout(this.resetTimeout);
                this.resetTimeout = null;
            }

            // Clear intervals
            if (this.newsInterval) {
                clearInterval(this.newsInterval);
                this.newsInterval = null;
            }
            if (this.recentlyPlayedInterval) {
                clearInterval(this.recentlyPlayedInterval);
                this.recentlyPlayedInterval = null;
            }
            if (this.playerSummaryInterval) {
                clearInterval(this.playerSummaryInterval);
                this.playerSummaryInterval = null;
            }

            // Clear all API timeouts
            for (const timeoutId of this._apiTimeouts) {
                clearTimeout(timeoutId);
            }
            this._apiTimeouts = [];

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

    logApiError(method, error, message = 'API error') {
        let detailedMessage = message;

        if (error.response) {
            // Server antwortete mit Fehlercode
            detailedMessage += `: ${error.response.status} - ${error.response.statusText || 'Unknown'}`;
            if (error.response.data && error.response.data.error) {
                detailedMessage += ` (${error.response.data.error})`;
            }
        } else if (error.request) {
            // Keine Antwort erhalten
            detailedMessage += ': No response received';
            if (error.code) {
                detailedMessage += ` (${error.code})`;
            }
        } else {
            // Fehler beim Einrichten der Anfrage
            detailedMessage += `: ${error.message || 'Unknown error'}`;
        }

        this.log.error(this._(`[${method}] ${detailedMessage}`));
    }

    logApiWarning(method, message, ...args) {
        this.log.warn(this._(`[${method}] ${message}`, ...args));
    }

    logApiInfo(method, message, ...args) {
        this.log.info(this._(`[${method}] ${message}`, ...args));
    }

    logApiDebug(method, message, ...args) {
        this.log.debug(this._(`[${method}] ${message}`, ...args));
    }
}

if (require.main !== module) {
    module.exports = options => new Steam(options);
} else {
    new Steam();
}
