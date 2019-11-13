const Web3 = require("web3");

const ABI = require("../abi/bios");
const {
  getConfig,
  getKnownAuthorities,
  createUpdateScheduler
} = require("../utils");
const config = getConfig();

let rootAuthorities = (config.rootAuthorities !== undefined
  ? config.rootAuthorities
  : []
).map(address => address.toLowerCase());

let knownAuthorities = getKnownAuthorities();
// Every minute update knownAuthorities map
createUpdateScheduler(60 * 1000)(getKnownAuthorities, true);

require("../db.js");
const mongoose = require("mongoose");
const Transaction = mongoose.model("Transaction");
const Authority = mongoose.model("Authority");
const AuthoritySlot = mongoose.model("AuthoritySlot");
const AuthorityInfo = mongoose.model("AuthorityInfo");
const Blacklist = mongoose.model("Blacklist");
const Poll = mongoose.model("Poll");

const SYNC_TIMEOUT = 1000;
const SIGNATURES = {
  voteForNewAuthority: "0xfc3c9afd",
  voteForBlackListAuthority: "0x332327a2"
};

console.log(`Connecting ${config.nodeAddr}:${config.wsPort}...`);
const web3 = new Web3(
  new Web3.providers.WebsocketProvider(
    `ws://${config.nodeAddr}:${config.wsPort}`
  )
);
if (web3.eth.net.isListening()) console.log("Web3 connection established");
const contract = new web3.eth.Contract(ABI, config.biosAddress);

const callMethod = (method, ...args) =>
  contract.methods[method](...args).call();

const getAuthorities = async () => {
  const authorities = await callMethod("getAuthorities");
  const data = await Promise.all(
    authorities.map(address => callMethod("getAuthorityState", address))
  );
  return authorities.map((address, index) => ({
    address,
    votes: parseInt(data[index][0], 10),
    slots: data[index][1].map((a, i) => ({
      address: a,
      timestamp: parseInt(data[index][2][i], 10)
    }))
  }));
};

const getBlacklisted = async () => {
  const blacklisted = await callMethod("getAuthorityBlacklistPollAddresses");
  const results = await Transaction.aggregate([
    {
      $match: {
        $and: [
          {
            input: new RegExp("^" + SIGNATURES.voteForBlackListAuthority, "gi")
          },
          { status: { $ne: null } }
        ]
      }
    },
    {
      $group: {
        _id: "$input",
        count: { $sum: 1 }
      }
    }
  ]);
  return blacklisted.map(address => {
    const match = results.find(res =>
      new RegExp(address.substr(2).toLowerCase(), "gi").test(res._id)
    );
    return {
      address,
      votes: (match && match.count) || 0
    };
  });
};

const getNewAuthorityPolls = async () => {
  const addresses = await callMethod("getAddNewPollAddresses");
  const data = await Promise.all(
    addresses.map(address => callMethod("addNewPoll", address))
  );
  return addresses.map((address, index) => ({
    address,
    closeTime: data[index].closeTime,
    votes: parseInt(data[index].votes, 10)
  }));
};

const getBlacklistPolls = async () => {
  const addresses = await callMethod("getAuthorityBlacklistPollAddresses");
  const data = await Promise.all(
    addresses.map(address => callMethod("authorityBlacklistPoll", address))
  );
  return addresses.map((address, index) => ({
    address,
    closeTime: data[index].closeTime,
    votes: parseInt(data[index].votes, 10),
    isVoted: data[index].voted || false
  }));
};

function saveAuthorityInfoAndRunCb({ address } = {}, callback) {
  if (!address) {
    throw new Error("Can't create Authority Info");
  }
  const lowercasedAddress = address.toLowerCase();
  const updates = {};
  if (knownAuthorities.has(lowercasedAddress)) {
    const knownAuthority = knownAuthorities.get(lowercasedAddress);
    for (let key in knownAuthority) {
      if (["website", "name", "logotype"].includes(key)) {
        updates[key] = knownAuthority[key];
      }
    }
  }
  AuthorityInfo.findOneAndUpdate(
    { address: address },
    updates,
    { upsert: true, setDefaultsOnInsert: true, new: true },
    (err, doc) => {
      callback(err, doc);
    }
  );
}

const saveOrUpdateAuthorities = authorities => {
  authorities.forEach(authority => {
    const { address, votes } = authority;
    const slots = authority.slots.map(({ address, timestamp }) =>
      AuthoritySlot({ address, timestamp })
    );
    saveAuthorityInfoAndRunCb(authority, (err, doc) => {
      Authority.update(
        { address: address },
        {
          address,
          slots,
          votes: rootAuthorities.includes(address.toLowerCase())
            ? votes - 1
            : votes,
          info: doc._id
        },
        { upsert: true, setDefaultsOnInsert: true },
        (err, data) => {
          if (err) console.log(err);
        }
      );
    });
  });
};

const saveOrUpdateBlacklist = blacklist => {
  blacklist.forEach(bl => {
    const { address, votes } = bl;
    saveAuthorityInfoAndRunCb(bl, (err, doc) => {
      Blacklist.update(
        { address: address },
        { address, votes, info: doc._id },
        { upsert: true, setDefaultsOnInsert: true },
        (err, data) => {
          if (err) console.log(err);
        }
      );
    });
  });
};

const saveOrUpdatePolls = (polls, type = 0) => {
  if (![0, 1].includes(type)) return;

  polls.forEach(poll => {
    const { address } = poll;
    saveAuthorityInfoAndRunCb(poll, (err, doc) => {
      Poll.update(
        { address },
        { ...poll, type, info: doc._id },
        { upsert: true, setDefaultsOnInsert: true },
        (err, data) => {
          if (err) console.log(err);
        }
      );
    });
  });
};

const disableFinalisedPolls = addressesToDelete => {
  Poll.updateMany(
    { address: { $nin: addressesToDelete }, isDisabled: false },
    { $set: { isDisabled: true } },
    (err, data) => {
      if (err) console.log(err);
    }
  );
};

const saveOrUpdateData = async (
  authorities,
  authorityPolls,
  blacklist,
  blacklistPolls
) => {
  saveOrUpdateAuthorities(authorities);
  saveOrUpdateBlacklist(blacklist);
  disableFinalisedPolls(
    [...authorityPolls, ...blacklistPolls].map(p => p.address)
  );
  saveOrUpdatePolls(authorityPolls, 0);
  saveOrUpdatePolls(blacklistPolls, 1);
};

let timeout;
const syncronize = async () => {
  clearTimeout(timeout);
  try {
    const [
      authorities,
      authorityPolls,
      blacklist,
      blacklistPolls
    ] = await Promise.all([
      getAuthorities(),
      getNewAuthorityPolls(),
      getBlacklisted(),
      getBlacklistPolls()
    ]);
    saveOrUpdateData(authorities, authorityPolls, blacklist, blacklistPolls);
  } finally {
    setTimeout(syncronize, SYNC_TIMEOUT);
  }
};

syncronize();
