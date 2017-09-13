var TrustIsRisk = require("../");
var WalletDB = require("bcoin/lib/wallet/walletdb");
var bcoin = require("bcoin");
var fixtures = require("./fixtures");
var KeyRing = bcoin.primitives.KeyRing;
var assert = require("assert");

const fakePubKeyArray = [0x04,                     // constant 0x04 prefix
  0x54, 0x72, 0x75, 0x73, 0x74, 0x20, 0x69, 0x73,
  0x20, 0x52, 0x69, 0x73, 0x6b, 0x00, 0x00, 0x00,  // 32 bytes with the x coordinate
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // containing ASCII "Trust is Risk"
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
                                                   // secp256k1 curve: y^2 = x^3 + 7
  0x05, 0x5d, 0x5f, 0x28, 0x5e, 0xd7, 0x9d, 0x0c,
  0x6f, 0x61, 0xc3, 0x0e, 0xfc, 0x9d, 0x21, 0x91,
  0x65, 0x82, 0x80, 0x59, 0xa6, 0x01, 0x25, 0x0c,  // 32 bytes with the y coordinate
  0x8e, 0xce, 0x18, 0x00, 0x14, 0xde, 0x48, 0x1a];

const fakePubKey = Buffer.from(fakePubKeyArray);
const step2 = Buffer.from(bcoin.crypto.hash160(fakePubKey));
const step3 = Buffer.concat([Buffer.alloc(1), step2]);
const step4 = Buffer.from(bcoin.crypto.hash256(step3));
const step5 = step4.slice(0, 4);
const step6 = Buffer.concat([step3, step5]);
const tag = Buffer.from(bcoin.base58.encode(step6));

var testHelpers = {
  getNode: async () => {
    var node = new TrustIsRisk.FullNode({network: "regtest", passphrase: "secret"});

    await node.open();
    await node.connect();
    node.startSync();

    return node;
  },

  getWalletDB: async (node) => {
    var walletDB = new WalletDB({
      network: "regtest",
      db: "memory",
      client: new bcoin.node.NodeClient(node)
    });

    await walletDB.open();
    await walletDB.connect();

    return walletDB;
  },

  createWallet: async (walletDB, id) => {
    var options = {
      id,
      passphrase: "secret",
      witness: false,
      type: "pubkeyhash"
    };

    return walletDB.create(options); 
  },

  mineBlock: async (node, rewardAddress) => {
    var block = await node.miner.mineBlock(node.chain.tip, rewardAddress);
    await node.chain.add(block);
    // node.chain.tip does not contain all the properties we want,
    // so we need to fetch it:
    return node.getBlock(node.chain.tip.hash);
  },

  delay: async (milliseconds) => {
    return new Promise((resolve, reject) => {
      setTimeout(resolve, milliseconds);
    });
  },

  bufferToScript: (data) => {
    return `0x${Number(data.length).toString(16)} 0x${data.toString("hex")}`;
  },

  getP2PKHOutput: (dest, value) => {
    var address = bcoin.primitives.Address.fromBase58(dest);
    var script = bcoin.script.fromPubkeyhash(address.hash);
    
    return new bcoin.primitives.Output({script, value});
  },

  getP2PKHInput: (pubKey, prevout) => {
    if (!prevout) {
      prevout = { // Don't care
        hash: "v0pnhphaf4r5wz63j60vnh27s1bftl260qq621y458tn0g4x64u64yqz6d7qi6i8",
        index: 2
      };
    }

    return new bcoin.primitives.Input({
      prevout,
      script: bcoin.script.fromString(
          // Don't care about the signature
          "0x47 0x3044022035e32834c6ee4db1696cc06762feca2809d865ca12a3b98c801f3f451341a2570220573bf3ffef55f2651e1563acc0a22f8056222f277f5ddf17dd583d4edd40fa6001 "
          + testHelpers.bufferToScript(pubKey))
    }); 
  },

  getOneOfThreeMultisigOutput: (originPubKey, destPubKey, value) => {
    return new bcoin.primitives.Output({
      script: bcoin.script.fromMultisig(1, 3, [originPubKey, destPubKey, tag]),
      value
    });
  },

  getTrustIncreasingMTX: (originPubKey, destPubKey, value) => {
    return new bcoin.primitives.MTX({
      inputs: [
        testHelpers.getP2PKHInput(originPubKey)
      ],
      outputs: [
        testHelpers.getOneOfThreeMultisigOutput(originPubKey, destPubKey, value)
      ]
    });
  },

  applyGraph: (trust, fileName, addressBook) => {
    var graph = require(fileName);

    for (var origin in graph) {
      var neighbours = graph[origin];
      for (var dest in neighbours) {
        var value = neighbours[dest];
        trust.addTX(testHelpers.getTrustIncreasingMTX(addressBook[origin].pubKey, addressBook[dest].pubKey, value).toTX()); 
      }
    }
  }
};

class NodeWatcher {
  constructor(node) {
    this.txCount = 0;
    this.blockCount = 0;
    this.node = node;
    this.node.on("tx", this.onTX.bind(this));
    this.node.on("block", this.onBlock.bind(this));
  }

  onTX() {
    this.txCount++;
  }

  onBlock() {
    this.blockCount++;
  }

  async waitForBlock(initialCount) {
    if (initialCount === undefined) initialCount = this.blockCount;
    await new Promise((resolve, reject) => {
      var check = (() => {
        if (this.blockCount > initialCount) resolve();
        else setTimeout(check, 100);
      }).bind(this);

      check();
    });
  }

  async waitForTX(initialCount) {
    if (initialCount === undefined) initialCount = this.txCount;
    await new Promise((resolve, reject) => {
      var check = (() => {
        if (this.txCount > initialCount) resolve();
        else setTimeout(check, 100);
      }).bind(this);

      check();
    });
  }
}

testHelpers.NodeWatcher = NodeWatcher;

module.exports = testHelpers;
