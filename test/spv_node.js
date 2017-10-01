var Trust = require("../");
var helpers = require("../lib/helpers.js");
var bcoin = require("bcoin");
var Script = bcoin.script;
var Address = bcoin.primitives.Address;
var KeyRing = bcoin.primitives.KeyRing;
var MTX = bcoin.primitives.MTX;
var Input = bcoin.primitives.Input;
var Output = bcoin.primitives.Output;
var Outpoint = bcoin.primitives.Outpoint;
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

  beforeEach("get SPV node", async () => {
    spvNode = await testHelpers.getNode("spv");
    spvWatcher = new testHelpers.NodeWatcher(spvNode);
  });

  beforeEach("get miner (full node)", async () => {
    miner = await testHelpers.getNode("full");
    minerWatcher = new testHelpers.NodeWatcher(miner);
  });

  beforeEach("get spvWalletDB", async () => {
    spvWalletDB = await testHelpers.getWalletDB(spvNode);
  });

  beforeEach("get minerWalletDB", async () => {
    minerWalletDB = await testHelpers.getWalletDB(miner);
  });
  
  afterEach("close spvWalletDB", async () => spvWalletDB.close());
  afterEach("close minerWalletDB", async () => minerWalletDB.close());

  afterEach("close SPV node", async () => spvNode.close());
  afterEach("close miner (full node)", async () => miner.close());

  it("should call trust.addTX() on every transaction", async function() {

    SPVWalletDB = await testHelpers.openNode(SPVNode);
    var receiver = await testHelpers.createWallet(SPVWalletDB, "receiver");
    testHelpers.closeNode(SPVWalletDB, SPVNode);
    await testHelpers.delay(1000);
    minerWalletDB = await testHelpers.openNode(miner);
    var sender = await testHelpers.createWallet(minerWalletDB, "sender");

    await testHelpers.delay(1000);
    // Produce a block and reward the sender, so that we have a coin to spend.
    await testHelpers.mineBlock(miner, sender.getAddress("base58"));

    // Make the coin spendable.
    consensus.COINBASE_MATURITY = 0;
    await testHelpers.delay(100);

    await sender.send({
      outputs: [{
        value: 10 * COIN,
        address: receiver.getAddress("base58")
      }]
    });
    await testHelpers.delay(1000);
    testHelpers.closeNode(minerWalletDB, miner);
    SPVWalletDB = await testHelpers.openNode(SPVNode);
    await SPVWatcher.waitForTX();
    
    SPVNode.trust.addTX.should.be.calledOnce();
    testHelpers.closeNode(SPVWalletDB, SPVNode);
  });

  describe("with the nobodyLikesFrank.json example", () => {
    var addresses, rings = {};

    beforeEach("apply graph transactions", async () => {
      addresses = {};

      for (var [name, keyRing] of Object.entries(fixtures.keyRings)) {
        addresses[name] = helpers.pubKeyToEntity(keyRing.getPublicKey());
      }

      // Alice mines three blocks, each rewards her with 50 spendable BTC
      consensus.COINBASE_MATURITY = 0;
      var blockCount = 3;
      var coinbaseHashes = [];
      for(let i = 0; i < blockCount; i++) {
        var block = await testHelpers.mineBlock(node, addresses.alice);
        coinbaseHashes.push(block.txs[0].hash());
        await testHelpers.delay(500);
      }

      // Alice sends 20 BTC to everyone (including herself) via P2PKH
      var sendAmount = 20;
      var outputs = fixtures.names.map((name) => {
        return testHelpers.getP2PKHOutput(
            Address.fromHash(bcoin.crypto.hash160(fixtures.keyRings[name].getPublicKey()))
                .toBase58(),
            sendAmount * consensus.COIN);
      });

      // We have to use a change output, because transaction with too large a fee are considered
      // invalid.
      var fee = 0.01;
      var changeAmount = 50 * blockCount - sendAmount * fixtures.names.length - fee;
      if (changeAmount >= 0.01) {
        outputs.push(new Output({
          script: Script.fromPubkeyhash(bcoin.crypto.hash160(
              fixtures.keyRings.alice.getPublicKey())),
          value: changeAmount * consensus.COIN
        }));
      }

      // Use the coinbase coins as inputs
      var coinbaseCoins = await Promise.all(coinbaseHashes.map((hash) => {
        return node.getCoin(hash.toString("hex"), 0);
      }));
      var mtx = new MTX({outputs});
      coinbaseCoins.forEach((coin) => mtx.addCoin(coin));

      var signedCount = mtx.sign(fixtures.keyRings.alice);
      assert(signedCount === blockCount);
      assert(await mtx.verify());
      
      var tx = mtx.toTX();
      node.sendTX(tx);
      await watcher.waitForTX();

      prevout = {};
      fixtures.names.forEach((name) => {
        prevout[name] = {
          hash: tx.hash().toString("hex"),
          index: fixtures.names.indexOf(name)
        };
      });
      
      // Alice mines another block
      await testHelpers.mineBlock(node, helpers.pubKeyToEntity(
          fixtures.keyRings.alice.getPublicKey()));
      await testHelpers.delay(500);

      var graph = require("./graphs/nobodyLikesFrank.json");
      for (var origin in graph) {
        var neighbours = graph[origin];
        for (var dest in neighbours) {
          var value = neighbours[dest];
          if (!value || value < 1) continue;

          let outpoint = new Outpoint(prevout[origin].hash, prevout[origin].index);
					
          let mtx = await node.trust.createTrustIncreasingMTX(
              fixtures.keyRings[origin].getPrivateKey(),
              fixtures.keyRings[dest].getPublicKey(),
              outpoint,
              value * consensus.COIN);
					
          assert(await mtx.verify());

          let tx = mtx.toTX();
          node.sendTX(tx);
          await watcher.waitForTX();
					
          prevout[origin] = {hash: tx.hash().toString("hex"), index: 1};
        }
      }
      
      // Alice mines yet another block
      await testHelpers.mineBlock(node, helpers.pubKeyToEntity(
          fixtures.keyRings.alice.getPublicKey()));
      await testHelpers.delay(500);
    });

    it("computes trusts correctly", () => {
      for (name in addresses) { // Add addresses to scope
        eval(`var ${name} = "${addresses[name]}";`);
      }	

      should(node.trust.getIndirectTrust(alice, alice)).equal(Infinity);
      should(node.trust.getIndirectTrust(alice, bob)).equal(10 * COIN);
      should(node.trust.getIndirectTrust(alice, charlie)).equal(1 * COIN);
      should(node.trust.getIndirectTrust(alice, frank)).equal(0);
      should(node.trust.getIndirectTrust(alice, eve)).equal(6 * COIN);

      should(node.trust.getIndirectTrust(bob, alice)).equal(1 * COIN);
      should(node.trust.getIndirectTrust(bob, eve)).equal(3 * COIN);
      should(node.trust.getIndirectTrust(dave, eve)).equal(12 * COIN);
      should(node.trust.getIndirectTrust(george, eve)).equal(0);
    });

    it("after decreasing some trusts computes trusts correctly", async () => {
      var mtxs = node.trust.createTrustDecreasingMTXs(fixtures.keyRings.alice.getPrivateKey(),
          fixtures.keyRings.bob.getPublicKey(), 3 * COIN);
      mtxs.length.should.equal(1);
      var mtx = mtxs[0];

      should(await mtx.verify());
      node.sendTX(mtx.toTX());

      await testHelpers.delay(750);
      should(node.trust.getIndirectTrust(addresses.alice, addresses.bob)).equal(7 * COIN);
    });
  });

  describe("with the topcoder.json example", () => {
    //TODO: Write tests here.
  });
});
