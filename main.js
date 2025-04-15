'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

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
            this.log.debug('fetchAndSetData: Request skipped because another is running.');
            return;
        }
        this.isFetchingPlayerSummary = true;
        try {
            if (this.dailyRequestCount < 8000) {
                await this.getPlayerSummaries(apiKey, steamID64);
                this.dailyRequestCount++;
                await this.setStateAsync('info.dailyRequestCount', { val: this.dailyRequestCount, ack: true });
            } else {
                this.log.warn(this._('Daily API request limit reached.'));
            }
        } catch (error) {
            this.log.error(this._('Error fetching data: %s', error));
            if (error.response && error.response.status === 429) {
                const waitTime = Math.pow(2, retryCount || 0) * 60000;
                this.log.warn(this._('Rate limit exceeded. Retrying in %s minutes.', waitTime / 60000));
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
            await this.setStateAsync('info.dailyRequestCount', { val: this.dailyRequestCount, ack: true });
            await this.setStateAsync('info.dailyRequestCountReset', { val: new Date().toISOString(), ack: true });
            this.resetDailyRequestCount();
        }, msToMidnight);
    }

    async resolveSteamID(steamName) {
        try {
            const apiKey = this.config.apiKey;
            const url = `http://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${apiKey}&vanityurl=${steamName}`;
            const response = await axios.get(url);

            if (response.data.response.success === 1) {
                return response.data.response.steamid;
            }
            this.log.warn(this._('Could not resolve Steam ID for %s.', steamName));
            return null;
        } catch (error) {
            this.log.error(this._('Error resolving Steam ID: %s', error));
            return null;
        }
    }

    async getPlayerSummaries(apiKey, steamID) {
        try {
            const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&format=json&steamids=${steamID}`;
            const response = await axios.get(url, { timeout: 20000 });

            if (response.status === 200 && response.data.response.players[0]) {
                await this.setPlayerState(response.data.response.players[0]);
            } else {
                this.log.warn(this._('No player data received from Steam API.'));
            }
        } catch (error) {
            this.log.error(this._('Error fetching player data: %s', error));
        }
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
            this.log.info(this._('No games configured to monitor'));
            return;
        }
        await this.setObjectNotExistsAsync('games', {
            type: 'folder',
            common: { name: this._('Steam Games') },
            native: {},
        });

        for (const game of this.config.gameList) {
            if (game && game.gameName && game.enabled) {
                const gameData = await this.searchGameAppId(game.gameName);
                if (gameData) {
                    const gameId = gameData.name.replace(/[^a-zA-Z0-9]/g, '_');
                    await this.createGameStates(gameId, gameData.name);
                    await this.setState(`games.${gameId}.name`, gameData.name, true);
                    await this.setState(`games.${gameId}.isPlaying`, false, true);
                    await this.setState(`games.${gameId}.gameAppId`, gameData.appId, true);
                }
            }
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
        await this.setState(`${this.namespace}.${stateName}`, { val: value, ack: true });
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
            this.log.warn(this._('No games found matching: %s', gameName));
            return null;
        } catch (error) {
            this.log.error(this._('Error searching for game: %s', error));
            return null;
        }
    }

    async fetchSteamAppList() {
        try {
            this.log.info(this._('Fetching Steam app list...'));
            const url = 'http://api.steampowered.com/ISteamApps/GetAppList/v0002/';
            const response = await axios.get(url, { timeout: 30000 });
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
        } catch (error) {
            this.log.error(this._('Error fetching Steam app list: %s', error));
            return false;
        }
    }

    async getNewsForGame(appId, count, maxLength) {
        try {
            const url = `http://api.steampowered.com/ISteamNews/GetNewsForApp/v0002/?appid=${appId}&count=${count || 3}&maxlength=${maxLength || 300}&format=json`;
            const response = await axios.get(url, { timeout: 20000 });
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
        } catch (error) {
            this.log.error(this._('Error fetching news for game %s: %s', appId, error));
            return [];
        }
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
        try {
            const apiKey = this.config.apiKey;
            const steamID64 = this.steamID64;
            if (!apiKey || !steamID64) {
                return;
            }
            const url = `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${apiKey}&steamid=${steamID64}`;
            await axios.get(url);
        } catch (error) {
            this.log.error(this._('Error fetching recently played games: %s', error));
        }
    }

    async onUnload(callback) {
        try {
            this.setConnected(false);
            if (this.resetTimeout) {
                clearTimeout(this.resetTimeout);
            }
            if (this.newsInterval) {
                clearInterval(this.newsInterval);
            }
            if (this.recentlyPlayedInterval) {
                clearInterval(this.recentlyPlayedInterval);
            }
            if (this.playerSummaryInterval) {
                clearInterval(this.playerSummaryInterval);
            }
            callback();
        } catch {
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
}

if (require.main !== module) {
    module.exports = options => new Steam(options);
} else {
    new Steam();
}
