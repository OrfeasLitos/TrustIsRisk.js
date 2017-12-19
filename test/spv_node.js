var Trust = require("../");
var helpers = require("../lib/helpers.js");
var bcoin = require("bcoin").set("regtest");
var Script = bcoin.script;
var Address = bcoin.primitives.Address;
var KeyRing = bcoin.primitives.KeyRing;
var MTX = bcoin.primitives.MTX;
var Input = bcoin.primitives.Input;
var Output = bcoin.primitives.Output;
var Outpoint = bcoin.primitives.Outpoint;
var WalletDB = bcoin.wallet.WalletDB;
var EC = bcoin.crypto.ec;
var testHelpers = require("./helpers");
var consensus = require("bcoin/lib/protocol/consensus");
var sinon = require("sinon");
var should = require("should");
var assert = require("assert");
var fixtures = require("./fixtures");
require("should-sinon");

const COIN = consensus.COIN;

describe("SPVNode", () => {
  var spvNode = null;
  var miner = null;
  var spvWalletDB = null;
  var minerWalletDB = null;
  var spvWatcher = null;
  var minerWatcher = null;

  before("set up addTX() spy", function() {
    sinon.spy(Trust.TrustIsRisk.prototype, "addTX");
  });

  after("reset addTX() spy", function() {
    Trust.TrustIsRisk.prototype.addTX.restore();
  });

  beforeEach("connect SPV node and wallet", async () => {
    spvNode = new Trust.SPVNode({
      network: bcoin.network.get().toString(),
      port: 48445,
      passphrase: "secret",
      // logConsole: true,
      // logLevel: "debug",
      nodes: ["127.0.0.1:48448"]
    });
    await spvNode.open();
    spvWalletDB = await testHelpers.getWalletDB(spvNode);
    await spvNode.connect();
  });

  beforeEach("connect full node and wallet", async () => {
    miner = new Trust.FullNode({
      network: bcoin.network.get().toString(),
      port: 48448,
      bip37: true,
      listen: true,
      passphrase: "secret"
    });
    await miner.open();
    minerWalletDB = await testHelpers.getWalletDB(miner);
    await miner.connect();
  });

  beforeEach("start syncing", () => {
    miner.startSync();
    spvNode.startSync();
  });

  beforeEach("get watchers", async () => {
    minerWatcher = new testHelpers.NodeWatcher(miner);
    spvWatcher = new testHelpers.NodeWatcher(spvNode);
  });

  afterEach("disconnect nodes", async () => {
    spvNode.stopSync();
    miner.stopSync();

    await spvNode.disconnect();
    await miner.disconnect();
  });

  afterEach("disconnect and close walletDBs", async () => {
    await spvWalletDB.disconnect();
    await minerWalletDB.disconnect();

    await spvWalletDB.close();
    await minerWalletDB.close();
  });

  afterEach("close nodes", async () => {
    await spvNode.close();
    await miner.close();
  });

  it.only("should match a TIR transaction with the spv bloom filter", async function() {
    var fakePubKeyArray = [0x04,            // constant 0x04 prefix
      0x54, 0x72, 0x75, 0x73, 0x74, 0x20, 0x69, 0x73,
      0x20, 0x52, 0x69, 0x73, 0x6b, 0x00, 0x00, 0x00,    // 32 bytes with the x coordinate
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,    // containing ASCII "Trust is Risk"
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
                                                         // secp256k1 curve: y^2 = x^3 + 7
      0x05, 0x5d, 0x5f, 0x28, 0x5e, 0xd7, 0x9d, 0x0c,
      0x6f, 0x61, 0xc3, 0x0e, 0xfc, 0x9d, 0x21, 0x91,
      0x65, 0x82, 0x80, 0x59, 0xa6, 0x01, 0x25, 0x0c,    // 32 bytes with the y coordinate
      0x8e, 0xce, 0x18, 0x00, 0x14, 0xde, 0x48, 0x1a];

    var tag = Buffer.from(fakePubKeyArray);

    var wallet1 = await testHelpers.createWallet(minerWalletDB, "wallet1");
    var privateKey1 = (await wallet1.getPrivateKey(
        wallet1.getAddress("base58"), "secret")
    ).privateKey;
    var origin = EC.publicKeyCreate(privateKey1, true);

    var wallet2 = await testHelpers.createWallet(minerWalletDB, "wallet2");
    var privateKey2 = (await wallet2.getPrivateKey(
        wallet2.getAddress("base58"), "secret")
    ).privateKey;
    var dest = EC.publicKeyCreate(privateKey2, true);

    var block = await testHelpers.mineBlock(miner, wallet1.getAddress("base58"));

    // Make the coin spendable.
    consensus.COINBASE_MATURITY = 0;
    await testHelpers.delay(500);

    var outputs = [
      new Output({ // 1-of-3 multisig trust
        script: bcoin.script.fromMultisig(1, 3, [origin, dest, tag]),
        value: 49 * consensus.COIN
      }),
      new Output({ // paytopubkeyhash change
        script: bcoin.script.fromPubkeyhash(bcoin.crypto.hash160(origin)),
        value: consensus.COIN - 100000 // leave a fee of 0.001 BTC
      })
    ];
    var mtx = new MTX({outputs});
    var coinbaseCoin = await miner.getCoin(block.txs[0].hash().toString("hex"), 0);
    mtx.addCoin(coinbaseCoin);

    mtx.sign(KeyRing.fromPrivate(privateKey1, true, "regtest"));
    should(await mtx.verify()).be.true();
    var tx = mtx.toTX();

    tx.isWatched(spvNode.pool.spvFilter).should.be.true();
  });

  it("should call trust.addTX() on every transaction", async function() {
    var spvWallet1 = await testHelpers.createWallet(spvWalletDB, "spvWallet1");
    var spvWallet2 = await testHelpers.createWallet(spvWalletDB, "spvWallet2");

    var minerWallet1 = await testHelpers.createWallet(minerWalletDB, "minerWallet1");
    var minerWallet2 = await testHelpers.createWallet(minerWalletDB, "minerWallet2");

    spvNode.pool.watchAddress(minerWallet1.getAddress());
    spvNode.pool.watchAddress(minerWallet2.getAddress());

    spvNode.pool.watchAddress(spvWallet1.getAddress());
    spvNode.pool.watchAddress(spvWallet2.getAddress());

    await testHelpers.delay(1000);
    // Produce a block and reward the minerWallet1, so that we have a coin to spend.
    await testHelpers.mineBlock(miner, minerWallet1.getAddress("base58"));

    // Make the coin spendable.
    consensus.COINBASE_MATURITY = 0;
    await testHelpers.delay(100);

    var miner2TX = await minerWallet1.send({
      outputs: [{
        value: 10 * COIN,
        address: minerWallet2.getAddress("base58")
      }]
    });
    await minerWatcher.waitForTX(miner2TX);
    await spvWatcher.waitForTX(miner2TX);

    Trust.TrustIsRisk.prototype.addTX.should.have.been.calledTwice();

    var minerSpvTX = await minerWallet2.send({
      outputs: [{
        value: 9 * COIN,
        address: spvWallet1.getAddress("base58")
      }]
    });
    await minerWatcher.waitForTX(minerSpvTX);
    await spvWatcher.waitForTX(minerSpvTX);

    should(Trust.TrustIsRisk.prototype.addTX.callCount).equal(4);

    var spv2TX = await spvWallet1.send({
      outputs: [{
        value: 8 * COIN,
        address: spvWallet2.getAddress("base58")
      }]
    });
    await spvWatcher.waitForTX(spv2TX);
    await minerWatcher.waitForTX(spv2TX);

    should(Trust.TrustIsRisk.prototype.addTX.callCount).equal(6);

    var spvMinerTX = await spvWallet2.send({
      outputs: [{
        value: 7 * COIN,
        address: minerWallet1.getAddress("base58")
      }]
    });
    await spvWatcher.waitForTX(spvMinerTX);
    await minerWatcher.waitForTX(spvMinerTX);

    var view = await miner.chain.db.getSpentView(miner2TX);
    var actualBalance = (await minerWallet1.getBalance()).unconfirmed;
    var expectedBalance =
        consensus.BASE_REWARD - 10 * COIN + 7 * COIN - miner2TX.getFee(view);
    should(actualBalance).equal(expectedBalance);
    should(Trust.TrustIsRisk.prototype.addTX.callCount).equal(8);
  });

  describe("with the nobodyLikesFrank.json example", () => {
    var minerNames = {
      "alice": "alice",
      "bob": "bob",
      "eve": "eve",
      "frank": "frank",
      "george": "george"
    };

    var spvNames = {
      "charlie": "charlie",
      "dave": "dave"
    };

    var minerWallets = {};
    var spvWallets = {};

    var addresses = {}, rings = {}, name = null;

    beforeEach("apply graph transactions", async () => {
      for (name in minerNames) {
        minerWallets[name] = await testHelpers.createWallet(
            minerWalletDB, name
        );
        rings[name] = await minerWallets[name].getPrivateKey(
            minerWallets[name].getAddress("base58"), "secret"
        );
        addresses[name] = helpers.pubKeyToEntity(
            rings[name].getPublicKey(), miner.network
        );
        spvNode.pool.watchAddress(addresses[name]);
      }

      for (name in spvNames) {
        spvWallets[name] = await testHelpers.createWallet(
            spvWalletDB, name
        );
        rings[name] = await spvWallets[name].getPrivateKey(
            spvWallets[name].getAddress("base58"), "secret"
        );
        addresses[name] = helpers.pubKeyToEntity(
            rings[name].getPublicKey(), spvNode.network
        );
        spvNode.pool.watchAddress(addresses[name]);
      }

      // Alice mines three blocks, each rewards her with 50 spendable BTC
      consensus.COINBASE_MATURITY = 0;
      var blockCount = 3;
      var coinbaseHashes = [];
      for(let i = 0; i < blockCount; i++) {
        var block = await testHelpers.mineBlock(
            miner, addresses["alice"]
        );
        coinbaseHashes.push(block.txs[0].hash());
        await testHelpers.delay(500);
      }

      // Alice sends 20 BTC to everyone (including herself) via P2PKH
      var sendAmount = 20;
      outputs = [];
      for (name in minerNames) {
        outputs.push(testHelpers.getP2PKHOutput(
            addresses[name], sendAmount * consensus.COIN
        ));
      }

      for (name in spvNames) {
        outputs.push(testHelpers.getP2PKHOutput(
            addresses[name], sendAmount * consensus.COIN
        ));
      }

      // We have to use a change output, because transactions with too large a fee are
      // considered invalid.
      var fee = 0.01;
      var changeAmount = 50 * blockCount - sendAmount *
         (Object.keys(minerNames).length + Object.keys(spvNames).length) - fee;
      if (changeAmount >= 0.01) {
        outputs.push(new Output({
          script: Script.fromPubkeyhash(bcoin.crypto.hash160(
              rings["alice"].publicKey)),
          value: changeAmount * consensus.COIN
        }));
      }

      // Use the coinbase coins as inputs
      var coinbaseCoins = await Promise.all(coinbaseHashes.map((hash) => {
        return miner.getCoin(hash.toString("hex"), 0);
      }));
      var mtx = new MTX({outputs});
      coinbaseCoins.forEach((coin) => mtx.addCoin(coin));

      var signedCount = mtx.sign(rings["alice"]);
      assert(signedCount === blockCount);
      assert(await mtx.verify());

      var tx = mtx.toTX();

      miner.sendTX(tx);
      await minerWatcher.waitForTX(tx);
      await spvWatcher.waitForTX(tx);

      for(name in minerNames) {
        minerWallets[name].db.addTX(tx);
      }

      for(name in spvNames) {
        spvWallets[name].db.addTX(tx);
      }

      var prevout = {};
      var counter = 0;

      for (name in minerNames) {
        prevout[name] = {
          hash: tx.hash().toString("hex"),
          index: counter++
        };
      }

      for (name in spvNames) {
        prevout[name] = {
          hash: tx.hash().toString("hex"),
          index: counter++
        };
      }

      // Alice mines another block
      await testHelpers.mineBlock(miner, addresses["alice"]);
      await testHelpers.delay(500);

      var graph = require("./graphs/nobodyLikesFrank.json");
      for (var origin in graph) {
        let node = null;
        let watcher = null;
        let originWallet = null;
        let destWallet = null;

        if (spvNames[origin]) {
          node = spvNode;
          watcher = spvWatcher;
          originWallet = spvWallets[origin];
        }

        else {
          node = miner;
          watcher = minerWatcher;
          originWallet = minerWallets[origin];
        }

        var neighbours = graph[origin];

        for (var dest in neighbours) {
          var value = neighbours[dest];
          if (!value || value < 1) continue;

          destWallet = (spvNames[dest]) ? spvWallets[dest]
              : minerWallets[dest];

          let outpoint = new Outpoint(prevout[origin].hash,
              prevout[origin].index);

          let mtx = null;
          if (node.spv) {
            mtx = await node.trust.ccreateTrustIncreasingMTX(
                rings[origin].getPrivateKey(),
                rings[dest].getPublicKey(),
                outpoint,
                value * consensus.COIN,
                spvWallets[origin]);
          }
          else { // if full node
            mtx = await node.trust.createTrustIncreasingMTX(
                rings[origin].getPrivateKey(),
                rings[dest].getPublicKey(),
                outpoint,
                value * consensus.COIN);
          }

          assert(await mtx.verify());

          let tx = mtx.toTX();

          node.sendTX(tx);
          await watcher.waitForTX();

          await originWallet.db.addTX(tx);
          await destWallet.db.addTX(tx);

          prevout[origin] = {hash: tx.hash().toString("hex"), index: 1};
        }
      }

      // Alice mines yet another block
      await testHelpers.mineBlock(miner, helpers.pubKeyToEntity(
          rings["alice"].getPublicKey(), miner.network
      ));
      await testHelpers.delay(500);
    });

    it("lets the miner compute trusts correctly", () => {
      for (name in addresses) { // Add addresses to scope
        eval(`var ${name} = "${addresses[name]}";`);
      }

      should(miner.trust.getIndirectTrust(alice, alice)).equal(Infinity);
      should(miner.trust.getIndirectTrust(alice, bob)).equal(10 * COIN);
      should(miner.trust.getIndirectTrust(alice, charlie)).equal(1 * COIN);
      should(miner.trust.getIndirectTrust(alice, frank)).equal(0);
      should(miner.trust.getIndirectTrust(alice, eve)).equal(6 * COIN);

      should(miner.trust.getIndirectTrust(bob, alice)).equal(1 * COIN);
      should(miner.trust.getIndirectTrust(bob, eve)).equal(3 * COIN);
      should(miner.trust.getIndirectTrust(dave, eve)).equal(12 * COIN);
      should(miner.trust.getIndirectTrust(george, eve)).equal(0);
    });

    it("lets the SPV node compute trusts correctly", () => {
      for (name in addresses) { // Add addresses to scope
        eval(`var ${name} = "${addresses[name]}";`);
      }

      should(spvNode.trust.getIndirectTrust(alice, alice)).equal(Infinity);
      should(spvNode.trust.getIndirectTrust(alice, bob)).equal(10 * COIN);
      should(spvNode.trust.getIndirectTrust(alice, charlie)).equal(1 * COIN);
      should(spvNode.trust.getIndirectTrust(alice, frank)).equal(0);
      should(spvNode.trust.getIndirectTrust(alice, eve)).equal(6 * COIN);

      should(spvNode.trust.getIndirectTrust(bob, alice)).equal(1 * COIN);
      should(spvNode.trust.getIndirectTrust(bob, eve)).equal(3 * COIN);
      should(spvNode.trust.getIndirectTrust(dave, eve)).equal(12 * COIN);
      should(spvNode.trust.getIndirectTrust(george, eve)).equal(0);
    });

    it("after decreasing some trusts lets both nodes compute trusts correctly", async () => {
      var mtxs = miner.trust.createTrustDecreasingMTXs(
          rings["alice"].getPrivateKey(),
          rings["bob"].getPublicKey(), 3 * COIN
      );
      mtxs.length.should.equal(1);
      var mtx = mtxs[0];

      should(await mtx.verify()).be.true();
      var tx = mtx.toTX();
      miner.sendTX(tx);

      await testHelpers.delay(3000);
      await minerWatcher.waitForTX(tx);
      await spvWatcher.waitForTX(tx);
      should(miner.trust.getIndirectTrust(addresses["alice"],
          addresses["bob"])).equal(7 * COIN);
      should(spvNode.trust.getIndirectTrust(addresses["alice"],
          addresses["bob"])).equal(7 * COIN);

      mtxs = spvNode.trust.createTrustDecreasingMTXs(
          rings["dave"].getPrivateKey(),
          rings["eve"].getPublicKey(), 2 * COIN
      );
      mtxs.length.should.equal(1);
      mtx = mtxs[0];

      should(await mtx.verify()).be.true();
      spvNode.sendTX(mtx.toTX());

      await minerWatcher.waitForTX();
      await spvWatcher.waitForTX();
      should(miner.trust.getIndirectTrust(addresses["dave"],
          addresses["eve"])).equal(10 * COIN);
      should(spvNode.trust.getIndirectTrust(addresses["dave"],
          addresses["eve"])).equal(10 * COIN);
    });
  });

  describe("with the topcoder.json example", () => {
    //TODO: Write tests here.
  });
});
