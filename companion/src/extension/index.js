const { CompanionExtension } = require("./extension");

function activate(context) {
  new CompanionExtension(context).activate();
}

function deactivate() {}

module.exports = { activate, deactivate };
