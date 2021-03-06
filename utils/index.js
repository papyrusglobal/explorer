const ethUtils = require("ethereumjs-util");
const ethBlock = require("ethereumjs-block/from-rpc");

function getSigner(block) {
  const sealers = block.extraData;
  if (sealers.length <= 130) return undefined;
  const sig = ethUtils.fromRpcSig(
    "0x" + sealers.substring(sealers.length - 130, sealers.length)
  ); // remove signature
  block.extraData = block.extraData.substring(0, block.extraData.length - 130);
  const blk = ethBlock(block);
  blk.header.difficulty[0] = block.difficulty;
  const sigHash = ethUtils.sha3(blk.header.serialize());
  const pubkey = ethUtils.ecrecover(sigHash, sig.v, sig.r, sig.s);
  return ethUtils.pubToAddress(pubkey).toString("hex");
}
module.exports.getSigner = getSigner;

let config;
function getConfig() {
  if (config) return config;
  try {
    config = require("../config.json");
  } catch (e) {
    if (e.code == "MODULE_NOT_FOUND") {
      console.log(
        "No config file found. Using default configuration... (config.example.json)"
      );
      config = require("../config.example.json");
    } else {
      throw e;
      process.exit(1);
    }
  }
  return config;
}
module.exports.getConfig = getConfig;

function getKnownAuthorities() {
  let knownAuthorities;
  return function(refresh = false) {
    if (knownAuthorities && !refresh) return knownAuthorities;
    try {
      knownAuthorities = require("../fixtures/knownAuthorities.json");
    } catch (e) {
      try {
        knownAuthorities = require("../fixtures/knownAuthorities.example.json");
      } catch (e) {}
    }
    knownAuthorities = new Map(
      Object.entries(knownAuthorities || {}).map(([key, value]) => [
        key.toLowerCase(),
        value
      ])
    );
    return knownAuthorities;
  };
}

module.exports.getKnownAuthorities = getKnownAuthorities();

function createUpdateScheduler(duration) {
  let timeout;
  return function update(fn, ...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      fn.apply(null, args);
      update(fn, ...args);
    }, duration);
  };
}

module.exports.createUpdateScheduler = createUpdateScheduler;

// module.exports.scheduleUpdate = function scheduleUpdate(fn, interval) {
//   setTimeout(fn, interval);
// };
