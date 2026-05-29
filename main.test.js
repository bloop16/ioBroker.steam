"use strict";

/// <reference types="node" />
/// <reference types="mocha" />

const { EventEmitter } = require("events");
const { expect } = require("chai");
const { afterEach, describe, it } = require("mocha");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();

class FakeAdapter extends EventEmitter {
	constructor(options = {}) {
		super();
		this.name = options.name || "steam";
		this.namespace = `${this.name}.0`;
		this.config = options.config || {};
		this.log = {
			error: sinon.spy(),
			warn: sinon.spy(),
			info: sinon.spy(),
			debug: sinon.spy(),
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
	const adapterFactory = proxyquire("./main", {
		"@iobroker/adapter-core": {
			Adapter: FakeAdapter,
		},
		axios: {
			get: sinon.stub(),
		},
	});

	return adapterFactory({ config });
}

describe("Steam adapter onboarding", () => {
	afterEach(() => {
		sinon.restore();
	});

	it("logs actionable guidance when required credentials are missing", async () => {
		const adapter = createAdapter({ apiKey: "", steamName: "" });
		sinon.stub(adapter, "checkAndCreateStates").resolves();
		const setConnectedStub = sinon.stub(adapter, "setConnected");

		await adapter.onReady();

		expect(setConnectedStub.calledOnceWithExactly(false)).to.equal(true);
		expect(adapter.log.error.calledOnce).to.equal(true);
		expect(adapter.log.error.firstCall.args[0]).to.include("Configuration incomplete");
		expect(adapter.log.error.firstCall.args[0]).to.include("Steam API Key");
	});

	it("returns null and logs troubleshooting details when Steam ID resolution fails", async () => {
		const adapter = createAdapter({ apiKey: "test-key" });
		const apiRequestStub = sinon.stub(adapter, "apiRequest").resolves({
			data: {
				response: {
					success: 42,
					message: "No match",
				},
			},
		});

		const result = await adapter.resolveSteamID("unknown-user");

		expect(result).to.equal(null);
		expect(apiRequestStub.calledOnce).to.equal(true);
		expect(adapter.log.warn.calledOnce).to.equal(true);
		expect(adapter.log.warn.firstCall.args[0]).to.include("Could not resolve Steam ID");
		expect(adapter.log.warn.firstCall.args[0]).to.include("profile is set to Public");
	});

	it("accepts a direct SteamID64 without calling vanity resolution", async () => {
		const adapter = createAdapter({ apiKey: "test-key", steamName: "76561198000000000" });
		sinon.stub(adapter, "checkAndCreateStates").resolves();
		sinon.stub(adapter, "getStateAsync").resolves(null);
		const resolveSteamIdStub = sinon.stub(adapter, "resolveSteamID");
		sinon.stub(adapter, "setStateChangedAsync").resolves();
		sinon.stub(adapter, "setupGames").resolves();
		sinon.stub(adapter, "resetDailyRequestCount").resolves();
		sinon.stub(adapter, "fetchAndSetData").resolves();
		sinon.stub(adapter, "fetchRecentlyPlayedGames").resolves();
		sinon.stub(adapter, "updateAllGamesNews").resolves();
		sinon.stub(adapter, "setConnected");
		sinon.stub(adapter, "subscribeStates");

		await adapter.onReady();

		expect(resolveSteamIdStub.called).to.equal(false);
		expect(adapter.steamID64).to.equal("76561198000000000");
	});

	it("logs follow-up hints when initialization cannot resolve the configured Steam ID", async () => {
		const adapter = createAdapter({ apiKey: "test-key", steamName: "sample-user" });
		sinon.stub(adapter, "checkAndCreateStates").resolves();
		sinon.stub(adapter, "getStateAsync").resolves(null);
		sinon.stub(adapter, "resolveSteamID").resolves(null);
		const setConnectedStub = sinon.stub(adapter, "setConnected");

		await adapter.onReady();

		expect(setConnectedStub.calledOnceWithExactly(false)).to.equal(true);
		expect(adapter.log.error.calledOnce).to.equal(true);
		expect(adapter.log.error.firstCall.args[0]).to.include("Could not resolve Steam ID");
		expect(adapter.log.error.firstCall.args[0]).to.include("https://steamcommunity.com/id/sample-user");
		expect(adapter.log.error.firstCall.args[0]).to.include("Public");
	});

	it("updates games.isPlaying to true when Steam API reports a running game", async () => {
		const adapter = createAdapter({
			apiKey: "test-key",
			gameList: [{ gameName: "My Game", appId: 123, enabled: true }],
		});
		sinon.stub(adapter, "setObjectNotExistsAsync").resolves();
		const setStateChangedStub = sinon.stub(adapter, "setStateChangedAsync").resolves();
		sinon.stub(adapter, "getStateAsync").resolves({ val: "" });
		sinon.stub(adapter, "getChannelsOfAsync").resolves([]);
		sinon.stub(adapter, "fetchRecentlyPlayedGames").resolves();

		await adapter.setPlayerState({
			personaname: "Bloop",
			profileurl: "https://steamcommunity.com/id/bloop16/",
			avatarfull: "https://example.com/avatar.jpg",
			personastate: 1,
			gameextrainfo: "My Game",
			gameid: "123",
		});

		expect(
			setStateChangedStub.calledWithExactly("games.isPlaying", true, true),
		).to.equal(true);
	});

	it("updates games.isPlaying to false when Steam API reports no running game", async () => {
		const adapter = createAdapter({ apiKey: "test-key", gameList: [] });
		sinon.stub(adapter, "setObjectNotExistsAsync").resolves();
		const setStateChangedStub = sinon.stub(adapter, "setStateChangedAsync").resolves();
		sinon.stub(adapter, "getStateAsync").resolves({ val: "Some Game" });
		sinon.stub(adapter, "getChannelsOfAsync").resolves([]);

		await adapter.setPlayerState({
			personaname: "Bloop",
			profileurl: "https://steamcommunity.com/id/bloop16/",
			avatarfull: "https://example.com/avatar.jpg",
			personastate: 0,
			gameextrainfo: "",
		});

		expect(
			setStateChangedStub.calledWithExactly("games.isPlaying", false, true),
		).to.equal(true);
	});

	it("routes manual currentGameAppId and currentGame writes to dedicated handlers", async () => {
		const adapter = createAdapter({ apiKey: "test-key" });
		const appIdHandlerStub = sinon.stub(adapter, "handleCurrentGameAppIdChange").resolves();
		const gameHandlerStub = sinon.stub(adapter, "handleCurrentGameChange").resolves();

		await adapter.onStateChange("steam.0.currentGameAppId", { ack: false, val: 987 });
		await adapter.onStateChange("steam.0.currentGame", { ack: false, val: "My Game" });

		expect(appIdHandlerStub.calledOnceWithExactly(987)).to.equal(true);
		expect(gameHandlerStub.calledOnceWithExactly("My Game")).to.equal(true);
	});
});
