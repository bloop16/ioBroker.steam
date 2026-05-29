"use strict";

/// <reference types="node" />
/// <reference types="mocha" />

const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { afterEach, describe, it } = require("mocha");
const proxyquire = require("proxyquire").noCallThru();

/** @type {(() => void)[]} */
const restoreStack = [];

/**
 * @typedef {((...args: unknown[]) => unknown) & {
 *  calls: unknown[][],
 *  called: boolean,
 *  calledOnce: boolean,
 *  firstCall: { args: unknown[] } | undefined,
 *  calledWithExactly: (...expected: unknown[]) => boolean,
 *  calledOnceWithExactly: (...expected: unknown[]) => boolean,
 *  resolves: (value?: unknown) => SpyFunction,
 * }} SpyFunction
 */

function argsExactlyMatch(actual, expected) {
	if (actual.length !== expected.length) {
		return false;
	}
	return actual.every((value, index) => Object.is(value, expected[index]));
}

/**
 * @param {(...args: unknown[]) => unknown} [implementation]
 * @returns {SpyFunction}
 */
function createSpy(implementation = () => undefined) {
	/** @type {unknown[][]} */
	const calls = [];
	const spy = /** @type {SpyFunction} */ ((...args) => {
		calls.push(args);
		return implementation(...args);
	});

	spy.calls = calls;
	Object.defineProperty(spy, "called", {
		get() {
			return calls.length > 0;
		},
	});
	Object.defineProperty(spy, "calledOnce", {
		get() {
			return calls.length === 1;
		},
	});
	Object.defineProperty(spy, "firstCall", {
		get() {
			if (!calls.length) {
				return undefined;
			}
			return { args: calls[0] };
		},
	});

	spy.calledWithExactly = (...expected) => calls.some((callArgs) => argsExactlyMatch(callArgs, expected));
	spy.calledOnceWithExactly = (...expected) => calls.length === 1 && argsExactlyMatch(calls[0], expected);
	spy.resolves = (value) => {
		implementation = () => Promise.resolve(value);
		return spy;
	};

	return spy;
}

function stubMethod(object, methodName) {
	const original = object[methodName];
	const stub = createSpy();
	object[methodName] = stub;
	restoreStack.push(() => {
		object[methodName] = original;
	});
	return stub;
}

function restoreAllStubs() {
	while (restoreStack.length) {
		const restore = restoreStack.pop();
		if (restore) {
			restore();
		}
	}
}

class FakeAdapter extends EventEmitter {
	constructor(options = {}) {
		super();
		this.name = options.name || "steam";
		this.namespace = `${this.name}.0`;
		this.config = options.config || {};
		this.log = {
			error: createSpy(),
			warn: createSpy(),
			info: createSpy(),
			debug: createSpy(),
		};
	}

	async setObjectNotExistsAsync() {}
	async setStateChangedAsync() {}
	async getStateAsync() {
		return null;
	}
	setTimeout(callback) {
		return callback;
	}
	clearTimeout() {}
	clearInterval() {}
	subscribeStates() {}
	getState(_id, callback) {
		callback(null, { val: false });
	}
	setState() {}
	async getForeignObjectAsync() {
		return null;
	}
	async setForeignObjectAsync() {}
	async getChannelsOfAsync() {
		return [];
	}
	async getObjectAsync() {
		return null;
	}
	async delObjectAsync() {}
	sendTo() {}
}

function createAdapter(config = {}) {
	const axiosGetStub = createSpy();
	const adapterFactory = proxyquire("./main", {
		"@iobroker/adapter-core": {
			Adapter: FakeAdapter,
		},
		axios: {
			get: axiosGetStub,
		},
	});

	return adapterFactory({ config });
}

describe("Steam adapter onboarding", () => {
	afterEach(() => {
		restoreAllStubs();
	});

	it("logs actionable guidance when required credentials are missing", async () => {
		const adapter = createAdapter({ apiKey: "", steamName: "" });
		stubMethod(adapter, "checkAndCreateStates").resolves();
		const setConnectedStub = stubMethod(adapter, "setConnected");

		await adapter.onReady();

		assert.equal(setConnectedStub.calledOnceWithExactly(false), true);
		assert.equal(adapter.log.error.calledOnce, true);
		assert.equal(adapter.log.error.firstCall.args[0].includes("Configuration incomplete"), true);
		assert.equal(adapter.log.error.firstCall.args[0].includes("Steam API Key"), true);
	});

	it("returns null and logs troubleshooting details when Steam ID resolution fails", async () => {
		const adapter = createAdapter({ apiKey: "test-key" });
		const apiRequestStub = stubMethod(adapter, "apiRequest").resolves({
			data: {
				response: {
					success: 42,
					message: "No match",
				},
			},
		});

		const result = await adapter.resolveSteamID("unknown-user");

		assert.equal(result, null);
		assert.equal(apiRequestStub.calledOnce, true);
		assert.equal(adapter.log.warn.calledOnce, true);
		assert.equal(adapter.log.warn.firstCall.args[0].includes("Could not resolve Steam ID"), true);
		assert.equal(adapter.log.warn.firstCall.args[0].includes("profile is set to Public"), true);
	});

	it("accepts a direct SteamID64 without calling vanity resolution", async () => {
		const adapter = createAdapter({ apiKey: "test-key", steamName: "76561198000000000" });
		stubMethod(adapter, "checkAndCreateStates").resolves();
		stubMethod(adapter, "getStateAsync").resolves(null);
		const resolveSteamIdStub = stubMethod(adapter, "resolveSteamID");
		stubMethod(adapter, "setStateChangedAsync").resolves();
		stubMethod(adapter, "setupGames").resolves();
		stubMethod(adapter, "resetDailyRequestCount").resolves();
		stubMethod(adapter, "fetchAndSetData").resolves();
		stubMethod(adapter, "fetchRecentlyPlayedGames").resolves();
		stubMethod(adapter, "updateAllGamesNews").resolves();
		stubMethod(adapter, "setConnected");
		stubMethod(adapter, "subscribeStates");

		await adapter.onReady();

		assert.equal(resolveSteamIdStub.called, false);
		assert.equal(adapter.steamID64, "76561198000000000");
	});

	it("logs follow-up hints when initialization cannot resolve the configured Steam ID", async () => {
		const adapter = createAdapter({ apiKey: "test-key", steamName: "sample-user" });
		stubMethod(adapter, "checkAndCreateStates").resolves();
		stubMethod(adapter, "getStateAsync").resolves(null);
		stubMethod(adapter, "resolveSteamID").resolves(null);
		const setConnectedStub = stubMethod(adapter, "setConnected");

		await adapter.onReady();

		assert.equal(setConnectedStub.calledOnceWithExactly(false), true);
		assert.equal(adapter.log.error.calledOnce, true);
		assert.equal(adapter.log.error.firstCall.args[0].includes("Could not resolve Steam ID"), true);
		assert.equal(adapter.log.error.firstCall.args[0].includes("https://steamcommunity.com/id/sample-user"), true);
		assert.equal(adapter.log.error.firstCall.args[0].includes("Public"), true);
	});

	it("updates games.isPlaying to true when Steam API reports a running game", async () => {
		const adapter = createAdapter({
			apiKey: "test-key",
			gameList: [{ gameName: "My Game", appId: 123, enabled: true }],
		});
		stubMethod(adapter, "setObjectNotExistsAsync").resolves();
		const setStateChangedStub = stubMethod(adapter, "setStateChangedAsync").resolves();
		stubMethod(adapter, "getStateAsync").resolves({ val: "" });
		stubMethod(adapter, "getChannelsOfAsync").resolves([]);
		stubMethod(adapter, "fetchRecentlyPlayedGames").resolves();

		await adapter.setPlayerState({
			personaname: "Bloop",
			profileurl: "https://steamcommunity.com/id/bloop16/",
			avatarfull: "https://example.com/avatar.jpg",
			personastate: 1,
			gameextrainfo: "My Game",
			gameid: "123",
		});

		assert.equal(setStateChangedStub.calledWithExactly("games.isPlaying", true, true), true);
	});

	it("updates games.isPlaying to false when Steam API reports no running game", async () => {
		const adapter = createAdapter({ apiKey: "test-key", gameList: [] });
		stubMethod(adapter, "setObjectNotExistsAsync").resolves();
		const setStateChangedStub = stubMethod(adapter, "setStateChangedAsync").resolves();
		stubMethod(adapter, "getStateAsync").resolves({ val: "Some Game" });
		stubMethod(adapter, "getChannelsOfAsync").resolves([]);

		await adapter.setPlayerState({
			personaname: "Bloop",
			profileurl: "https://steamcommunity.com/id/bloop16/",
			avatarfull: "https://example.com/avatar.jpg",
			personastate: 0,
			gameextrainfo: "",
		});

		assert.equal(setStateChangedStub.calledWithExactly("games.isPlaying", false, true), true);
	});

	it("routes manual currentGameAppId and currentGame writes to dedicated handlers", async () => {
		const adapter = createAdapter({ apiKey: "test-key" });
		const appIdHandlerStub = stubMethod(adapter, "handleCurrentGameAppIdChange").resolves();
		const gameHandlerStub = stubMethod(adapter, "handleCurrentGameChange").resolves();

		await adapter.onStateChange("steam.0.currentGameAppId", { ack: false, val: 987 });
		await adapter.onStateChange("steam.0.currentGame", { ack: false, val: "My Game" });

		assert.equal(appIdHandlerStub.calledOnceWithExactly(987), true);
		assert.equal(gameHandlerStub.calledOnceWithExactly("My Game"), true);
	});
});
