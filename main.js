'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

class Steam extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'steam',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.requestInterval = null;
        this.dailyRequestCount = 0;
        this.resetTimeout = null;
    }

    async onReady() {
        await this.checkAndCreateStates();

        this.setState('info.connection', false, true);

        const apiKey = this.config.apiKey;
        const steamName = this.config.steamName;

        if (!apiKey || !steamName) {
            this.log.error('API Key and Steam Name required.');
            this.setConnected(false);
            return;
        }

        this.log.info(`API Key: ${apiKey.substring(0, 4)}...${apiKey.slice(-4)}`);
        this.log.info(`Steam Name: ${steamName}`);

        try {
            const steamID64 = await this.resolveSteamID(steamName);
            if (!steamID64) {
                this.log.error('Could not resolve Steam ID.');
                this.setConnected(false);
                return;
            }
            this.log.info(`Resolved Steam ID64: ${steamID64}`);
            this.log.debug(`Steam ID64: ${steamID64}`);

            await this.createOrUpdateState('steamID64', steamID64, 'string', 'Steam ID64');

            this.setConnected(true);

            // Reset daily request count at midnight
            await this.resetDailyRequestCount();

            // Initial fetch and start interval
            await this.fetchAndSetData(apiKey, steamID64);
            this.requestInterval = setInterval(async () => {
                await this.fetchAndSetData(apiKey, steamID64);
            }, 10800); // ~10 seconds
        } catch (error) {
            this.log.error(`Error: ${error}`);
            this.setConnected(false);
        }
    }

    async fetchAndSetData(apiKey, steamID64) {
        try {
            if (this.dailyRequestCount < 8000) {
                await this.getPlayerSummaries(apiKey, steamID64);
                this.dailyRequestCount++;
                if (this.log.level === 'debug') {
                    this.log.debug(`Daily Request Count: ${this.dailyRequestCount}`);
                    await this.setStateAsync('info.dailyRequestCount', { val: this.dailyRequestCount, ack: true });
                }
            } else {
                this.log.warn('Daily API request limit reached.');
            }
        } catch (error) {
            this.log.error(`Error fetching and setting data: ${error}`);
        }
    }

    async resetDailyRequestCount() {
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
        const msToMidnight = midnight.getTime() - now.getTime();

        // Check if the adapter was restarted after midnight
        const lastReset = await this.getStateAsync('info.dailyRequestCountReset');
        if (
            lastReset &&
            lastReset.val &&
            typeof lastReset.val === 'string' &&
            new Date(lastReset.val).getTime() > now.getTime()
        ) {
            this.log.debug('Daily request count already reset today.');
            return;
        }

        // Clear any existing timeout
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
        }

        this.resetTimeout = setTimeout(async () => {
            this.dailyRequestCount = 0;
            this.log.info('Daily request count reset.');
            if (this.log.level === 'debug') {
                this.log.debug(`Daily Request Count: ${this.dailyRequestCount}`);
                await this.setStateAsync('info.dailyRequestCount', { val: this.dailyRequestCount, ack: true });
            }
            await this.setStateAsync('info.dailyRequestCountReset', { val: new Date().toISOString(), ack: true });
            this.resetDailyRequestCount(); // Reset again for the next day
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
            this.log.warn(`Could not resolve Steam ID for ${steamName}.`);
            return null;
        } catch (error) {
            this.log.error(`Error resolving Steam ID: ${error}`);
            return null;
        }
    }

    async getPlayerSummaries(apiKey, steamID) {
        try {
            const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&format=json&steamids=${steamID}`;
            const response = await axios.get(url, { timeout: 20000 });

            if (response.status === 200) {
                const data = response.data.response.players[0];

                if (data) {
                    await this.setPlayerState(data);
                } else {
                    this.log.warn('No player data received from Steam API.');
                }
            } else {
                this.log.error(`Unexpected response status: ${response.status}`);
            }
        } catch (error) {
            this.log.error(`Error fetching player summaries: ${error}`);
        }
    }

    async setPlayerState(data) {
        try {
            await this.createOrUpdateState('playerName', data.personaname, 'string', 'Player Name');
            await this.createOrUpdateState('profileURL', data.profileurl, 'string', 'Profile URL');
            await this.createOrUpdateState('avatar', data.avatarfull, 'string', 'Avatar URL');
            await this.createOrUpdateState('playerState', data.personastate, 'number', 'Player State');
            await this.createOrUpdateState('gameExtraInfo', data.gameextrainfo, 'string', 'Game Extra Info');
        } catch (error) {
            this.log.error(`Error setting player state: ${error}`);
        }
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
                name: 'Device or Service connected',
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
                name: 'Steam ID64',
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
                name: 'Daily Request Count',
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
                name: 'Daily Request Count Reset',
                type: 'string',
                role: 'value.time',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
    }

    onUnload(callback) {
        try {
            this.setConnected(false);
            if (this.requestInterval) {
                clearInterval(this.requestInterval);
            }
            if (this.resetTimeout) {
                clearTimeout(this.resetTimeout);
            }
            callback();
        } catch {
            callback();
        }
    }

    onStateChange(id, state) {
        if (state) {
            this.log.info(`State ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            this.log.info(`State ${id} deleted`);
        }
    }

    onMessage(obj) {
        const message = obj.message;
        const command = obj.command;
        const from = obj.from;
        const callback = obj.callback;

        if (command === 'test') {
            this.log.info(`Test message: ${message}`);

            if (callback) {
                this.sendTo(from, callback, {
                    result: 'Test message received',
                    error: null,
                });
            }
        }
    }

    setConnected(connected) {
        this.setState('info.connection', connected, true);
    }
}

if (require.main !== module) {
    module.exports = options => new Steam(options);
} else {
    new Steam();
}
