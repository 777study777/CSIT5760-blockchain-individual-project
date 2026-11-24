// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title MockNFT
/// @notice Minimal ERC-721 used by the tests and the Sepolia demo. Not part of the product.
contract MockNFT is ERC721 {
    uint256 private _nextTokenId;

    constructor() ERC721("SealedBid Mock NFT", "SBNFT") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = ++_nextTokenId;
        _mint(to, tokenId);
    }
}
