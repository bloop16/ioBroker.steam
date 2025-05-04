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

// Call use() as a method on the chai object, checking for .default
chai.use(sinonChai.default || sinonChai);
chai.use(chaiAsPromised.default || chaiAsPromised);