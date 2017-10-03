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

  before("set up addTX() spy", function() {
    sinon.spy(Trust.TrustIsRisk.prototype, "addTX");
  });

  after("reset addTX spy", function() {
    return Trust.TrustIsRisk.prototype.addTX.restore();
  });

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
    var spvSender = await testHelpers.createWallet(spvWalletDB, "spvSender");
    var spvReceiver = await testHelpers.createWallet(spvWalletDB, "spvReceiver");

    var minerSender = await testHelpers.createWallet(minerWalletDB, "minerSender");
    var minerReceiver = await testHelpers.createWallet(minerWalletDB, "minerReceiver");

    await testHelpers.delay(1000);
    // Produce a block and reward the minerSender, so that we have a coin to spend.
    await testHelpers.mineBlock(miner, minerSender.getAddress("base58"));

    // Make the coin spendable.
    consensus.COINBASE_MATURITY = 0;
    await testHelpers.delay(100);

    await minerSender.send({
      outputs: [{
        value: 10 * COIN,
        address: minerReceiver.getAddress("base58")
      }]
    });
    await minerWatcher.waitForTX();
    
    miner.trust.addTX.should.be.calledOnce();
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
        var block = await testHelpers.mineBlock(miner, addresses.alice);
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

      // We have to use a change output, because transactions with too large a fee are
      // considered invalid.
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
        return miner.getCoin(hash.toString("hex"), 0);
      }));
      var mtx = new MTX({outputs});
      coinbaseCoins.forEach((coin) => mtx.addCoin(coin));

      var signedCount = mtx.sign(fixtures.keyRings.alice);
      assert(signedCount === blockCount);
      assert(await mtx.verify());
      
      var tx = mtx.toTX();
      miner.sendTX(tx);
      await minerWatcher.waitForTX();

      prevout = {};
      fixtures.names.forEach((name) => {
        prevout[name] = {
          hash: tx.hash().toString("hex"),
          index: fixtures.names.indexOf(name)
        };
      });
      
      // Alice mines another block
      await testHelpers.mineBlock(miner, helpers.pubKeyToEntity(
          fixtures.keyRings.alice.getPublicKey()));
      await testHelpers.delay(500);

      var graph = require("./graphs/nobodyLikesFrank.json");
      for (var origin in graph) {
        var neighbours = graph[origin];
        for (var dest in neighbours) {
          var value = neighbours[dest];
          if (!value || value < 1) continue;

          let node = null;
          let watcher = null;
          if (origin === "charlie" || origin == "dave") {
            node = spvNode;
            watcher = spvWatcher;
          }
          else {
            node = miner;
            watcher = minerWatcher;
          }

          let outpoint = new Outpoint(prevout[origin].hash, prevout[origin].index);

          let mtx = null;
          if (node.spv) console.log(await spvWalletDB.getHashes());
          else {mtx = await node.trust.createTrustIncreasingMTX(
              fixtures.keyRings[origin].getPrivateKey(),
              fixtures.keyRings[dest].getPublicKey(),
              outpoint,
              value * consensus.COIN);
            console.log(await minerWalletDB.getHashes());}
					
          assert(await mtx.verify());

          let tx = mtx.toTX();
          node.sendTX(tx);
          await watcher.waitForTX();
					
          prevout[origin] = {hash: tx.hash().toString("hex"), index: 1};
        }
      }
      
      // Alice mines yet another block
      await testHelpers.mineBlock(miner, helpers.pubKeyToEntity(
          fixtures.keyRings.alice.getPublicKey()));
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
      var mtxs = miner.trust.createTrustDecreasingMTXs(fixtures.keyRings.alice.getPrivateKey(),
          fixtures.keyRings.bob.getPublicKey(), 3 * COIN);
      mtxs.length.should.equal(1);
      var mtx = mtxs[0];

      should(await mtx.verify());
      miner.sendTX(mtx.toTX());

      await testHelpers.delay(750);
      should(miner.trust.getIndirectTrust(addresses.alice, addresses.bob)).equal(7 * COIN);
      should(spvNode.trust.getIndirectTrust(addresses.alice, addresses.bob)).equal(7 * COIN);

      mtxs = spvNode.trust.createTrustDecreasingMTXs(fixtures.keyRings.dave.getPrivateKey(),
      fixtures.keyRings.eve.getPublicKey(), 2 * COIN);
      mtxs.length.should.equal(1);
      mtx = mtxs[0];

      should(await mtx.verify());
      spvNode.sendTX(mtx.toTX());

      await testHelpers.delay(750);
      should(miner.trust.getIndirectTrust(addresses.dave, addresses.eve)).equal(10 * COIN);
      should(spvNode.trust.getIndirectTrust(addresses.dave, addresses.eve)).equal(10 * COIN);
    });
  });

  describe("with the topcoder.json example", () => {
    //TODO: Write tests here.
  });
});
