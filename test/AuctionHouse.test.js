const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const COMMIT = 3 * DAY;
const REVEAL = 2 * DAY;
const RESERVE = ethers.parseEther("1");

const NONCE = {
  alice: ethers.id("alice-secret-nonce"),
  bob: ethers.id("bob-secret-nonce"),
  carol: ethers.id("carol-secret-nonce"),
};

const Bidding = 0n;
const Revealing = 1n;
const Settled = 2n;
const Cancelled = 3n;

async function deployFixture() {
  const [seller, alice, bob, carol, stranger] = await ethers.getSigners();

  const nft = await (await ethers.getContractFactory("MockNFT")).deploy();
  const house = await (await ethers.getContractFactory("AuctionHouse")).deploy();

  await nft.mint(seller.address);
  await nft.connect(seller).approve(await house.getAddress(), 1);

  return { nft, house, seller, alice, bob, carol, stranger };
}

async function createAuction(house, nft, seller, overrides = {}) {
  const {
    tokenId = 1,
    reserve = RESERVE,
    commitDuration = COMMIT,
    revealDuration = REVEAL,
  } = overrides;

  await house
    .connect(seller)
    .createAuction(await nft.getAddress(), tokenId, reserve, commitDuration, revealDuration);

  return await house.auctionCount();
}

async function commitBid(house, auctionId, bidder, amount, deposit, nonce) {
  const commitment = await house.hashCommitment(auctionId, bidder.address, amount, nonce);
  return house.connect(bidder).commitBid(auctionId, commitment, { value: deposit });
}

async function revealBid(house, auctionId, bidder, amount, nonce) {
  return house.connect(bidder).revealBid(auctionId, amount, nonce);
}

async function expectSolvent(house) {
  const balance = await ethers.provider.getBalance(await house.getAddress());
  expect(balance).to.equal(await house.totalEscrowed());
}

describe("AuctionHouse", function () {
  describe("1. Creating an auction", function () {
    it("escrows the NFT and emits AuctionCreated with both deadlines", async function () {
      const { nft, house, seller } = await loadFixture(deployFixture);

      const tx = await house
        .connect(seller)
        .createAuction(await nft.getAddress(), 1, RESERVE, COMMIT, REVEAL);
      const receipt = await tx.wait();
      const parsed = receipt.logs
        .map((log) => house.interface.parseLog(log))
        .find((event) => event && event.name === "AuctionCreated");

      expect(parsed.name).to.equal("AuctionCreated");
      expect(parsed.args.auctionId).to.equal(1n);
      expect(parsed.args.seller).to.equal(seller.address);
      expect(parsed.args.nft).to.equal(await nft.getAddress());
      expect(parsed.args.tokenId).to.equal(1n);
      expect(parsed.args.reservePrice).to.equal(RESERVE);
      expect(parsed.args.revealDeadline).to.be.greaterThan(parsed.args.commitDeadline);

      expect(await nft.ownerOf(1)).to.equal(await house.getAddress());
      expect(await house.auctionCount()).to.equal(1n);
      expect(await house.phaseOf(1)).to.equal(Bidding);
    });

    it("rejects a caller who does not own the token", async function () {
      const { nft, house, alice } = await loadFixture(deployFixture);

      await expect(
        house.connect(alice).createAuction(await nft.getAddress(), 1, RESERVE, COMMIT, REVEAL)
      ).to.be.revertedWithCustomError(house, "NotTokenOwner");
    });

    it("rejects a zero-length phase", async function () {
      const { nft, house, seller } = await loadFixture(deployFixture);

      await expect(
        house.connect(seller).createAuction(await nft.getAddress(), 1, RESERVE, 0, REVEAL)
      ).to.be.revertedWithCustomError(house, "InvalidDuration");

      await expect(
        house.connect(seller).createAuction(await nft.getAddress(), 1, RESERVE, COMMIT, 0)
      ).to.be.revertedWithCustomError(house, "InvalidDuration");
    });

    it("reverts when the token is not approved", async function () {
      const { nft, house, seller } = await loadFixture(deployFixture);
      await nft.mint(seller.address);

      await expect(
        house.connect(seller).createAuction(await nft.getAddress(), 2, RESERVE, COMMIT, REVEAL)
      ).to.be.reverted;
    });
  });

  describe("2. Commit phase", function () {
    it("stores the commitment and the deposit, and emits only the bidder", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      const commitment = await house.hashCommitment(
        id,
        alice.address,
        ethers.parseEther("2"),
        NONCE.alice
      );

      const receipt = await (
        await house.connect(alice).commitBid(id, commitment, { value: ethers.parseEther("3") })
      ).wait();

      expect(await house.commitments(id, alice.address)).to.equal(commitment);
      expect(await house.deposits(id, alice.address)).to.equal(ethers.parseEther("3"));

      const parsed = house.interface.parseLog(receipt.logs[0]);
      expect(parsed.name).to.equal("BidCommitted");
      expect(parsed.fragment.inputs.map((i) => i.name)).to.deep.equal(["auctionId", "bidder"]);
    });

    it("rejects the seller as a bidder", async function () {
      const { nft, house, seller } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      await expect(
        commitBid(house, id, seller, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice)
      ).to.be.revertedWithCustomError(house, "SellerCannotBid");
    });

    it("rejects a zero deposit and an empty commitment", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      await expect(
        house.connect(alice).commitBid(id, NONCE.alice, { value: 0 })
      ).to.be.revertedWithCustomError(house, "ZeroDeposit");

      await expect(
        house.connect(alice).commitBid(id, ethers.ZeroHash, { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(house, "EmptyCommitment");
    });

    it("allows exactly one commitment per account", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);

      await expect(
        commitBid(house, id, alice, ethers.parseEther("3"), ethers.parseEther("3"), NONCE.bob)
      ).to.be.revertedWithCustomError(house, "AlreadyCommitted");
    });

    it("accepts a commitment at exactly the deadline and rejects one second later", async function () {
      const { nft, house, seller, alice, bob } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      const auction = await house.getAuction(id);

      await time.setNextBlockTimestamp(auction.commitDeadline);
      await expect(
        commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice)
      ).to.emit(house, "BidCommitted");

      await time.increase(1);
      await expect(
        commitBid(house, id, bob, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.bob)
      ).to.be.revertedWithCustomError(house, "CommitPhaseClosed");
    });

    it("moves to Revealing by timestamp alone, without a transaction", async function () {
      const { nft, house, seller } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      expect(await house.phaseOf(id)).to.equal(Bidding);
      await time.increase(COMMIT + 1);
      expect(await house.phaseOf(id)).to.equal(Revealing);
    });

    it("refuses commitments on an unknown auction", async function () {
      const { house, alice } = await loadFixture(deployFixture);

      await expect(
        commitBid(house, 99, alice, ethers.parseEther("1"), ethers.parseEther("1"), NONCE.alice)
      ).to.be.revertedWithCustomError(house, "UnknownAuction");
    });
  });

  describe("3. Reveal phase", function () {
    it("rejects a reveal before the commit deadline", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);

      await expect(
        revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice)
      ).to.be.revertedWithCustomError(house, "RevealPhaseNotOpen");
    });

    it("accepts a correct reveal and rejects a wrong amount or nonce", async function () {
      const { nft, house, seller, alice, bob } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("3"), NONCE.alice);
      await commitBid(house, id, bob, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.bob);

      await time.increase(COMMIT + 1);

      await expect(
        revealBid(house, id, alice, ethers.parseEther("2.5"), NONCE.alice)
      ).to.be.revertedWithCustomError(house, "BadCommitment");

      await expect(
        revealBid(house, id, bob, ethers.parseEther("2"), NONCE.alice)
      ).to.be.revertedWithCustomError(house, "BadCommitment");

      await expect(revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice))
        .to.emit(house, "BidRevealed")
        .withArgs(id, alice.address, ethers.parseEther("2"));

      expect(await house.revealed(id, alice.address)).to.be.true;
    });

    it("rejects a commitment copied from another bidder", async function () {
      const { nft, house, seller, alice, bob } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);
      const copied = await house.commitments(id, alice.address);
      await house.connect(bob).commitBid(id, copied, { value: ethers.parseEther("2") });

      await time.increase(COMMIT + 1);

      await expect(
        revealBid(house, id, bob, ethers.parseEther("2"), NONCE.alice)
      ).to.be.revertedWithCustomError(house, "BadCommitment");
    });

    it("rejects a reveal above the deposit", async function () {
      const { nft, house, seller, bob } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      // Committing does not compare the deposit with the hidden amount, so a bidder
      // can promise more than it escrowed; the reveal is where that must fail.
      await commitBid(house, id, bob, ethers.parseEther("3"), ethers.parseEther("1"), NONCE.bob);
      await time.increase(COMMIT + 1);

      await expect(
        revealBid(house, id, bob, ethers.parseEther("3"), NONCE.bob)
      ).to.be.revertedWithCustomError(house, "BidAboveDeposit");
    });

    it("rejects a zero bid and a second reveal", async function () {
      const { nft, house, seller, alice, carol } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);
      await commitBid(house, id, carol, 0, ethers.parseEther("1"), NONCE.carol);

      await time.increase(COMMIT + 1);
      await revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice);

      await expect(
        revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice)
      ).to.be.revertedWithCustomError(house, "AlreadyRevealed");

      await expect(revealBid(house, id, carol, 0, NONCE.carol)).to.be.revertedWithCustomError(
        house,
        "ZeroBid"
      );
    });

    it("accepts a reveal at exactly the reveal deadline and rejects the next second", async function () {
      const { nft, house, seller, alice, bob } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);
      await commitBid(house, id, bob, ethers.parseEther("1"), ethers.parseEther("1"), NONCE.bob);

      const auction = await house.getAuction(id);
      await time.setNextBlockTimestamp(auction.revealDeadline);

      await expect(
        revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice)
      ).to.emit(house, "BidRevealed");

      await time.increase(1);
      await expect(
        revealBid(house, id, bob, ethers.parseEther("1"), NONCE.bob)
      ).to.be.revertedWithCustomError(house, "RevealPhaseClosed");
    });

    it("records a below-reserve reveal without letting it win", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller, { reserve: ethers.parseEther("5") });
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);

      await time.increase(COMMIT + 1);
      await expect(revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice))
        .to.emit(house, "BidRevealed")
        .withArgs(id, alice.address, ethers.parseEther("2"));

      const auction = await house.getAuction(id);
      expect(auction.highestBidder).to.equal(ethers.ZeroAddress);
      expect(auction.highestBid).to.equal(0n);
    });
  });

  describe("4. Settling", function () {
    async function threeBidderAuction() {
      const base = await loadFixture(deployFixture);
      const id = await createAuction(base.house, base.nft, base.seller);

      await commitBid(base.house, id, base.alice, ethers.parseEther("2"), ethers.parseEther("3"), NONCE.alice);
      await commitBid(base.house, id, base.bob, ethers.parseEther("1.5"), ethers.parseEther("2"), NONCE.bob);
      await commitBid(base.house, id, base.carol, ethers.parseEther("1"), ethers.parseEther("1"), NONCE.carol);

      await time.increase(COMMIT + 1);

      await revealBid(base.house, id, base.alice, ethers.parseEther("2"), NONCE.alice);
      await revealBid(base.house, id, base.bob, ethers.parseEther("1.5"), NONCE.bob);
      await revealBid(base.house, id, base.carol, ethers.parseEther("1"), NONCE.carol);

      await time.increase(REVEAL + 1);
      return { ...base, id };
    }

    it("rejects settlement before the reveal deadline", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);
      await time.increase(COMMIT + 1);

      await expect(house.settle(id)).to.be.revertedWithCustomError(house, "SettlementTooEarly");
    });

    it("rejects settlement when nothing was revealed", async function () {
      const { nft, house, seller } = await loadFixture(deployFixture);
      await nft.mint(seller.address);
      await nft.connect(seller).approve(await house.getAddress(), 2);
      const id = await createAuction(house, nft, seller, { tokenId: 2 });

      await time.increase(COMMIT + REVEAL + 2);
      await expect(house.settle(id)).to.be.revertedWithCustomError(house, "NoWinner");
    });

    it("transfers the token to the highest bidder and books the price to the seller", async function () {
      const { nft, house, seller, alice, id } = await threeBidderAuction();

      await expect(house.connect(seller).settle(id))
        .to.emit(house, "AuctionSettled")
        .withArgs(id, alice.address, ethers.parseEther("2"));

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await house.deposits(id, seller.address)).to.equal(ethers.parseEther("2"));
      expect((await house.getAuction(id)).state).to.equal(Settled);
      await expectSolvent(house);
    });

    it("is permissionless: a stranger can settle", async function () {
      const { house, stranger, id } = await threeBidderAuction();
      await expect(house.connect(stranger).settle(id)).to.emit(house, "AuctionSettled");
    });

    it("cannot be executed twice", async function () {
      const { house, stranger, id } = await threeBidderAuction();
      await house.connect(stranger).settle(id);
      await expect(house.settle(id)).to.be.revertedWithCustomError(house, "InvalidState");
    });

    it("settles even when the winner is a contract without an ERC-721 receiver hook", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      const attacker = await (
        await ethers.getContractFactory("ReentrantBidder")
      ).deploy(await house.getAddress());

      const commitment = await house.hashCommitment(
        id,
        await attacker.getAddress(),
        ethers.parseEther("2"),
        NONCE.alice
      );
      await attacker.connect(alice).commit(id, commitment, { value: ethers.parseEther("2") });
      await time.increase(COMMIT + 1);
      await attacker.connect(alice).reveal(id, ethers.parseEther("2"), NONCE.alice);
      await time.increase(REVEAL + 1);

      await expect(house.settle(id)).to.emit(house, "AuctionSettled");
      expect(await nft.ownerOf(1)).to.equal(await attacker.getAddress());
    });
  });

  describe("5. Withdrawals and forfeits", function () {
    async function settledAuction() {
      const base = await loadFixture(deployFixture);
      const id = await createAuction(base.house, base.nft, base.seller);

      await commitBid(base.house, id, base.alice, ethers.parseEther("2"), ethers.parseEther("3"), NONCE.alice);
      await commitBid(base.house, id, base.bob, ethers.parseEther("1"), ethers.parseEther("1"), NONCE.bob);
      await commitBid(base.house, id, base.carol, ethers.parseEther("9"), ethers.parseEther("9"), NONCE.carol);

      await time.increase(COMMIT + 1);
      await revealBid(base.house, id, base.alice, ethers.parseEther("2"), NONCE.alice);
      await revealBid(base.house, id, base.bob, ethers.parseEther("1"), NONCE.bob);
      // carol never reveals: ghost bidder
      await time.increase(REVEAL + 1);
      await base.house.settle(id);
      return { ...base, id };
    }

    it("pays the seller the winning bid, the winner the surplus, the loser the deposit", async function () {
      const { house, seller, alice, bob, id } = await settledAuction();

      await expect(house.connect(seller).withdraw(id))
        .to.emit(house, "CreditWithdrawn")
        .withArgs(id, seller.address, ethers.parseEther("2"));

      await expect(house.connect(alice).withdraw(id))
        .to.emit(house, "CreditWithdrawn")
        .withArgs(id, alice.address, ethers.parseEther("1"));

      await expect(house.connect(bob).withdraw(id))
        .to.emit(house, "CreditWithdrawn")
        .withArgs(id, bob.address, ethers.parseEther("1"));

      await expectSolvent(house);
    });

    it("blocks a double withdrawal", async function () {
      const { house, seller, id } = await settledAuction();
      await house.connect(seller).withdraw(id);
      await expect(house.connect(seller).withdraw(id)).to.be.revertedWithCustomError(
        house,
        "NothingToWithdraw"
      );
    });

    it("refuses a withdrawal by a non-revealer; forfeit moves the deposit to the seller", async function () {
      const { house, seller, carol, stranger, id } = await settledAuction();

      await expect(house.connect(carol).withdraw(id)).to.be.revertedWithCustomError(
        house,
        "NothingToWithdraw"
      );

      await expect(house.connect(stranger).forfeit(id, carol.address))
        .to.emit(house, "ForfeitClaimed")
        .withArgs(id, carol.address, ethers.parseEther("9"));

      await house.connect(seller).withdraw(id);
      expect(await house.deposits(id, seller.address)).to.equal(0n);
      await expectSolvent(house);
    });

    it("refuses to forfeit a bidder who revealed", async function () {
      const { house, bob, id } = await settledAuction();
      await expect(house.forfeit(id, bob.address)).to.be.revertedWithCustomError(
        house,
        "NothingToWithdraw"
      );
    });

    it("refuses withdrawals before the auction is final", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);

      await expect(house.connect(alice).withdraw(id)).to.be.revertedWithCustomError(
        house,
        "InvalidState"
      );

      await time.increase(COMMIT + 1);
      await revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice);
      await expect(house.connect(alice).withdraw(id)).to.be.revertedWithCustomError(
        house,
        "InvalidState"
      );
    });

    it("survives a reentrant receiver; the outer withdrawal still succeeds", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      const attacker = await (
        await ethers.getContractFactory("ReentrantBidder")
      ).deploy(await house.getAddress());

      const commitment = await house.hashCommitment(
        id,
        await attacker.getAddress(),
        ethers.parseEther("2"),
        NONCE.alice
      );
      await attacker.connect(alice).commit(id, commitment, { value: ethers.parseEther("3") });
      await time.increase(COMMIT + 1);
      await attacker.connect(alice).reveal(id, ethers.parseEther("2"), NONCE.alice);
      await time.increase(REVEAL + 1);
      await house.settle(id);

      await attacker.connect(alice).withdraw(id);

      expect(await attacker.reentryAttempted()).to.be.true;
      expect(await attacker.reentryReverted()).to.be.true;
      expect(await ethers.provider.getBalance(await attacker.getAddress())).to.equal(
        ethers.parseEther("1")
      );
    });

    it("confines a rejecting receiver's failure to itself", async function () {
      const { nft, house, seller, alice, bob } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      const rejecter = await (
        await ethers.getContractFactory("RejectingBidder")
      ).deploy(await house.getAddress());

      const c1 = await house.hashCommitment(
        id,
        await rejecter.getAddress(),
        ethers.parseEther("1"),
        NONCE.alice
      );
      const c2 = await house.hashCommitment(id, bob.address, ethers.parseEther("2"), NONCE.bob);
      await rejecter.connect(alice).commit(id, c1, { value: ethers.parseEther("1") });
      await house.connect(bob).commitBid(id, c2, { value: ethers.parseEther("3") });

      await time.increase(COMMIT + 1);
      await rejecter.connect(alice).reveal(id, ethers.parseEther("1"), NONCE.alice);
      await revealBid(house, id, bob, ethers.parseEther("2"), NONCE.bob);
      await time.increase(REVEAL + 1);
      await house.settle(id);

      await expect(rejecter.connect(alice).withdraw(id)).to.be.revertedWithCustomError(
        house,
        "EtherTransferFailed"
      );

      await expect(house.connect(bob).withdraw(id)).to.emit(house, "CreditWithdrawn");
      await expectSolvent(house);
    });
  });

  describe("6. Cancellation", function () {
    it("lets the seller delist before the first commitment", async function () {
      const { nft, house, seller } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      await expect(house.connect(seller).cancel(id)).to.emit(house, "AuctionCancelled").withArgs(id);
      expect(await nft.ownerOf(1)).to.equal(seller.address);
      expect((await house.getAuction(id)).state).to.equal(Cancelled);
    });

    it("refuses a delist by a stranger and a delist after a commitment", async function () {
      const { nft, house, seller, alice, stranger } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      await expect(house.connect(stranger).cancel(id)).to.be.revertedWithCustomError(
        house,
        "CannotCancel"
      );

      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);
      await expect(house.connect(seller).cancel(id)).to.be.revertedWithCustomError(
        house,
        "CannotCancel"
      );
    });

    it("returns the token and refunds deposits when nobody bids", async function () {
      const { nft, house, seller, alice, stranger } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);

      await time.increase(COMMIT + REVEAL + 1);

      await expect(house.connect(stranger).cancel(id)).to.emit(house, "AuctionCancelled");
      expect(await nft.ownerOf(1)).to.equal(seller.address);

      await expect(house.connect(alice).withdraw(id))
        .to.emit(house, "CreditWithdrawn")
        .withArgs(id, alice.address, ethers.parseEther("2"));
      await expectSolvent(house);
    });

    it("refuses to cancel a settled auction", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("2"), NONCE.alice);
      await time.increase(COMMIT + 1);
      await revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice);
      await time.increase(REVEAL + 1);
      await house.settle(id);

      await expect(house.connect(seller).cancel(id)).to.be.revertedWithCustomError(
        house,
        "InvalidState"
      );
    });
  });

  describe("7. Invariants and privacy", function () {
    it("keeps balance equal to totalEscrowed through every phase", async function () {
      const { nft, house, seller, alice, bob } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);

      await expectSolvent(house);
      await commitBid(house, id, alice, ethers.parseEther("2"), ethers.parseEther("3"), NONCE.alice);
      await expectSolvent(house);
      await commitBid(house, id, bob, ethers.parseEther("1"), ethers.parseEther("1"), NONCE.bob);
      await expectSolvent(house);

      await time.increase(COMMIT + 1);
      await revealBid(house, id, alice, ethers.parseEther("2"), NONCE.alice);
      await revealBid(house, id, bob, ethers.parseEther("1"), NONCE.bob);
      await time.increase(REVEAL + 1);
      await house.settle(id);
      await expectSolvent(house);

      await house.connect(seller).withdraw(id);
      await house.connect(alice).withdraw(id);
      await house.connect(bob).withdraw(id);
      await expectSolvent(house);
      expect(await ethers.provider.getBalance(await house.getAddress())).to.equal(0n);
    });

    it("leaks no plaintext bid amount during the commit phase", async function () {
      const { nft, house, seller, alice } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      const amount = ethers.parseEther("2.718281828");

      const commitment = await house.hashCommitment(id, alice.address, amount, NONCE.alice);
      const receipt = await (
        await house.connect(alice).commitBid(id, commitment, { value: ethers.parseEther("3") })
      ).wait();

      const needle = ethers.toBeHex(amount, 32).slice(2).toLowerCase();
      for (const log of receipt.logs) {
        for (const topic of log.topics) {
          expect(topic.toLowerCase()).to.not.contain(needle);
        }
        expect(log.data.toLowerCase()).to.not.contain(needle);
      }
    });

    it("binds each commitment to the bidder and the auction", async function () {
      const { nft, house, seller, alice, bob } = await loadFixture(deployFixture);
      const id = await createAuction(house, nft, seller);
      const amount = ethers.parseEther("2");

      const forAlice = await house.hashCommitment(id, alice.address, amount, NONCE.alice);
      const forBob = await house.hashCommitment(id, bob.address, amount, NONCE.alice);
      const forOtherAuction = await house.hashCommitment(id + 1n, alice.address, amount, NONCE.alice);

      expect(forAlice).to.not.equal(forBob);
      expect(forAlice).to.not.equal(forOtherAuction);
    });
  });
});
