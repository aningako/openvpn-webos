// Minimal stand-in for webos-service so service.js can be loaded off the TV.
module.exports = function Service() { this.register = function () { return true; }; };
