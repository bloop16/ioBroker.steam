/// <reference types="node" />

// Don't silently swallow unhandled rejections
process.on("unhandledRejection", (e) => {
    throw e;
});

// enable the should interface with sinon
// and load chai-as-promised and sinon-chai by default
const chai = require("chai"); // Import the full chai object
const sinonChai = require("sinon-chai");
const chaiAsPromised = require("chai-as-promised");

chai.should(); // Call should() on the chai object

// Use CJS plugin functions directly to keep checkJs typing compatible.
chai.use(sinonChai);
chai.use(chaiAsPromised);