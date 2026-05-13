/**
 * requesters.js
 * Shared map of track URI → requester display name.
 * Centralised here so player.js, autoJoin.js, and the play command
 * all reference the same Map without circular dependencies.
 */

const requesters = new Map();

module.exports = { requesters };
