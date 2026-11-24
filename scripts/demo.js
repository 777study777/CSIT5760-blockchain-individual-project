// End-to-end demo on the in-process Hardhat chain: one NFT, three bidders, a full
// commit -> reveal -> settle -> withdraw cycle, printed step by step.
//
//   npx hardhat run scripts/demo.js
const hre = require("hardhat");

const DAY = 24 * 60 * 60;
const COMMIT_WINDOW = 3 * DAY;
const REVEAL_WINDOW = 2 * DAY;
const eth = (value) => hre.ethers.parseEther(value);
const toEth = (value) => `${hre.ethers.formatEther(value)} ETH`;

async function main() {
  const { ethers } = hre;
  const [seller, alice, bob, carol] = await ethers.getSigners();

  const nft = await ethers.deployContract("MockNFT");
  const house = await ethers.deployContract("AuctionHouse");
  await nft.waitForDeployment();
  await house.waitForDeployment();
  const houseAddress = await house.getAddress();

  await (await nft.mint(seller.address)).wait();
  await (await nft.connect(seller).approve(houseAddress, 1)).wait();
  console.log(`AuctionHouse ${houseAddress}`);
  console.log(`MockNFT      ${await nft.getAddress()} (token #1 minted to the seller)\n`);

  await (
    await house
      .connect(seller)
      .createAuction(await nft.getAddress(), 1, eth("1"), COMMIT_WINDOW, REVEAL_WINDOW)
  ).wait();
  const id = await house.auctionCount();
  console.log(`auction #${id} opened, reserve 1.0 ETH, commit ${COMMIT_WINDOW / DAY}d + reveal ${REVEAL_WINDOW / DAY}d`);
  console.log(`token owner is now the contract: ${await nft.ownerOf(1)}\n`);

  // Bids stay secret: only the hash and the deposit are public.
  const bids = [
    { who: alice, amount: "2", deposit: "3", nonce: ethers.id("alice nonce") },
    { who: bob, amount: "1.5", deposit: "2", nonce: ethers.id("bob nonce") },
    { who: carol, amount: "1", deposit: "1", nonce: ethers.id("carol nonce") },
  ];

  for (const bid of bids) {
    const commitment = await house.hashCommitment(id, bid.who.address, eth(bid.amount), bid.nonce);
    await (
      await house.connect(bid.who).commitBid(id, commitment, { value: eth(bid.deposit) })
    ).wait();
    console.log(
      `commit  ${bid.who.address.slice(0, 10)}…  deposit ${bid.deposit} ETH  hash ${commitment.slice(0, 14)}…`
    );
  }

  await hre.network.provider.send("evm_increaseTime", [COMMIT_WINDOW + 1]);
  await hre.network.provider.send("evm_mine");
  console.log(`\ncommit window closed, phase = ${await house.phaseOf(id)} (1 = Revealing)`);

  for (const bid of bids) {
    await (await house.connect(bid.who).revealBid(id, eth(bid.amount), bid.nonce)).wait();
    console.log(`reveal  ${bid.who.address.slice(0, 10)}…  bid ${bid.amount} ETH`);
  }

  await hre.network.provider.send("evm_increaseTime", [REVEAL_WINDOW + 1]);
  await hre.network.provider.send("evm_mine");

  await (await house.connect(carol).settle(id)).wait();
  const auction = await house.getAuction(id);
  console.log(`\nsettled by a third party: winner ${auction.highestBidder}, price ${toEth(auction.highestBid)}`);
  console.log(`token owner is now the winner: ${await nft.ownerOf(1)}`);
  console.log(`contract balance ${toEth(await ethers.provider.getBalance(houseAddress))} == totalEscrowed ${toEth(await house.totalEscrowed())}\n`);

  for (const who of [seller, alice, bob, carol]) {
    const owed = await house.deposits(id, who.address);
    if (owed === 0n) continue;
    await (await house.connect(who).withdraw(id)).wait();
    console.log(`withdraw ${who.address.slice(0, 10)}…  ${toEth(owed)}`);
  }

  console.log(`\nfinal contract balance ${toEth(await ethers.provider.getBalance(houseAddress))}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
