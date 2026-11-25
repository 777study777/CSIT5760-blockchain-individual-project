// Deploys MockNFT (the demo asset) and AuctionHouse, then writes the deployment
// record required by the project guideline (network, addresses, tx hashes, block
// numbers, compiler settings, tool version, timestamp).
//
//   npx hardhat run scripts/deploy.js                  # in-process Hardhat chain
//   npx hardhat run scripts/deploy.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const hre = require("hardhat");

const OUT_DIR = path.join(__dirname, "..", "deployments");

// The submission has to prove that the deployed bytecode matches the submitted source.
function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function describe(name, contract) {
  const receipt = await contract.deploymentTransaction().wait();
  return {
    name,
    address: await contract.getAddress(),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
  };
}

async function main() {
  const { ethers, network, config } = hre;
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`network  : ${network.name} (chain id ${chainId})`);
  console.log(`deployer : ${deployer.address}`);
  console.log(`balance  : ${ethers.formatEther(balance)} ETH`);
  console.log("");

  const nft = await ethers.deployContract("MockNFT");
  await nft.waitForDeployment();
  const nftRecord = await describe("MockNFT", nft);

  const house = await ethers.deployContract("AuctionHouse");
  await house.waitForDeployment();
  const houseRecord = await describe("AuctionHouse", house);

  for (const record of [nftRecord, houseRecord]) {
    console.log(`${record.name.padEnd(13)} ${record.address}`);
    console.log(`${"".padEnd(13)} tx ${record.transactionHash} (block ${record.blockNumber})`);
  }

  const compiler = config.solidity.compilers[0];
  const deployment = {
    project: "SealedBid",
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    deployer: deployer.address,
    tool: `Hardhat ${require("hardhat/package.json").version}`,
    compiler: {
      version: compiler.version,
      optimizer: compiler.settings.optimizer,
      evmVersion: compiler.settings.evmVersion,
    },
    contracts: [nftRecord, houseRecord],
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `deployment-${network.name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`\nrecord written to ${path.relative(process.cwd(), file)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
