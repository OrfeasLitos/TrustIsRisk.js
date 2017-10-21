var TrustIsRisk = require("../");
var WalletDB = require("bcoin/lib/wallet/walletdb");
var bcoin = require("bcoin");
var fixtures = require("./fixtures");
var assert = require("assert");

var testHelpers = {
  getNode: async (type) => {
    var node = new TrustIsRisk.FullNode({network: "regtest", passphrase: "secret"});
    await node.open();

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

  testnetCreateWallet: async (walletDB, id) => {
    const keys = {
      "spvSender": "cQzGHhucP26iPJf4fFSpLBXBN7V99mx7hBXDXm3FfQAEz9UKiDHT",
      "spvReceiver": "cSapdQj9U6XwhePBjv3YeQrctodr2imWm2dV1u83e1SWdBFUuVo1",
      "minerSender": "cUw1SoP2DBd6RufEs2bV7nHwoUFi382h5SpaLtBy9zXrjGqs9S3U", // this has the faucet coins
      "minerReceiver": "cMjHoh7LRspQSVzJ6wps5XSGvn7jdidj2QhCRXDmaW48Pm9SGqCN"
    };
    var options = {
      id,
      passphrase: "secret",
      witness: false,
      type: "pubkeyhash",
      master: keys.id
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
    tag = (new TrustIsRisk.TrustIsRisk(new bcoin.fullnode({}))).fakePubKey;
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

  async waitForTX(input) {
    var initialCount = null;
    switch (typeof input) {
    case "number":
      initialCount = input;
      await new Promise((resolve, reject) => {
        var check = (() => {
          if (this.txCount > initialCount)
            resolve();
          else setTimeout(check, 100);
        }).bind(this);

        check();
      });
      break;

    case "undefined": // TODO: reuse code
      initialCount = this.txCount;
      await new Promise((resolve, reject) => {
        var check = (() => {
          if (this.txCount > initialCount)
            resolve();
          else setTimeout(check, 100);
        }).bind(this);

        check();
      });
      break;

    case "object":
      var tx = input;
      await new Promise((resolve, reject) => {
        var check = (() => {
          // This breaks node.pool.on("tx", ...)
          if (this.node.pool.hasTX(tx.hash().toString("hex")))
            resolve();
          else setTimeout(check, 100);
        }).bind(this);

        check();
      });
      break;

    default:
      throw new Error("input cannot be " + typeof input); // TODO: throw correct error
    }
  }
}

testHelpers.NodeWatcher = NodeWatcher;

module.exports = testHelpers;
