// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AuctionHouse} from "../AuctionHouse.sol";

/// @notice Test double: re-enters withdraw from the ETH receive hook.
/// @dev Has no onERC721Received, which also proves that a winning contract cannot
///      block settlement.
contract ReentrantBidder {
    AuctionHouse public immutable house;
    bool public reentryAttempted;
    bool public reentryReverted;
    uint256 private _auctionId;

    constructor(AuctionHouse house_) {
        house = house_;
    }

    function commit(uint256 auctionId, bytes32 commitment) external payable {
        house.commitBid{value: msg.value}(auctionId, commitment);
    }

    function reveal(uint256 auctionId, uint256 amount, bytes32 nonce) external {
        house.revealBid(auctionId, amount, nonce);
    }

    function withdraw(uint256 auctionId) external {
        _auctionId = auctionId;
        house.withdraw(auctionId);
    }

    receive() external payable {
        if (_auctionId != 0 && !reentryAttempted) {
            reentryAttempted = true;
            try house.withdraw(_auctionId) {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
    }
}

/// @notice Test double: refuses ETH, so its own withdraw must fail without hurting others.
contract RejectingBidder {
    AuctionHouse public immutable house;

    constructor(AuctionHouse house_) {
        house = house_;
    }

    function commit(uint256 auctionId, bytes32 commitment) external payable {
        house.commitBid{value: msg.value}(auctionId, commitment);
    }

    function reveal(uint256 auctionId, uint256 amount, bytes32 nonce) external {
        house.revealBid(auctionId, amount, nonce);
    }

    function withdraw(uint256 auctionId) external {
        house.withdraw(auctionId);
    }

    receive() external payable {
        revert("no ETH");
    }
}
